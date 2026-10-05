import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const DEFINITION_ARN = /^arn:aws:ecs:ap-east-1:650880818323:task-definition\/beta-anywear-(task-audit|lifecycle|tester-cleanup):[1-9][0-9]*$/;
const TASK_ARN = /^arn:aws:ecs:ap-east-1:650880818323:task\/beta-anywear\/[a-f0-9]{32}$/;

export function payloadHash(payload) { return createHash('sha256').update(payload).digest('hex'); }

export function expectedCommand(operation) {
  if (operation.purpose === 'task-audit') return ['node', 'dist/ops/beta-task-audit.js', operation.request_payload];
  if (operation.purpose === 'tester-cleanup') return ['node', 'dist/ops/beta-tester-cleanup.js', operation.request_payload];
  if (operation.purpose === 'lifecycle' && ['configure-testers', 'close', 'open'].includes(operation.action)) {
    return ['node', 'dist/ops/beta-lifecycle.js', operation.action, ...(operation.action === 'configure-testers' ? [operation.request_payload] : [])];
  }
  throw new Error('Unsupported owned one-shot purpose/action');
}

export function validateOperationBinding(scope, operation) {
  if (operation.run_scope !== scope.runScope || typeof operation.request_payload !== 'string'
    || payloadHash(operation.request_payload) !== operation.payload_sha256) throw new Error('Foreign run or changed one-shot payload');
  expectedCommand(operation);
  if (operation.purpose === 'lifecycle') {
    if (operation.action === 'configure-testers') {
      const emails = JSON.parse(operation.request_payload);
      if (!Array.isArray(emails) || emails.length > 50 || emails.some((email) => typeof email !== 'string')) throw new Error('Invalid lifecycle tester payload');
    } else if (operation.request_payload !== '') throw new Error('Unexpected lifecycle payload');
    return;
  }
  const request = JSON.parse(operation.request_payload);
  const owner = { sub: scope.subject, email: scope.email };
  if (request.runScope !== scope.runScope) throw new Error('One-shot request belongs to a foreign run');
  if (operation.purpose === 'task-audit' && request.mode === 'window-preflight') {
    if (!isDeepStrictEqual(request, { runScope: scope.runScope, mode: 'window-preflight' })) throw new Error('Invalid window audit request');
  } else if (operation.purpose === 'task-audit') {
    if (!isDeepStrictEqual(request.user, owner) || Object.keys(request).sort().join(',') !== 'idempotencyKey,itemId,runScope,taskId,user') {
      throw new Error('Task audit request belongs to a foreign user');
    }
  } else if (!isDeepStrictEqual(request.users, [owner])
    || Object.keys(request).some((key) => !['runScope', 'users', 'knownDLQMessageId'].includes(key))
    || (!isDeepStrictEqual(request.knownDLQMessageId, scope.knownDLQMessageId)
      && !(scope.knownDLQDeletionEvidence && request.knownDLQMessageId === undefined))) throw new Error('Cleanup request belongs to a foreign user/message');
}

export function oneShotProof(scope, operation) {
  const id = TASK_ARN.exec(operation.task_arn ?? '')?.[0]?.split('/').at(-1);
  return { run_scope: scope.runScope, purpose: operation.purpose,
    task_arn: operation.task_arn, task_definition_arn: operation.task_definition_arn,
    service_source_commit: scope.deployment.service.source_commit, service_image_digest: scope.deployment.service.image_digest,
    payload_sha256: operation.payload_sha256, command: expectedCommand(operation),
    log_group: '/anywear/beta/one-shot', log_stream: `beta-anywear-${operation.purpose}/OneShot/${id}`, exit_code: operation.exit_code ?? 0 };
}

export function validateOneShotProof(proof, scope, purpose, payload, action = '', { requireSuccess = true } = {}) {
  const operation = { run_scope: scope.runScope, purpose, action, request_payload: payload, payload_sha256: payloadHash(payload),
    task_arn: proof?.task_arn, task_definition_arn: proof?.task_definition_arn, exit_code: proof?.exit_code };
  if (DEFINITION_ARN.exec(operation.task_definition_arn ?? '')?.[1] !== purpose || !TASK_ARN.test(operation.task_arn ?? '')
    || !Number.isInteger(proof?.exit_code) || (requireSuccess && proof.exit_code !== 0)
    || !isDeepStrictEqual(proof, oneShotProof(scope, operation))) throw new Error('One-shot retained evidence failed exact run/family/command/image binding');
  return proof;
}

function validateDefinition(scope, operation, response) {
  validateOperationBinding(scope, operation);
  const definition = response.taskDefinition;
  const container = definition?.containerDefinitions?.[0];
  const variables = Object.fromEntries((container?.environment ?? []).map(({ name, value }) => [name, value]));
  const tags = Object.fromEntries((response.tags ?? []).map(({ key, value }) => [key, value]));
  if (DEFINITION_ARN.exec(operation.task_definition_arn ?? '')?.[1] !== operation.purpose
    || definition?.taskDefinitionArn !== operation.task_definition_arn || definition.family !== `beta-anywear-${operation.purpose}`
    || definition.containerDefinitions?.length !== 1 || container.name !== 'OneShot'
    || !scope.stack.oneShotExecutionRoleArn || !scope.stack.verificationTaskRoleArn || !scope.stack.lifecycleTaskRoleArn
    || definition.executionRoleArn !== scope.stack.oneShotExecutionRoleArn
    || definition.taskRoleArn !== (operation.purpose === 'task-audit' ? scope.stack.verificationTaskRoleArn : scope.stack.lifecycleTaskRoleArn)
    || variables.SERVICE_COMMIT_SHA !== scope.deployment.service.source_commit
    || variables.IMAGE_DIGEST !== scope.deployment.service.image_digest
    || !new RegExp(`^650880818323\\.dkr\\.ecr\\.ap-east-1\\.amazonaws\\.com/[^@:]+@${scope.deployment.service.image_digest}$`).test(container.image ?? '')
    || tags['anywear-runtime-run-scope'] !== scope.runScope || variables.STAGE !== 'beta' || variables.NODE_ENV !== 'production'
    || variables.S3_BUCKET_NAME !== scope.stack.bucket || variables.TASK_TRANSPORT !== 'sqs'
    || variables.AWS_REGION !== 'ap-east-1' || !isDeepStrictEqual(container.command, expectedCommand(operation))
    || (container.entryPoint?.length ?? 0) > 0 || (container.secrets?.length ?? 0) > 0
    || Object.keys(variables).some((name) => /DOUBAO|VLM|OPENAI/i.test(name))) {
    throw new Error('One-shot actual task definition/image/source SHA/run tag failed validation');
  }
  return definition;
}

export async function verifyOneShotTask(io, scope, operation, { requireSuccess = true } = {}) {
  if (!DEFINITION_ARN.test(operation.task_definition_arn ?? '') || !TASK_ARN.test(operation.task_arn ?? '')) {
    throw new Error('One-shot operation lacks exact Beta task/definition ownership metadata');
  }
  const definitionResult = await io.aws(['ecs', 'describe-task-definition', '--task-definition', operation.task_definition_arn, '--include', 'TAGS']);
  const definition = validateDefinition(scope, operation, definitionResult);
  const described = await io.aws(['ecs', 'describe-tasks', '--cluster', scope.stack.cluster, '--tasks', operation.task_arn]);
  const task = described.tasks?.[0];
  if (described.failures?.length || described.tasks?.length !== 1 || task.taskArn !== operation.task_arn
    || task.taskDefinitionArn !== operation.task_definition_arn || task.lastStatus !== 'STOPPED'
    || task.containers?.length !== 1 || task.containers[0].name !== 'OneShot'
    || task.overrides?.taskRoleArn || task.overrides?.executionRoleArn
    || (task.overrides?.containerOverrides ?? []).some((override) => (override.command && !isDeepStrictEqual(override.command, expectedCommand(operation)))
      || override.environment?.length || override.environmentFiles?.length)
    || (requireSuccess && task.containers[0].exitCode !== 0)
    || task.containers[0].imageDigest !== scope.deployment.service.image_digest) {
    throw new Error('Exact one-shot task image/revision/exit verification failed');
  }
  operation.completed = task.containers[0].exitCode === 0;
  if (!Number.isInteger(task.containers[0].exitCode)) throw new Error('Stopped helper lacks exact container exit code');
  operation.exit_code = task.containers[0].exitCode;
  operation.proof = oneShotProof(scope, operation);
  return { task, definition };
}

async function deregisterOwnedDefinition(io, scope, operation) {
  await io.aws(['ecs', 'deregister-task-definition', '--task-definition', operation.task_definition_arn]);
  const response = await io.aws(['ecs', 'describe-task-definition', '--task-definition', operation.task_definition_arn, '--include', 'TAGS']);
  validateDefinition(scope, operation, response);
  if (response.taskDefinition.status !== 'INACTIVE') throw new Error('One-shot deregistration not confirmed INACTIVE');
  operation.deregistered = true;
}

export async function recoverOneShotRegistrations(io, scope) {
  for (const operation of scope.oneShots ?? []) {
    validateOperationBinding(scope, operation);
    if (operation.deregistered && operation.task_definition_arn) {
      const response = await io.aws(['ecs', 'describe-task-definition', '--task-definition', operation.task_definition_arn, '--include', 'TAGS']);
      validateDefinition(scope, operation, response);
      if (response.taskDefinition.status !== 'INACTIVE') throw new Error('Saved deregistration is not confirmed by ECS');
      continue;
    }
    if (operation.task_definition_arn && operation.task_arn) continue;
    if (operation.task_definition_arn) {
      const response = await io.aws(['ecs', 'describe-task-definition', '--task-definition', operation.task_definition_arn, '--include', 'TAGS']);
      validateDefinition(scope, operation, response);
      if (response.taskDefinition.status === 'INACTIVE') {
        operation.deregistered = true;
        if (io.saveRecovery) await io.saveRecovery(scope);
        continue;
      }
    }
    const listed = await io.aws(['ecs', 'list-task-definitions', '--family-prefix', `beta-anywear-${operation.purpose}`, '--status', 'ACTIVE']);
    if (listed.nextToken || listed.taskDefinitionArns?.length > 100) throw new Error('One-shot orphan definition scan incomplete');
    const candidates = [];
    for (const arn of listed.taskDefinitionArns ?? []) {
      if ((scope.oneShots ?? []).some((other) => other !== operation && other.task_definition_arn === arn)) continue;
      if (operation.task_definition_arn && operation.task_definition_arn !== arn) continue;
      const response = await io.aws(['ecs', 'describe-task-definition', '--task-definition', arn, '--include', 'TAGS']);
      if (!response.tags?.some(({ key, value }) => key === 'anywear-runtime-run-scope' && value === scope.runScope)) continue;
      try { validateDefinition(scope, { ...operation, task_definition_arn: arn }, response); }
      catch { continue; }
      candidates.push(arn);
    }
    if (candidates.length > 1) throw new Error('Ambiguous tagged one-shot registration; recovery refused');
    if (!candidates.length) {
      if (operation.task_definition_arn || operation.task_arn) throw new Error('Captured one-shot registration cannot be reconciled by active scan');
      operation.proven_no_active_definition = true;
      operation.deregistered = true;
      if (io.saveRecovery) await io.saveRecovery(scope);
      continue;
    }
    if (operation.task_definition_arn && operation.task_definition_arn !== candidates[0]) throw new Error('Orphan definition differs from captured registration');
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
    if (tasks.length > 1 || (operation.task_arn && tasks[0]?.taskArn !== operation.task_arn)) throw new Error('One-shot definition task ownership is ambiguous; recovery refused');
    if (tasks.length === 1) operation.task_arn = tasks[0].taskArn;
    else {
      await deregisterOwnedDefinition(io, scope, operation);
      operation.proven_not_started = true;
    }
    if (io.saveRecovery) await io.saveRecovery(scope);
  }
}

export async function runOwnedOneShot(io, scope, purpose, action, payload, runner) {
  scope.oneShots ??= [];
  const operation = { run_scope: scope.runScope, purpose, action, payload_sha256: payloadHash(payload), request_payload: payload,
    started_at: new Date().toISOString(), completed: false, deregistered: false };
  validateOperationBinding(scope, operation);
  scope.oneShots.push(operation);
  if (purpose === 'lifecycle' && scope.runtimeWindow?.pending_write) scope.runtimeWindow.pending_write.one_shot_index = scope.oneShots.length - 1;
  if (io.saveRecovery) await io.saveRecovery(scope);
  const result = await runner({ scope, purpose, action, payload, onLine: async (line) => {
    for (const [label, key] of [['Task definition', 'task_definition_arn'], ['Task ARN', 'task_arn']]) {
      if (line.startsWith(`${label}: `)) {
        const value = line.slice(label.length + 2);
        if (operation[key]) throw new Error('Duplicate one-shot metadata line');
        if (key === 'task_arn' ? !TASK_ARN.test(value) : DEFINITION_ARN.exec(value)?.[1] !== purpose) throw new Error('Foreign one-shot metadata');
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
    await deregisterOwnedDefinition(io, scope, operation);
    if (io.saveRecovery) await io.saveRecovery(scope);
  }
}
