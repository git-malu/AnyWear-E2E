import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const DEFINITION_ARN = /^arn:aws:ecs:ap-east-1:650880818323:task-definition\/beta-anywear-(task-audit|lifecycle|tester-cleanup):[1-9][0-9]*$/;
const TASK_ARN = /^arn:aws:ecs:ap-east-1:650880818323:task\/beta-anywear\/[a-f0-9]{32}$/;

export function payloadHash(payload) { return createHash('sha256').update(payload).digest('hex'); }

function expectedCommand(operation) {
  if (operation.purpose === 'task-audit') return ['node', 'dist/ops/beta-task-audit.js', operation.request_payload];
  if (operation.purpose === 'tester-cleanup') return ['node', 'dist/ops/beta-tester-cleanup.js', operation.request_payload];
  if (operation.purpose === 'lifecycle' && ['configure-testers', 'close', 'open'].includes(operation.action)) {
    return ['node', 'dist/ops/beta-lifecycle.js', operation.action, ...(operation.action === 'configure-testers' ? [operation.request_payload] : [])];
  }
  throw new Error('Unsupported owned one-shot purpose/action');
}

export async function verifyOneShotTask(io, scope, operation, { requireSuccess = true } = {}) {
  if (!DEFINITION_ARN.test(operation.task_definition_arn ?? '') || !TASK_ARN.test(operation.task_arn ?? '')) {
    throw new Error('One-shot operation lacks exact Beta task/definition ownership metadata');
  }
  const definitionResult = await io.aws(['ecs', 'describe-task-definition', '--task-definition', operation.task_definition_arn, '--include', 'TAGS']);
  const definition = definitionResult.taskDefinition;
  const container = definition?.containerDefinitions?.[0];
  const variables = Object.fromEntries((container?.environment ?? []).map(({ name, value }) => [name, value]));
  const tags = Object.fromEntries((definitionResult.tags ?? []).map(({ key, value }) => [key, value]));
  if (definition?.taskDefinitionArn !== operation.task_definition_arn || definition.containerDefinitions?.length !== 1
    || variables.SERVICE_COMMIT_SHA !== scope.deployment.service.source_commit
    || variables.IMAGE_DIGEST !== scope.deployment.service.image_digest
    || !container.image?.endsWith(`@${scope.deployment.service.image_digest}`)
    || tags['anywear-runtime-run-scope'] !== scope.runScope || variables.STAGE !== 'beta'
    || variables.S3_BUCKET_NAME !== scope.stack.bucket || variables.TASK_TRANSPORT !== 'sqs'
    || variables.AWS_REGION !== 'ap-east-1' || !isDeepStrictEqual(container.command, expectedCommand(operation))
    || payloadHash(operation.request_payload) !== operation.payload_sha256
    || (container.secrets?.length ?? 0) > 0 || Object.keys(variables).some((name) => /DOUBAO|VLM|OPENAI/i.test(name))) {
    throw new Error('One-shot actual task definition/image/source SHA/run tag failed validation');
  }
  const described = await io.aws(['ecs', 'describe-tasks', '--cluster', scope.stack.cluster, '--tasks', operation.task_arn]);
  const task = described.tasks?.[0];
  if (described.failures?.length || described.tasks?.length !== 1 || task.taskArn !== operation.task_arn
    || task.taskDefinitionArn !== operation.task_definition_arn || task.lastStatus !== 'STOPPED'
    || task.containers?.length !== 1 || task.containers[0].name !== 'OneShot'
    || (requireSuccess && task.containers[0].exitCode !== 0)
    || task.containers[0].imageDigest !== scope.deployment.service.image_digest) {
    throw new Error('Exact one-shot task image/revision/exit verification failed');
  }
  operation.completed = task.containers[0].exitCode === 0;
  return { task, definition };
}

export async function recoverOneShotRegistrations(io, scope) {
  for (const operation of scope.oneShots ?? []) {
    if (operation.deregistered) continue;
    if (operation.task_definition_arn && operation.task_arn) continue;
    const listed = await io.aws(['ecs', 'list-task-definitions', '--family-prefix', `beta-anywear-${operation.purpose}`, '--status', 'ACTIVE']);
    if (listed.nextToken || listed.taskDefinitionArns?.length > 100) throw new Error('One-shot orphan definition scan incomplete');
    const candidates = [];
    for (const arn of listed.taskDefinitionArns ?? []) {
      const response = await io.aws(['ecs', 'describe-task-definition', '--task-definition', arn, '--include', 'TAGS']);
      if (!response.tags?.some(({ key, value }) => key === 'anywear-runtime-run-scope' && value === scope.runScope)) continue;
      const container = response.taskDefinition?.containerDefinitions?.[0];
      const values = Object.fromEntries((container?.environment ?? []).map(({ name, value }) => [name, value]));
      const args = container?.command ?? [];
      if (values.SERVICE_COMMIT_SHA !== scope.deployment.service.source_commit || values.IMAGE_DIGEST !== scope.deployment.service.image_digest
        || !container?.image.endsWith(`@${scope.deployment.service.image_digest}`)
        || !isDeepStrictEqual(args, expectedCommand(operation))) continue;
      candidates.push(arn);
    }
    if (candidates.length > 1) throw new Error('Ambiguous tagged one-shot registration; recovery refused');
    if (!candidates.length) {
      operation.proven_no_active_definition = true;
      operation.deregistered = true;
      if (io.saveRecovery) await io.saveRecovery(scope);
      continue;
    }
    operation.task_definition_arn = candidates[0];
    const tasks = [];
    for (const status of ['RUNNING', 'STOPPED']) {
      const listedTasks = await io.aws(['ecs', 'list-tasks', '--cluster', scope.stack.cluster,
        '--family', `beta-anywear-${operation.purpose}`, '--desired-status', status]);
      if (listedTasks.nextToken || listedTasks.taskArns?.length > 100) throw new Error('One-shot orphan task scan incomplete');
      if (listedTasks.taskArns?.length) {
        const described = await io.aws(['ecs', 'describe-tasks', '--cluster', scope.stack.cluster, '--tasks', ...listedTasks.taskArns]);
        if (described.failures?.length) throw new Error('One-shot orphan task scan had unresolved tasks');
        tasks.push(...(described.tasks ?? []).filter((task) => task.taskDefinitionArn === operation.task_definition_arn));
      }
    }
    if (tasks.length > 1) throw new Error('One-shot definition was used by multiple tasks; recovery refused');
    if (tasks.length === 1) operation.task_arn = tasks[0].taskArn;
    else {
      await io.aws(['ecs', 'deregister-task-definition', '--task-definition', operation.task_definition_arn]);
      operation.deregistered = true;
      operation.proven_not_started = true;
    }
    if (io.saveRecovery) await io.saveRecovery(scope);
  }
}

export async function runOwnedOneShot(io, scope, purpose, action, payload, runner) {
  scope.oneShots ??= [];
  const operation = { purpose, action, payload_sha256: payloadHash(payload), request_payload: payload,
    started_at: new Date().toISOString(), completed: false, deregistered: false };
  scope.oneShots.push(operation);
  if (purpose === 'lifecycle' && scope.runtimeWindow?.pending_write) scope.runtimeWindow.pending_write.one_shot_index = scope.oneShots.length - 1;
  if (io.saveRecovery) await io.saveRecovery(scope);
  const result = await runner({ scope, purpose, action, payload, onLine: async (line) => {
    for (const [label, key] of [['Task definition', 'task_definition_arn'], ['Task ARN', 'task_arn']]) {
      if (line.startsWith(`${label}: `)) {
        const value = line.slice(label.length + 2);
        if (operation[key] && operation[key] !== value) throw new Error('One-shot metadata changed unexpectedly');
        operation[key] = value;
        if (io.saveRecovery) await io.saveRecovery(scope);
      }
    }
  } });
  await verifyOneShotTask(io, scope, operation);
  if (io.saveRecovery) await io.saveRecovery(scope);
  return { ...result, operation };
}

export async function cleanupOneShotDefinitions(io, scope) {
  await recoverOneShotRegistrations(io, scope);
  for (const operation of scope.oneShots ?? []) {
    if (operation.deregistered) continue;
    if (!operation.task_definition_arn) throw new Error('One-shot registration response missing; tagged orphan recovery is required');
    await verifyOneShotTask(io, scope, operation, { requireSuccess: false });
    await io.aws(['ecs', 'deregister-task-definition', '--task-definition', operation.task_definition_arn]);
    operation.deregistered = true;
    if (io.saveRecovery) await io.saveRecovery(scope);
  }
}
