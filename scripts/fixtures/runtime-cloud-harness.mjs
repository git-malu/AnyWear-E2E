import { createOwnedRuntimeIo, createRuntimeDrillAdapter } from '../beta-runtime-adapter.mjs';
import { effectiveAdmissionMode } from '../beta-admission-mode.mjs';
import { executeRuntimeDrill } from '../runtime-drill.mjs';
import { expectedCommand } from '../runtime-one-shot.mjs';
import { testerHash } from '../runtime-window-controls.mjs';
import { TERMINAL_STABILITY_MS } from '../runtime-task-audit.mjs';
import { auditFixture, cleanupFixture, fencingCiFixture } from './runtime-evidence.mjs';
import { completeOneShotDefinition, platformOutputs } from './runtime-platform.mjs';

const ECS = 'arn:aws:ecs:ap-east-1:650880818323:';
const SUBJECT = '123e4567-e89b-12d3-a456-426614174000';
const uuid = (number) => `123e4567-e89b-12d3-a456-${String(number).padStart(12, '0')}`;
// The mirror's own bound: every simulated `resume` writes a fresh four-hour window. The
// bound is measured from the wall clock, not the simulated evidence clock, because a
// reader decides admission against its own clock and a fixture window must be live.
const WINDOW_BOUND_MS = 240 * 60_000;
const WINDOW_START_MS = Date.parse('2026-10-05T01:00:00Z');
const liveBound = () => new Date(Date.now() + WINDOW_BOUND_MS).toISOString();
const admissionRecord = (mode, expiresAt) => JSON.stringify(mode === 'closed' ? { mode } : { mode, expires_at: expiresAt });

// Only cloud/process/file boundaries are simulated. Adapter, helper ownership, audit extraction,
// policy write ledger, snapshot serialization, cleanup and recovery run their production code.
export function runtimeCloudHarness({ suspended = false, actions = true, originalUploadLimit, originalUploadResponseLossAt } = {}) {
  const compatibility = { client: { sha: 'a'.repeat(40) }, service: { sha: 'b'.repeat(40) } };
  const deployment = { client: { source_commit: compatibility.client.sha },
    service: { source_commit: compatibility.service.sha, image_digest: `sha256:${'c'.repeat(64)}` } };
  const environment = { E2E_STAGE: 'beta', AWS_ACCOUNT_ID: '650880818323', AWS_REGION: 'ap-east-1',
    E2E_CLIENT_URL: 'https://client.example', E2E_SERVICE_URL: 'https://service.example',
    RUNTIME_DRILL_EXCLUSIVE_WINDOW: 'beta-exclusive-runtime', RUNTIME_DRILL_CONCURRENCY: 'anywear-beta-runtime',
    RUNTIME_DRILL_CONFIRM: 'beta-runtime-drill', RUNTIME_DRILL_ID: 'beta-runtime-cloud-mocked',
    RUNTIME_DRILL_E2E_SHA: 'a'.repeat(40), RUNTIME_DRILL_CLIENT_SHA: compatibility.client.sha,
    RUNTIME_DRILL_SERVICE_SHA: compatibility.service.sha, RUNTIME_DRILL_RUN_SCOPE: '123-1-aaaaaaaaaaaaaaaa',
    RUNTIME_DRILL_PROVIDER_FAILURE_FIXTURE: 'scripts/provider-failure-nonpaid.json', E2E_SERVICE_CHECKOUT: 'unused-mocked-checkout',
    GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_SHA: 'a'.repeat(40),
    GITHUB_ACTIONS: String(actions), GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', RUNTIME_RECOVERY_SOURCE_COMPLETED: 'true' };
  const stack = { cluster: 'beta-anywear', apiService: 'beta-anywear-api', workerService: 'beta-anywear-worker',
    bucket: 'mocked-wardrobe', userPoolId: 'ap-east-1_pool', userPoolClientId: 'mocked-client',
    oneShotExecutionRoleArn: 'arn:aws:iam::650880818323:role/beta-oneshot-execution',
    verificationTaskRoleArn: 'arn:aws:iam::650880818323:role/beta-verification',
    lifecycleTaskRoleArn: 'arn:aws:iam::650880818323:role/beta-lifecycle',
    queues: Object.fromEntries(['vto', 'autoTagging', 'vtoDlq', 'autoTaggingDlq'].map((name) => [name, `https://sqs.example/${name}`])) };
  const policy = { admission_mode: { Value: admissionRecord(suspended ? 'closed' : 'testers', liveBound()), Version: 1 },
    tester_allowlist: { Value: '["baseline@example.com"]', Version: 2 } };
  const baselinePolicy = structuredClone(policy);
  const definitions = new Map();
  const tasks = new Map();
  const services = new Map();
  const logs = new Map();
  const items = new Map();
const reservations = new Map();
  const requests = new Map();
  const writes = [];
  const uploads = [];
  const calls = [];
  const mutations = [];
  const phases = [];
  let phase = 'initial';
  let time = WINDOW_START_MS;
  let taskNumber = 100;
  let definitionNumber = 10;
  let email;
  let userExists = false;
  let userCreatedAt;
  const userAttributes = () => [{ Name: 'sub', Value: SUBJECT }, { Name: 'email', Value: email }, { Name: 'custom:e2e_bootstrap', Value: 'true' }];
  let replaced = false;
  let dlq = false;
  let streamNumber = 0;
  const markMutation = (operation) => mutations.push({ operation, phase, writes: writes.length, uploads: uploads.length });
  const newTask = (definitionArn, name, status = 'RUNNING') => {
    const taskArn = `${ECS}task/beta-anywear/${(++taskNumber).toString(16).padStart(32, '0')}`;
    tasks.set(taskArn, { taskArn, taskDefinitionArn: definitionArn, lastStatus: status,
      containers: [{ name, imageDigest: deployment.service.image_digest, ...(status === 'STOPPED' ? { exitCode: 0 } : {}) }] });
    return taskArn;
  };
  const refreshTasks = (service) => {
    for (const arn of service.taskArns ?? []) tasks.get(arn).lastStatus = 'STOPPED';
    service.taskArns = Array.from({ length: service.desiredCount }, () => newTask(service.taskDefinition,
      service.serviceName === stack.workerService ? 'Worker' : 'Api'));
    service.deployments = [{ taskDefinition: service.taskDefinition, rolloutState: 'COMPLETED' }];
  };
  for (const [name, count] of [[stack.apiService, 2], [stack.workerService, 1]]) {
    const arn = `${ECS}task-definition/${name}:1`;
    const definition = { taskDefinitionArn: arn, family: name, status: 'ACTIVE', networkMode: 'awsvpc',
      taskRoleArn: 'arn:aws:iam::650880818323:role/beta-worker', executionRoleArn: stack.oneShotExecutionRoleArn,
      containerDefinitions: [{ name: name === stack.workerService ? 'Worker' : 'Api',
        image: `650880818323.dkr.ecr.ap-east-1.amazonaws.com/anywear@${deployment.service.image_digest}`,
        environment: Object.entries({ SERVICE_COMMIT_SHA: compatibility.service.sha, IMAGE_DIGEST: deployment.service.image_digest })
          .map(([name, value]) => ({ name, value })),
        secrets: [{ name: 'DOUBAO_VLM_API_KEY', valueFrom: 'arn:aws:ssm:ap-east-1:650880818323:parameter/provider-key' }],
        logConfiguration: { logDriver: 'awslogs', options: { 'awslogs-group': '/anywear/beta/worker' } } }] };
    definitions.set(arn, { taskDefinition: definition, tags: [] });
    const service = { serviceName: name, taskDefinition: arn, desiredCount: count, runningCount: count, pendingCount: 0,
      schedulingStrategy: 'REPLICA', networkConfiguration: { awsvpcConfiguration: { subnets: ['mocked-subnet'], securityGroups: ['mocked-security-group'] } } };
    refreshTasks(service);
    services.set(name, service);
  }
  const workerLog = (item, event, extra = {}) => ({ timestamp: time, logStreamName: `worker/Worker/${item.workerArn.split('/').at(-1)}`,
    message: JSON.stringify({ event, taskId: item.taskId, taskType: 'auto-tagging', resourceId: item.itemId,
      executionToken: item.failure ? 3 : 1, ...extra }) });
  const transport = {
    async writeRecoveryFile(_file, json, options) { writes.push({ json, phase, options, mutationCount: mutations.length }); },
    async uploadRecoveryArtifact(name, files, root, options) {
      if (originalUploadLimit && name.startsWith('beta-runtime-recovery-123-1-')
        && Number(name.split('-').at(-1)) > originalUploadLimit) throw new Error('Mocked original snapshot upload exhausted');
      uploads.push({ name, files, root, options, json: writes.at(-1).json });
      if (name.startsWith('beta-runtime-recovery-123-1-') && Number(name.split('-').at(-1)) === originalUploadResponseLossAt) {
        throw new Error('Mocked durable snapshot upload response lost');
      }
    },
    async sleep(ms) {
      if (ms !== TERMINAL_STABILITY_MS) throw new Error(`Unexpected mocked wait ${ms}ms in ${phase}`);
      time += ms;
    },
    async close() {},
    async cognitoSend(command) {
      const name = command.constructor.name;
      calls.push(name);
      if (name === 'AdminCreateUserCommand') {
        markMutation(name); email = command.input.Username; userExists = true; userCreatedAt = new Date();
        return { User: { Username: SUBJECT, Attributes: userAttributes(), UserCreateDate: userCreatedAt } };
      }
      if (name === 'AdminGetUserCommand') {
        if (!userExists) throw Object.assign(new Error('User not found'), { name: 'UserNotFoundException' });
        return { Username: SUBJECT, UserAttributes: userAttributes(), UserCreateDate: userCreatedAt };
      }
      if (name === 'AdminInitiateAuthCommand') return { AuthenticationResult: { AccessToken: 'mocked-memory-only-token' } };
      if (name === 'AdminDeleteUserCommand') userExists = false;
      markMutation(name);
      return {};
    },
    async fetch(url, options) {
      const pathname = new URL(url).pathname;
      const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
      if (url.startsWith('https://upload.example/')) { markMutation('upload-object'); return response({}); }
      if (pathname === '/users/me') return response({ id: SUBJECT, email });
      if (pathname === '/wardrobe/upload-url') {
        markMutation('upload-url');
        const reservationId = uuid(reservations.size + 1);
        const key = `wearable-items/${SUBJECT}/${reservationId}.png`;
        reservations.set(reservationId, { key, failure: replaced });
        return response({ reservationId, key, expiresAt: new Date(Date.now() + 900_000).toISOString(),
          upload: { url: `https://upload.example/${reservationId}`, fields: { key, 'Content-Type': 'image/png' } } });
      }
      if (pathname === '/wardrobe/upload') {
        markMutation('accepted-upload');
        const { reservationId } = JSON.parse(options.body);
        const reservation = reservations.get(reservationId);
        if (!reservation) return response({ error: 'NOT_FOUND' }, 404);
        // The item is created by the confirmation, and confirming twice replays
        // the same item and task rather than creating a second one.
        if (!items.has(reservationId)) {
          items.set(reservationId, { itemId: reservationId, key: reservation.key, taskId: uuid(items.size + 20),
            failure: reservation.failure, deleted: false, workerArn: services.get(stack.workerService).taskArns[0] });
        }
        const item = items.get(reservationId);
        item.idempotencyKey = options.headers['Idempotency-Key'];
        if (item.failure) dlq = true;
        return response({ itemId: item.itemId, taskId: item.taskId }, 202);
      }
      const match = /^\/wardrobe\/items\/([^/]+)(\/stream)?$/.exec(pathname);
      if (!match) throw new Error(`Unexpected mocked HTTP path: ${pathname}`);
      const item = items.get(match[1]);
      if (options.method === 'DELETE') { markMutation('delete-item'); item.deleted = true; return response({}); }
      if (match[2]) {
        const service = services.get(stack.apiService);
        const arn = service.taskArns[streamNumber++ % 2];
        const id = options.headers['X-Request-ID'];
        requests.set(id, { message: JSON.stringify({ reqId: id }), logStreamName: `api/Api/${arn.split('/').at(-1)}` });
        return new Response(`data: ${JSON.stringify({ tagging_status: 'ready', state_version: 3 })}\n\n`,
          { headers: { 'Content-Type': 'text/event-stream' } });
      }
      return response({ id: item.itemId, taggingStatus: item.failure ? 'failed' : (replaced ? 'ready' : 'processing'),
        taggingStateVersion: replaced ? 3 : 1 });
    },
    async aws(args) {
      calls.push(args);
      const flag = (name) => args[args.indexOf(name) + 1];
      if (args[0] === 'sts') return { Account: '650880818323' };
      if (args[0] === 'cloudformation') return { Stacks: [{ Outputs: Object.entries(platformOutputs(stack))
        .map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue })) }] };
      if (args[0] === 'ssm') return { Parameter: structuredClone(policy[flag('--name').split('/').at(-1)]) };
      if (args[0] === 'application-autoscaling') {
        if (args[1] === 'describe-scalable-targets') return { ScalableTargets: [{ ResourceId: flag('--resource-ids'),
          SuspendedState: { DynamicScalingInSuspended: true, DynamicScalingOutSuspended: true, ScheduledScalingSuspended: true } }] };
        return args[1] === 'describe-scaling-policies' ? { ScalingPolicies: [] } : { ScheduledActions: [] };
      }
      if (args[0] === 'sqs') {
        if (args[1] === 'get-queue-attributes') return { Attributes: { ApproximateNumberOfMessages: dlq && flag('--queue-url') === stack.queues.autoTaggingDlq ? '1' : '0',
          ApproximateNumberOfMessagesNotVisible: '0', ApproximateNumberOfMessagesDelayed: '0' } };
        if (args[1] === 'receive-message') return { Messages: dlq ? [{ MessageId: uuid(50), ReceiptHandle: 'mocked-receipt',
          Body: JSON.stringify({ task_id: [...items.values()].find((item) => item.failure).taskId }) }] : [] };
      }
      if (args[0] === 's3api') {
        if (args[1] === 'delete-object') { markMutation('delete-object'); return {}; }
        if (args[1] === 'head-object') throw new Error('Not Found');
      }
      if (args[0] === 'logs') {
        if (args[1] === 'get-log-events') return { events: (logs.get(flag('--log-stream-name')) ?? []).map((event) => ({ message: JSON.stringify(event) })) };
        const filter = flag('--filter-pattern');
        if (requests.has(filter)) return { events: [requests.get(filter)] };
        const item = [...items.values()].find((entry) => entry.taskId === filter || entry.itemId === filter);
        if (!item) throw new Error('Unexpected mocked log filter');
        return { events: [workerLog(item, 'task_execution_started'),
          ...[1, 2, 3].map((receiveCount) => workerLog(item, 'task_sqs_message_received', { receiveCount })),
          workerLog(item, 'task_processing_failed', { retryable: true }),
          workerLog(item, 'task_db_lease_renewed', { databaseLeaseRenewed: true }),
          workerLog(item, 'task_sqs_visibility_renewed', { sqsVisibilityExtended: true })] };
      }
      if (args[0] === 'ecs') {
        if (args[1] === 'describe-services') return { services: [structuredClone(services.get(flag('--services')))] };
        if (args[1] === 'describe-task-definition') return structuredClone(definitions.get(flag('--task-definition')));
        if (args[1] === 'describe-tasks') return { tasks: args.slice(args.indexOf('--tasks') + 1).map((id) =>
          structuredClone(tasks.get(id) ?? [...tasks.values()].find((task) => task.taskArn.endsWith(`/${id}`)))) };
        if (args[1] === 'list-tasks') {
          if (args.includes('--service-name')) return { taskArns: [...services.get(flag('--service-name')).taskArns] };
          return { taskArns: [...tasks.values()].filter((task) => task.lastStatus === flag('--desired-status')
            && definitions.get(task.taskDefinitionArn).taskDefinition.family === flag('--family')).map((task) => task.taskArn) };
        }
        if (args[1] === 'list-task-definitions') return { taskDefinitionArns: [...definitions].filter(([, value]) =>
          value.taskDefinition.status === 'ACTIVE' && value.taskDefinition.family.startsWith(flag('--family-prefix'))).map(([arn]) => arn) };
        if (args[1] === 'register-task-definition') {
          markMutation('register-fixture');
          const definition = JSON.parse(flag('--cli-input-json'));
          const arn = `${ECS}task-definition/${definition.family}:${++definitionNumber}`;
          definitions.set(arn, { taskDefinition: { ...definition, taskDefinitionArn: arn, status: 'ACTIVE' },
            tags: [{ key: 'anywear-runtime-run-scope', value: environment.RUNTIME_DRILL_RUN_SCOPE }] });
          return structuredClone(definitions.get(arn));
        }
        if (args[1] === 'deregister-task-definition') {
          markMutation('deregister-definition'); definitions.get(flag('--task-definition')).taskDefinition.status = 'INACTIVE'; return {};
        }
        if (args[1] === 'update-service') {
          markMutation('update-service');
          const service = services.get(flag('--service'));
          if (args.includes('--task-definition')) service.taskDefinition = flag('--task-definition');
          else replaced = true;
          refreshTasks(service); return {};
        }
        if (args[1] === 'stop-task') {
          markMutation('stop-task'); refreshTasks(services.get(stack.workerService)); return {};
        }
      }
      throw new Error(`Unexpected mocked AWS operation: ${args[0]} ${args[1]}`);
    },
  };
  const runner = async ({ scope, purpose, action, payload, onLine }) => {
    markMutation(`one-shot-${purpose}-${action}`);
    const arn = `${ECS}task-definition/beta-anywear-${purpose}:${++definitionNumber}`;
    const operation = { purpose, action, request_payload: payload };
    definitions.set(arn, { taskDefinition: { taskDefinitionArn: arn, family: `beta-anywear-${purpose}`, status: 'ACTIVE',
      executionRoleArn: stack.oneShotExecutionRoleArn, taskRoleArn: purpose === 'task-audit' ? stack.verificationTaskRoleArn : stack.lifecycleTaskRoleArn,
      containerDefinitions: [{ name: 'OneShot', image: `650880818323.dkr.ecr.ap-east-1.amazonaws.com/anywear@${deployment.service.image_digest}`,
        command: expectedCommand(operation), environment: Object.entries({ SERVICE_COMMIT_SHA: compatibility.service.sha,
          IMAGE_DIGEST: deployment.service.image_digest, STAGE: 'beta', NODE_ENV: 'production', AWS_REGION: 'ap-east-1',
          S3_BUCKET_NAME: stack.bucket, TASK_TRANSPORT: 'sqs' }).map(([name, value]) => ({ name, value })) }] },
    tags: [{ key: 'anywear-runtime-run-scope', value: scope.runScope }] });
    completeOneShotDefinition(definitions.get(arn).taskDefinition, stack);
    await onLine(`Task definition: ${arn}`);
    const taskArn = newTask(arn, 'OneShot', 'STOPPED');
    const stream = `beta-anywear-${purpose}/OneShot/${taskArn.split('/').at(-1)}`;
    const lines = [`Task definition: ${arn}`, `Task ARN: ${taskArn}`, 'Task log group: /anywear/beta/one-shot', `Task log stream: ${stream}`];
    // A launched ECS task completes independently even when the host loses its next metadata upload.
    // A tester write changes the list and nothing else; only `suspend` and `resume`
    // write the mode, one parameter each, exactly as the Service writer does.
    if (purpose === 'lifecycle') {
      if (action === 'set-testers') { policy.tester_allowlist.Value = payload; policy.tester_allowlist.Version++; }
      else {
        policy.admission_mode.Version++;
        policy.admission_mode.Value = admissionRecord(action === 'suspend' ? 'closed' : 'testers', liveBound());
      }
    } else if (purpose === 'task-audit') {
      const request = JSON.parse(payload);
      let event;
      if (request.mode === 'window-preflight') event = { schema_version: 1, source: 'durable-runtime-window-audit', binding: request,
        observed_at: new Date(time).toISOString(), policy: { admission_mode: effectiveAdmissionMode(policy.admission_mode.Value).mode,
          tester_count: JSON.parse(policy.tester_allowlist.Value).length, tester_allowlist_hash: testerHash(JSON.parse(policy.tester_allowlist.Value)),
          updated_at: new Date(time).toISOString() }, current_rows: { active_tasks: 0, unpublished_outbox: 0, manual_intervention_outbox: 0 } };
      else {
        const item = items.get(request.itemId);
        event = auditFixture(request, { status: item.failure ? 'failed' : 'ready', token: item.failure ? 3 : 1 });
        event.observed_at = new Date(time).toISOString();
        delete event.extraction;
      }
      logs.set(stream, [event]);
    } else {
      const evidence = cleanupFixture(scope);
      logs.set(stream, [evidence.committed, ...(evidence.deletion ? [evidence.deletion] : [])]);
      dlq = false;
    }
    for (const line of lines.slice(1)) await onLine(line);
    return { stdout: lines.join('\n') };
  };
  const makeAdapter = (env = environment) => {
    const io = createOwnedRuntimeIo(transport, runner, env);
    const adapter = createRuntimeDrillAdapter(io, env);
    return { io, adapter: Object.fromEntries(Object.entries(adapter).map(([name, operation]) => [name, async (...args) => {
      phase = name;
      const before = writes.length;
      try { return await operation(...args); }
      finally { phases.push({ name, saves: writes.length - before }); }
    }])) };
  };
  const { adapter, io } = makeAdapter();
  return { environment, compatibility, deployment, stack, policy, baselinePolicy, definitions, tasks, logs,
    writes, uploads, calls, mutations, phases, io, adapter, makeAdapter,
    execute: () => executeRuntimeDrill(environment, compatibility, adapter, {
      preflightCollector: async () => ({ admission_mode: 'closed', stack, deployment }),
      fencingReader: async () => fencingCiFixture(compatibility.service.sha),
    }) };
}
