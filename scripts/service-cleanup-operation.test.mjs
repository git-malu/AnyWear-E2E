import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cleanupExecutionArn, createCleanupOperationEnvelope, deterministicCleanupExecutionName, observeFailedCleanupOperation,
  observeSubmittedCleanupOperation, prepareCleanupRetryIntent, runCleanupOperation, runRecoveryCleanupOperation, submitCleanupRetryIntent } from '../tests/support/service-cleanup-operation.ts';

const scope = `123456789-1-${'a'.repeat(16)}`;
const inputs = { action: 'cleanup', emails: '[]', cleanup_json: JSON.stringify({ runScope: scope,
  users: [{ sub: '10000000-0000-4000-8000-000000000001', email: 'e2e-beta-worker-0-chromium@anywear.local' }] }) };
const environment = { E2E_CLEANUP_SERVICE_SHA: 'a'.repeat(40), E2E_CLEANUP_SERVICE_IMAGE_DIGEST: `sha256:${'b'.repeat(64)}`,
  BETA_CLEANUP_STATE_MACHINE_VERSION_ARN: 'arn:aws:states:ap-east-1:650880818323:stateMachine:beta-anywear-tester-cleanup:7', AWS_REGION: 'ap-east-1' };
const envelope = createCleanupOperationEnvelope(inputs, environment);
const name = deterministicCleanupExecutionName(envelope);
const arn = cleanupExecutionArn(environment.BETA_CLEANUP_STATE_MACHINE_VERSION_ARN, name);
const cluster = 'arn:aws:ecs:ap-east-1:650880818323:cluster/beta-anywear';
const task = kind => `arn:aws:ecs:ap-east-1:650880818323:task/beta-anywear/${(kind === 'verification' ? '1' : '2').repeat(32)}`;
const prefix = kind => kind === 'verification' ? 'beta-anywear-cleanup-verify' : 'beta-anywear-cleanup';
const definition = kind => `arn:aws:ecs:ap-east-1:650880818323:task-definition/${prefix(kind)}:7`;
const hash = text => createHash('sha256').update(text).digest('hex');
const versionArn = version => environment.BETA_CLEANUP_STATE_MACHINE_VERSION_ARN.replace(':7', `:${version}`);

function output(input = envelope) {
  return { schema_version: 1, record_type: 'anywear_beta_cleanup_tasks', operation_mode: input.operation_mode, operation_id: input.operation_id,
    request_sha256: input.request_sha256, run_scope: scope, service_commit_sha: input.service_commit_sha,
    service_image_digest: input.service_image_digest, cluster_arn: cluster, log_group_name: '/anywear/beta/one-shot',
    ...Object.fromEntries(['verification', 'cleanup'].flatMap(kind => Object.entries({ task_arn: task(kind),
      task_definition_arn: definition(kind), task_status: 'STOPPED', exit_code: 0, log_stream_prefix: prefix(kind) }).map(([key, value]) => [`${kind}_${key}`, value]))) };
}
function description(currentName = name, patch = {}, input = envelope, stateMachineVersionArn = environment.BETA_CLEANUP_STATE_MACHINE_VERSION_ARN) {
  return { executionArn: cleanupExecutionArn(stateMachineVersionArn, currentName), name: currentName,
    stateMachineArn: stateMachineVersionArn.replace(/:[1-9][0-9]*$/, ''), stateMachineVersionArn,
    input: JSON.stringify(input), inputDetails: { included: true }, status: 'SUCCEEDED', output: JSON.stringify(output(input)), outputDetails: { included: true },
    startDate: new Date('2026-10-10T00:00:00Z'), stopDate: new Date('2026-10-10T00:00:01Z'), ...patch };
}
function committed(patch = {}, input = envelope) {
  return { schema_version: 1, record_type: 'anywear_beta_cleanup_result', source: 'beta-tester-cleanup', cleanup: 'beta-testers',
    operation_mode: input.operation_mode, ...(input.recovery_attempt ? { recovery_attempt: input.recovery_attempt } : {}), operation_id: input.operation_id, request_sha256: input.request_sha256, run_scope: scope, transaction_committed: true,
    service_commit_sha: input.service_commit_sha, service_image_digest: input.service_image_digest, envelope_sha256: hash(JSON.stringify(input)),
    users: 1, missingUsers: 0, tasks: 0, outbox: 0, idempotency: 0, generations: 0, relations: 0, outfits: 0, items: 0, photos: 0,
    dlq: { deleted: 0, preserved: 0 }, ...patch };
}
function fixture(options = {}) {
  const calls = [];
  let currentName = name;
  let logCount = 0;
  const io = { calls,
    async start(input, executionName) {
      calls.push({ start: executionName, input }); currentName = executionName;
      if (options.startError) throw Object.assign(new Error('simulated'), { name: options.startError });
      return { executionArn: cleanupExecutionArn(environment.BETA_CLEANUP_STATE_MACHINE_VERSION_ARN, executionName) };
    },
    async describe(executionArn) {
      calls.push({ describe: executionArn });
      return description(currentName, options.description?.(currentName) ?? {});
    },
    async aws(args) {
      calls.push({ aws: args });
      if (args[0] === 'stepfunctions') return options.history;
      if (args[0] === 'ecs' && args[1] === 'describe-tasks') {
        const kind = args.at(-1) === task('verification') ? 'verification' : 'cleanup';
        if (options.missing?.includes(kind)) return { failures: [{ arn: task(kind), reason: 'MISSING' }], tasks: [] };
        if (options.missingMalformed?.includes(kind)) return { failures: [{ arn: task(kind), reason: 'MISSING', detail: 'unexpected' }], tasks: [] };
        const value = { taskArn: task(kind), clusterArn: cluster, taskDefinitionArn: definition(kind), lastStatus: 'STOPPED',
          desiredStatus: 'STOPPED', startedBy: 'AWS Step Functions',
          containers: [{ name: 'OneShot', lastStatus: 'STOPPED', exitCode: 0, imageDigest: envelope.service_image_digest }],
          overrides: { containerOverrides: kind === 'verification' ? [] : [{ name: 'OneShot', command: ['node', 'dist/ops/beta-cleanup-operation.js', JSON.stringify(envelope)] }], inferenceAcceleratorOverrides: [] } };
        return { failures: [], tasks: [options.task?.(value, kind, currentName) ?? value] };
      }
      if (args[0] === 'ecs') {
        const kind = args.at(-1) === definition('verification') ? 'verification' : 'cleanup';
        const value = { taskDefinitionArn: definition(kind), cpu: '512', memory: '1024', networkMode: 'awsvpc', requiresCompatibilities: ['FARGATE'], containerDefinitions: [{ name: 'OneShot',
          image: `650880818323.dkr.ecr.ap-east-1.amazonaws.com/anywear@${envelope.service_image_digest}`,
          command: kind === 'verification' ? ['node', 'dist/verify.js'] : ['node', 'dist/ops/beta-cleanup-operation.js'],
          environment: [{ name: 'SERVICE_COMMIT_SHA', value: envelope.service_commit_sha }, { name: 'IMAGE_DIGEST', value: envelope.service_image_digest }],
          logConfiguration: { logDriver: 'awslogs', options: { 'awslogs-group': '/anywear/beta/one-shot', 'awslogs-region': 'ap-east-1', 'awslogs-stream-prefix': prefix(kind) } } }] };
        return { taskDefinition: options.definition?.(value, kind) ?? value };
      }
      logCount += 1;
      const token = args.includes('--next-token') ? args.at(-1) : undefined;
      return options.logs?.(token, logCount, currentName) ?? { events: token ? [] : [{ message: `ANYWEAR_BETA_CLEANUP_RESULT=${JSON.stringify(committed())}` }], nextForwardToken: 'end' };
    },
    async sleep(ms) { calls.push({ sleep: ms }); },
  };
  return io;
}
async function run(options = {}, environmentPatch = {}, before) {
  const directory = await mkdtemp(join(tmpdir(), 'anywear-cleanup-proof-'));
  const evidencePath = join(directory, 'operation.json');
  const io = fixture(options);
  try {
    const extra = await before?.(directory);
    const execution = () => runCleanupOperation(inputs, { ...environment, E2E_SERVICE_CLEANUP_EVIDENCE_PATH: evidencePath, ...environmentPatch, ...extra }, io);
    return await options.verify(execution, io, evidencePath);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('bounded canonical worker envelope and execution identity reject malformed source, scope and foreign versions', () => {
  assert.equal(envelope.operation_id, `beta-tester-cleanup:${scope}`);
  assert.equal(arn, `arn:aws:states:ap-east-1:650880818323:execution:beta-anywear-tester-cleanup:${name}`);
  for (const json of [` ${inputs.cleanup_json}`, inputs.cleanup_json.replace(scope, `${scope}x`), inputs.cleanup_json.replace('"users":', '"runScope":"duplicate","users":')]) {
    assert.throws(() => createCleanupOperationEnvelope({ ...inputs, cleanup_json: json }, environment));
  }
  assert.throws(() => cleanupExecutionArn(environment.BETA_CLEANUP_STATE_MACHINE_VERSION_ARN.replace(':7', ''), name));
  assert.throws(() => createCleanupOperationEnvelope(inputs, { ...environment, E2E_CLEANUP_SERVICE_IMAGE_DIGEST: 'latest' }));
});

test('normal cleanup persists pending evidence and requires actual tasks and unique committed marker', async () => {
  await run({ verify: async (execute, io, path) => {
    const originalStart = io.start;
    io.start = async (...args) => { assert.equal(JSON.parse(await readFile(path, 'utf8')).operation.proof_status, 'pending'); return originalStart(...args); };
    const result = await execute();
    assert.equal(result.operation.proof_status, 'verified');
    assert.equal(result.operation.committed_result.transaction_committed, true);
    assert.equal(result.operation.tasks.length, 2);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), result);
    assert.equal(io.calls.filter(call => call.aws?.[0] === 'ecs').length, 4);
  } });
});

test('explicit recovery attempt has an identity independent of mutable request/source/image/version', () => {
  const recovery = createCleanupOperationEnvelope(inputs, environment, 'recovery', 1);
  const recoveryName = deterministicCleanupExecutionName(recovery);
  assert.equal(recovery.operation_mode, 'recovery');
  assert.equal(recovery.operation_id, `beta-tester-cleanup:recovery:${scope}:a1`);
  assert.notEqual(recoveryName, name);
  assert.match(recoveryName, /^beta-cleanup-recovery-/);
  assert.equal(deterministicCleanupExecutionName({ ...recovery, request_sha256: 'f'.repeat(64), service_commit_sha: 'f'.repeat(40) }), recoveryName);
  for (const attempt of [undefined, 0, 1.5, 1000000]) assert.throws(() => createCleanupOperationEnvelope(inputs, environment, 'recovery', attempt));
  assert.throws(() => createCleanupOperationEnvelope(inputs, environment, 'normal', 1));
  assert.throws(() => createCleanupOperationEnvelope(inputs, { ...environment, E2E_CLEANUP_RETRY_FAILED: 'true' }, 'recovery', 1));
});

for (const startError of ['ExecutionAlreadyExists', 'TimeoutError', 'NetworkingError']) {
  test(`${startError} without execution ARN resumes only exact deterministic existing execution`, async () => {
    await run({ startError, verify: async (execute, io) => {
      assert.equal((await execute()).operation.proof_status, 'verified');
      assert.equal(io.calls.find(call => call.describe).describe, arn);
      assert.equal(io.calls.filter(call => call.start).length, 1);
    } });
  });
}

test('unrelated start failures never permit describe or identity cleanup', async () => {
  await run({ startError: 'AccessDeniedException', verify: async (execute, io, path) => {
    await assert.rejects(execute(), /identities retained/);
    assert.equal(io.calls.some(call => call.describe), false);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).operation.proof_status, 'refused');
  } });
});

test('mismatched execution input, version, name, output and truncation all retain identities', async () => {
  for (const patch of [{ input: '{}' }, { stateMachineVersionArn: environment.BETA_CLEANUP_STATE_MACHINE_VERSION_ARN.replace(':7', ':8') },
    { executionArn: `${arn}x` }, { name: `${name}x` }, { inputDetails: { included: false } }, { outputDetails: { included: false } },
    { output: JSON.stringify({ ...output(), request_sha256: 'f'.repeat(64) }) }]) {
    await run({ description: () => patch, verify: async (execute, io) => {
      await assert.rejects(execute(), /identities retained/);
      assert.equal(io.calls.some(call => call.aws), false);
    } });
  }
});

test('actual nonterminal, failed, foreign image, task definition and command observations refuse proof', async () => {
  for (const transform of [value => ({ ...value, lastStatus: 'RUNNING' }), value => ({ ...value, containers: [{ ...value.containers[0], exitCode: 1 }] }),
    value => ({ ...value, containers: [{ ...value.containers[0], imageDigest: `sha256:${'f'.repeat(64)}` }] }),
    value => ({ ...value, taskDefinitionArn: definition('cleanup').replace(':7', ':8') }),
    value => ({ ...value, overrides: { containerOverrides: [{ name: 'OneShot', command: ['sh', '-c', 'anything'] }] } })]) {
    await run({ task: (value, kind) => kind === 'cleanup' ? transform(value) : value, verify: async execute => { await assert.rejects(execute(), /identities retained/); } });
  }
  await run({ definition: value => ({ ...value, containerDefinitions: [{ ...value.containerDefinitions[0], environment: [] }] }),
    verify: async execute => { await assert.rejects(execute(), /identities retained/); } });
  await run({ task: (value, kind) => kind === 'cleanup' ? { ...value, taskArn: task('verification') } : value,
    verify: async execute => { await assert.rejects(execute(), /identities retained/); } });
});

test('duplicate, truncated, foreign, and unassigned diagnostic message markers fail closed', async () => {
  const record = `ANYWEAR_BETA_CLEANUP_RESULT=${JSON.stringify(committed())}`;
  for (const events of [[{ message: record }, { message: record }], [{ message: 'ANYWEAR_BETA_CLEANUP_RESULT={' }],
    [{ message: `ANYWEAR_BETA_CLEANUP_RESULT=${JSON.stringify(committed({ transaction_committed: false }))}` }],
    [{ message: `ANYWEAR_BETA_CLEANUP_RESULT=${JSON.stringify(committed({ envelope_sha256: 'f'.repeat(64) }))}` }],
    [{ message: `ANYWEAR_BETA_CLEANUP_RESULT=${JSON.stringify(committed({ dlq: { deleted: -1, preserved: 0 } }))}` }],
    [{ message: `ANYWEAR_BETA_CLEANUP_RESULT=${JSON.stringify(committed({ dlq: { deleted: 1, preserved: 0, known_message: { message_id: 'foreign' } } }))}` }]]) {
    await run({ logs: token => ({ events: token ? [] : events, nextForwardToken: 'end' }), verify: async execute => { await assert.rejects(execute(), /identities retained/); } });
  }
});

test('trusted Service may report owned terminal-task DLQ deletions without diagnostic message authority', async () => {
  await run({ logs: token => ({ events: token ? [] : [{ message: `ANYWEAR_BETA_CLEANUP_RESULT=${JSON.stringify(committed({ dlq: { deleted: 2, preserved: 3 } }))}` }], nextForwardToken: 'end' }),
    verify: async execute => { assert.equal((await execute()).operation.committed_result.dlq.deleted, 2); } });
});

test('bounded log visibility waits and pagination limits preserve incomplete proof', async () => {
  await run({ logs: () => ({ events: [], nextForwardToken: 'end' }), verify: async (execute, io) => {
    await assert.rejects(execute(), /identities retained/);
    assert.equal(io.calls.filter(call => call.sleep).length, 14);
  } });
  await run({ logs: (_token, count) => ({ events: [], nextForwardToken: String(count) }), verify: async (execute, io) => {
    await assert.rejects(execute(), /identities retained/);
    assert.equal(io.calls.filter(call => call.aws?.[0] === 'logs').length, 20);
  } });
});

test('failure evidence survives and retry is never automatic', async () => {
  await run({ description: () => ({ status: 'FAILED' }), verify: async (execute, io, path) => {
    await assert.rejects(execute(), /identities retained/);
    const record = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(record.operation.status, 'FAILED');
    assert.equal(record.operation.execution_arn, arn);
    assert.equal(record.operation.refusal_phase, 'retry_eligibility');
    assert.equal(record.operation.refusal_category, 'retry_not_authorized');
    assert.equal(io.calls.filter(call => call.start).length, 1);
  } });
});

test('cleanup refusal diagnostics use only finite phase/category values', async () => {
  const refused = async (options, environmentPatch = {}) => run({ ...options, verify: async (execute, _io, path) => {
    await assert.rejects(execute(), /identities retained/);
    return JSON.parse(await readFile(path, 'utf8')).operation;
  } }, environmentPatch);
  const cases = [
    [{ startError: 'AccessDeniedException' }, {}, 'operation_start', 'operation_start_unavailable'],
    [{ description: () => ({ input: '{}' }) }, {}, 'execution_observation', 'execution_observation_unavailable'],
    [{ description: () => ({ status: 'FAILED' }) }, {}, 'retry_eligibility', 'retry_not_authorized'],
    [{ description: () => ({ status: 'FAILED' }), history: { events: [] } }, { E2E_CLEANUP_RETRY_FAILED: 'true' }, 'retry_proof', 'retry_proof_unavailable'],
    [{ description: () => ({ status: 'RUNNING' }) }, {}, 'execution_observation', 'execution_not_succeeded'],
    [{ description: () => ({ output: '{}' }) }, {}, 'result_proof', 'result_proof_unavailable'],
    [{ task: value => ({ ...value, lastStatus: 'RUNNING' }) }, {}, 'task_proof', 'task_proof_unavailable'],
    [{ logs: token => ({ events: token ? [] : [], nextForwardToken: 'end' }) }, {}, 'completion_proof', 'completion_proof_unavailable'],
  ];
  for (const [options, environmentPatch, phase, category] of cases) {
    const operation = await refused(options, environmentPatch);
    assert.equal(operation.proof_status, 'refused');
    assert.equal(operation.refusal_phase, phase);
    assert.equal(operation.refusal_category, category);
    assert.equal(operation.failure, 'Exact execution/task/committed-result proof unavailable; Cognito identities retained');
  }
});

function history(events = [], envelope = createCleanupOperationEnvelope(inputs, environment)) {
  if (events.length !== 4) {
    return {
      events: [
        { id: 1, type: 'ExecutionStarted', executionStartedEventDetails: { input: JSON.stringify(envelope), inputDetails: { truncated: false } } },
        ...events,
        { id: 19, previousEventId: 18, type: 'ExecutionFailed' },
      ],
    };
  }

  const taskEvent = (id, type, previousEventId, kind, terminal) => {
    const verify = kind === 'verification';
    const taskArn = task(kind);
    const taskSnapshot = {
      TaskArn: taskArn,
      ClusterArn: cluster,
      TaskDefinitionArn: definition(kind),
      LastStatus: 'STOPPED',
      DesiredStatus: 'STOPPED',
      StartedBy: 'AWS Step Functions',
      Containers: [{
        Name: 'OneShot',
        LastStatus: 'STOPPED',
        ExitCode: terminal === 'failed' ? 1 : 0,
        ImageDigest: envelope.service_image_digest,
      }],
      Overrides: {
        ContainerOverrides: verify ? [] : [{
          Name: 'OneShot',
          Command: ['node', 'dist/ops/beta-cleanup-operation.js', JSON.stringify(envelope)],
        }],
        InferenceAcceleratorOverrides: [],
        TaskRoleArn: '',
        ExecutionRoleArn: '',
        Cpu: '',
        Memory: '',
      },
    };
    if (type === 'TaskStateEntered' || type === 'TaskStateExited') {
      return {
        id,
        previousEventId,
        type,
        taskStateEnteredEventDetails: type === 'TaskStateEntered'
          ? { name: verify ? 'Verify' : 'Cleanup' }
          : undefined,
        taskStateExitedEventDetails: type === 'TaskStateExited' ? {} : undefined,
      };
    }
    if (type === 'TaskScheduled') {
      const parameters = {
        Cluster: cluster,
        TaskDefinition: definition(kind),
        LaunchType: 'FARGATE',
        NetworkConfiguration: {
          AwsvpcConfiguration: {
            Subnets: ['subnet'],
            SecurityGroups: ['sg'],
            AssignPublicIp: 'DISABLED',
          },
        },
        ...(verify ? {} : {
          Overrides: {
            ContainerOverrides: [{
              Name: 'OneShot',
              Command: ['node', 'dist/ops/beta-cleanup-operation.js', JSON.stringify(envelope)],
            }],
          },
        }),
        ClientToken: 'a'.repeat(64),
      };
      return {
        id,
        previousEventId,
        type,
        taskScheduledEventDetails: {
          resourceType: 'ecs',
          resource: 'runTask.sync',
          region: 'ap-east-1',
          parameters: JSON.stringify(parameters),
        },
      };
    }
    if (type === 'TaskStarted') {
      return { id, previousEventId, type, taskStartedEventDetails: { resourceType: 'ecs', resource: 'runTask.sync' } };
    }
    if (type === 'TaskSubmitted') {
      return {
        id,
        previousEventId,
        type,
        taskSubmittedEventDetails: {
          resourceType: 'ecs',
          resource: 'runTask.sync',
          output: JSON.stringify({ Failures: [], Tasks: [{ TaskArn: taskArn, ClusterArn: cluster }], SdkHttpMetadata: {}, SdkResponseMetadata: {} }),
          outputDetails: { truncated: false },
        },
      };
    }
    if (type === 'TaskSucceeded') {
      return {
        id,
        previousEventId,
        type,
        taskSucceededEventDetails: { output: JSON.stringify(taskSnapshot), outputDetails: { truncated: false } },
      };
    }
    if (type === 'TaskFailed') {
      return {
        id,
        previousEventId,
        type,
        taskFailedEventDetails: { cause: JSON.stringify(taskSnapshot), causeDetails: { truncated: false } },
      };
    }
    throw new Error(`Unsupported history fixture event ${type}`);
  };

  return {
    events: [
      { id: 1, type: 'ExecutionStarted', executionStartedEventDetails: { input: JSON.stringify(envelope), inputDetails: { truncated: false } } },
      { id: 2, previousEventId: 1, type: 'PassStateEntered' },
      { id: 3, previousEventId: 2, type: 'PassStateExited' },
      { id: 4, previousEventId: 3, type: 'PassStateEntered' },
      { id: 5, previousEventId: 4, type: 'PassStateExited' },
      taskEvent(6, 'TaskStateEntered', 5, 'verification'),
      taskEvent(7, 'TaskScheduled', 6, 'verification'),
      taskEvent(8, 'TaskStarted', 7, 'verification'),
      taskEvent(9, 'TaskSubmitted', 8, 'verification'),
      taskEvent(10, 'TaskSucceeded', 9, 'verification'),
      taskEvent(11, 'TaskStateExited', 10, 'verification'),
      { id: 12, previousEventId: 11, type: 'PassStateEntered' },
      { id: 13, previousEventId: 12, type: 'PassStateExited' },
      taskEvent(14, 'TaskStateEntered', 13, 'cleanup', 'failed'),
      taskEvent(15, 'TaskScheduled', 14, 'cleanup', 'failed'),
      taskEvent(16, 'TaskStarted', 15, 'cleanup', 'failed'),
      taskEvent(17, 'TaskSubmitted', 16, 'cleanup', 'failed'),
      taskEvent(18, 'TaskFailed', 17, 'cleanup', 'failed'),
      { id: 19, previousEventId: 18, type: 'ExecutionFailed' },
    ],
  };
}
const scheduled = { type: 'TaskScheduled', taskScheduledEventDetails: { resourceType: 'ecs', resource: 'runTask.sync' } };
const submitted = { type: 'TaskSubmitted', taskSubmittedEventDetails: { resourceType: 'ecs', resource: 'runTask.sync', output: JSON.stringify({ Failures: [], Tasks: [{ TaskArn: task('verification') }] }), outputDetails: { truncated: false } } };

test('explicit one-time retry requires complete history and actual stopped task proof', async () => {
  await run({ ...retryRefusalOptions(), verify: async (execute, io, path) => {
      const originalStart = io.start;
      const initialLogReads = io.calls.filter(call => call.aws?.[0] === 'logs').length;
      io.start = async (input, executionName) => {
        if (executionName.endsWith('-retry1')) {
          const evidence = JSON.parse(await readFile(path, 'utf8')).operation;
          assert.equal(evidence.preceding_execution.status, 'FAILED');
          assert.equal(evidence.preceding_execution.log_snapshot_sha256.length, 64);
          assert.deepEqual(evidence.preceding_execution.stopped_tasks, [task('verification'), task('cleanup')]);
          assert.equal(io.calls.filter(call => call.aws?.[0] === 'logs').length, initialLogReads + 4);
        }
        return originalStart(input, executionName);
      };
      const result = await execute();
      assert.equal(result.operation.execution_name, `${name.slice(0, 72)}-retry1`);
      assert.deepEqual(result.operation.preceding_execution.stopped_tasks, [task('verification'), task('cleanup')]);
      assert.equal(io.calls.filter(call => call.start).length, 2);
    } }, { E2E_CLEANUP_RETRY_FAILED: 'true' });
});

function retryRefusalOptions(patch = {}) {
  const cleanupSubmitted = { ...submitted, taskSubmittedEventDetails: { ...submitted.taskSubmittedEventDetails,
    output: JSON.stringify({ Failures: [], Tasks: [{ TaskArn: task('cleanup') }] }) } };
  return { description: current => current.endsWith('-retry1') ? {} : { status: 'FAILED' },
    history: history([scheduled, submitted, scheduled, cleanupSubmitted]),
    task: (value, kind, current) => ({ ...value, containers: value.containers.map(container => ({ ...container,
      exitCode: current.endsWith('-retry1') || kind === 'verification' ? 0 : 1 })) }),
    logs: (token, count, current) => ({ events: token ? [] : [{ message: current.endsWith('-retry1')
      ? `ANYWEAR_BETA_CLEANUP_RESULT=${JSON.stringify(committed())}` : 'Beta cleanup operation failed; captured identities retained' }], nextForwardToken: 'end' }),
    ...patch };
}

test('unknown launches, truncated history, active tasks and a second failed execution refuse retry', async () => {
  for (const options of [{ history: history([scheduled]) }, { history: { ...history(), nextToken: 'more' } },
    { history: history([scheduled, { ...submitted, taskSubmittedEventDetails: { ...submitted.taskSubmittedEventDetails, outputDetails: { truncated: true } } }]) },
    { history: history([scheduled, submitted]), task: value => ({ ...value, lastStatus: 'RUNNING' }) },
    { ...retryRefusalOptions(), history: history(), description: () => ({ status: 'FAILED' }) }]) {
    await run({ ...retryRefusalOptions(), ...options,
      verify: async (execute, io) => { await assert.rejects(execute(), /identities retained/); assert.equal(io.calls.filter(call => call.start).length, 1); } }, { E2E_CLEANUP_RETRY_FAILED: 'true' });
  }
});

test('retry is not started unless exact failed tasks and stable complete no-commit logs are proved', async () => {
  const mismatchedInput = history([scheduled, submitted, scheduled,
    { ...submitted, taskSubmittedEventDetails: { ...submitted.taskSubmittedEventDetails,
      output: JSON.stringify({ Failures: [], Tasks: [{ TaskArn: task('cleanup') }] }) } } ]);
  mismatchedInput.events[0].executionStartedEventDetails.input = '{}';
  const cases = [
    { logs: token => ({ events: token ? [] : [{ message: `ANYWEAR_BETA_CLEANUP_RESULT=${JSON.stringify(committed())}` }], nextForwardToken: 'end' }) },
    { logs: (token, count) => ({ events: token ? [] : [{ message: count === 1 ? 'first snapshot' : 'changed snapshot' }], nextForwardToken: 'end' }) },
    { logs: (_token, count) => ({ events: [], nextForwardToken: String(count) }) },
    { history: mismatchedInput },
    { task: (value, kind, current) => kind === 'cleanup' && !current.endsWith('-retry1')
      ? { ...value, taskDefinitionArn: definition('cleanup').replace(':7', ':8') } : value },
  ];
  for (const options of cases) {
    await run({ ...retryRefusalOptions(), ...options, verify: async (execute, io) => {
      await assert.rejects(execute(), /identities retained/);
      assert.equal(io.calls.filter(call => call.start).length, 1);
    } }, { E2E_CLEANUP_RETRY_FAILED: 'true' });
  }
});

test('verification name-only override is allowed while environment overrides remain refused', async () => {
  await run({ task: (value, kind) => kind === 'verification' ? { ...value, overrides: { containerOverrides: [{ name: 'OneShot' }] } } : value,
    verify: async execute => { assert.equal((await execute()).operation.proof_status, 'verified'); } });
  await run({ task: (value, kind) => kind === 'verification' ? { ...value, overrides: { containerOverrides: [{ name: 'OneShot', environment: [] }] } } : value,
    verify: async execute => { await assert.rejects(execute(), /identities retained/); } });
});

test('a pending execution remains bounded and retains recoverable execution identity on timeout', async () => {
  await run({ description: () => ({ status: 'RUNNING' }), verify: async (execute, io, path) => {
    await assert.rejects(execute(), /identities retained/);
    assert.equal(io.calls.filter(call => call.describe).length, 900);
    const record = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(record.operation.status, 'RUNNING');
    assert.equal(record.operation.execution_arn, arn);
  } });
});

test('original operation evidence is consumed and source/version/request drift refuses any start', async () => {
  const original = { schema_version: 3, record_type: 'anywear_e2e_service_cleanup_operation', operation: {
    operation_mode: 'normal', state_machine_version_arn: environment.BETA_CLEANUP_STATE_MACHINE_VERSION_ARN, execution_name: name, execution_arn: arn,
    input_sha256: hash(JSON.stringify(envelope)), input: envelope, status: 'RUNNING' } };
  for (const corrupt of [false, true]) {
    await run({ verify: async (execute, io) => {
      if (corrupt) { await assert.rejects(execute(), /Original cleanup evidence/); assert.equal(io.calls.length, 0); }
      else assert.equal((await execute()).operation.proof_status, 'verified');
    } }, {}, async directory => {
      const path = join(directory, 'original.json');
      await writeFile(path, JSON.stringify(corrupt ? { ...original, operation: { ...original.operation, state_machine_version_arn: original.operation.state_machine_version_arn.replace(':7', ':8') } } : original));
      return { E2E_CLEANUP_ORIGINAL_EVIDENCE_PATH: path };
    });
  }
});

test('required source CI and protected recovery carry explicit attempt and artifact inputs before credentials', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(packageJson.scripts['test:core'].includes('scripts/service-cleanup-operation.test.mjs'));
  const workflow = await readFile(new URL('../.github/workflows/account-recovery.yml', import.meta.url), 'utf8');
  assert.match(workflow, /E2E_CLEANUP_ORIGINAL_EVIDENCE_PATH:.*original_operation_path/);
  assert.match(workflow, /recovery_attempt:/);
  assert.match(workflow, /previous_recovery_run_id:/);
  assert.match(workflow, /E2E_CLEANUP_PREVIOUS_RECOVERY_EVIDENCE_PATH:/);
  assert.ok(workflow.indexOf('--validate-inputs') < workflow.indexOf('Configure Beta AWS credentials'));
  assert.ok(workflow.indexOf('Verify exact original E2E owner and previous recovery artifact') < workflow.indexOf('Configure Beta AWS credentials'));
  assert.match(workflow, /retry_failed_execution:/);
  for (const name of ['integration', 'beta-qualification']) {
    const owner = await readFile(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8');
    assert.match(owner, /worker_slot_offset:/);
    assert.match(owner, /E2E_WORKER_SLOT_OFFSET:.*inputs.worker_slot_offset/);
  }
});

function refusalIo(patch = {}) {
  const cleanupSubmission = { ...submitted, taskSubmittedEventDetails: { ...submitted.taskSubmittedEventDetails,
    output: JSON.stringify({ Failures: [], Tasks: [{ TaskArn: task('cleanup') }] }) } };
  return fixture({ description: () => ({ status: 'FAILED' }), history: history([scheduled, submitted, scheduled, cleanupSubmission]),
    task: (value, kind) => ({ ...value, containers: value.containers.map(container => ({ ...container, exitCode: kind === 'cleanup' ? 1 : 0 })) }),
    logs: token => ({ events: token ? [] : [{ message: 'Beta cleanup operation failed; captured identities retained' }], nextForwardToken: 'end' }), ...patch });
}

test('refusal requires exact failed stopped cleanup, successful verifier, complete stable logs and no committed marker', async () => {
  const proof = await observeFailedCleanupOperation(inputs, environment, refusalIo());
  assert.equal(proof.status, 'FAILED'); assert.equal(proof.committed_marker_observed, false); assert.equal(proof.tasks.length, 2);
  for (const patch of [{ description: () => ({ status: 'TIMED_OUT' }) }, { history: history([scheduled, submitted]) },
    { task: value => ({ ...value, lastStatus: 'RUNNING' }) }, { logs: () => ({ events: [], nextForwardToken: 'end' }) },
    { logs: token => ({ events: token ? [] : [{ message: `ANYWEAR_BETA_CLEANUP_RESULT=${JSON.stringify(committed())}` }], nextForwardToken: 'end' }) },
    { logs: token => ({ events: token ? [] : [{ message: 'prefixed ANYWEAR_BETA_CLEANUP_RESULT={}' }], nextForwardToken: 'end' }) },
    { logs: () => ({ events: Array.from({ length: 1001 }, () => ({ message: 'overflow' })), nextForwardToken: 'end' }) },
    { logs: () => ({ events: [{ message: 'x'.repeat(262145) }], nextForwardToken: 'end' }) },
    { logs: (token, count) => ({ events: token ? [] : [{ message: `unstable-${count}` }], nextForwardToken: 'end' }) }]) {
    await assert.rejects(() => observeFailedCleanupOperation(inputs, environment, refusalIo(patch)));
  }
});

test('exact MISSING task responses may use the committed historical terminal snapshot', async () => {
  const proof = await observeFailedCleanupOperation(inputs, environment, refusalIo({ missing: ['verification', 'cleanup'] }));
  assert.deepEqual(proof.tasks.map(taskProof => taskProof.proof_origin), ['history', 'history']);
  assert.deepEqual(proof.tasks.map(taskProof => taskProof.event_ids), [[6, 7, 8, 9, 10, 11], [14, 15, 16, 17, 18]]);
  const mixed = await observeFailedCleanupOperation(inputs, environment, refusalIo({ missing: ['verification'] }));
  assert.deepEqual(mixed.tasks.map(taskProof => taskProof.proof_origin), ['history', 'live']);
  await assert.rejects(() => observeFailedCleanupOperation(inputs, environment, refusalIo({ missingMalformed: ['cleanup'] })));
  await run({ missing: ['verification'], verify: async execute => { await assert.rejects(execute(), /identities retained/); } });
});

test('historical fallback rejects malformed snapshots, unknown overrides, redrive and byte-drifted schedules', async () => {
  const malformedSnapshot = retryRefusalOptions().history;
  const verifier = malformedSnapshot.events.find(event => event.id === 10);
  const snapshot = JSON.parse(verifier.taskSucceededEventDetails.output);
  delete snapshot.StartedBy;
  verifier.taskSucceededEventDetails.output = JSON.stringify(snapshot);

  const unknownOverride = retryRefusalOptions().history;
  const overrideVerifier = unknownOverride.events.find(event => event.id === 10);
  const overrideSnapshot = JSON.parse(overrideVerifier.taskSucceededEventDetails.output);
  overrideSnapshot.Overrides.UnexpectedOverride = true;
  overrideVerifier.taskSucceededEventDetails.output = JSON.stringify(overrideSnapshot);

  const nonemptyTaskRole = retryRefusalOptions().history;
  const roleVerifier = nonemptyTaskRole.events.find(event => event.id === 10);
  const roleSnapshot = JSON.parse(roleVerifier.taskSucceededEventDetails.output);
  roleSnapshot.Overrides.TaskRoleArn = 'arn:aws:iam::650880818323:role/foreign';
  roleVerifier.taskSucceededEventDetails.output = JSON.stringify(roleSnapshot);

  const nonemptyCpu = retryRefusalOptions().history;
  const cpuVerifier = nonemptyCpu.events.find(event => event.id === 10);
  const cpuSnapshot = JSON.parse(cpuVerifier.taskSucceededEventDetails.output);
  cpuSnapshot.Overrides.Cpu = '512';
  cpuVerifier.taskSucceededEventDetails.output = JSON.stringify(cpuSnapshot);

  const byteDriftedSchedule = retryRefusalOptions().history;
  const cleanupSchedule = byteDriftedSchedule.events.find(event => event.id === 15);
  const parameters = JSON.parse(cleanupSchedule.taskScheduledEventDetails.parameters);
  parameters.Overrides.ContainerOverrides[0].Command[2] = ` ${JSON.stringify(envelope)}`;
  cleanupSchedule.taskScheduledEventDetails.parameters = JSON.stringify(parameters);

  for (const evidence of [
    malformedSnapshot,
    unknownOverride,
    nonemptyTaskRole,
    nonemptyCpu,
    { ...retryRefusalOptions().history, events: [...retryRefusalOptions().history.events, { id: 20, previousEventId: 19, type: 'ExecutionRedriven' }] },
    { ...retryRefusalOptions().history, events: retryRefusalOptions().history.events.map(event => event.id === 2 ? { ...event, id: 3 } : event) },
    byteDriftedSchedule,
  ]) {
    await assert.rejects(() => observeFailedCleanupOperation(inputs, environment,
      refusalIo({ missing: ['verification', 'cleanup'], history: evidence })));
  }
});

test('retry preparation proves actual prior cessation without any start and submission is authenticated once', async () => {
  const original = { schema_version: 3, record_type: 'anywear_e2e_service_cleanup_operation', operation: {
    operation_mode: 'normal', state_machine_version_arn: environment.BETA_CLEANUP_STATE_MACHINE_VERSION_ARN, execution_name: name, execution_arn: arn,
    input_sha256: hash(JSON.stringify(envelope)), input: envelope, status: 'FAILED', proof_status: 'refused' } };
  const io = refusalIo();
  const intent = await prepareCleanupRetryIntent(inputs, original, environment, io);
  assert.equal(io.calls.filter(call => call.start).length, 0);
  assert.equal(intent.operation.status, 'PENDING'); assert.equal(intent.operation.preceding_execution.task_proofs.length, 2);
  assert.match(intent.operation.preceding_execution.log_snapshot_sha256, /^[a-f0-9]{64}$/);
  let starts = 0;
  const submission = await submitCleanupRetryIntent(intent, environment, async (input, executionName) => {
    starts++; assert.deepEqual(input, envelope); assert.equal(executionName, `${name.slice(0, 72)}-retry1`);
    return { executionArn: intent.operation.execution_arn, startDate: new Date('2026-10-10T00:00:02Z') };
  });
  assert.equal(starts, 1); assert.equal(submission.execution_arn, intent.operation.execution_arn);
  await assert.rejects(() => submitCleanupRetryIntent(intent, environment, async () => ({ executionArn: 'foreign', startDate: new Date() })));
  await assert.rejects(() => prepareCleanupRetryIntent(inputs, { ...original, operation: { ...original.operation, proof_status: 'pending' } }, environment, refusalIo()));
  await assert.rejects(() => prepareCleanupRetryIntent(inputs, original, environment, refusalIo({ history: { ...history(), nextToken: 'truncated' } })));
});

test('recovery reads exact original submitted execution/tasks before attempting any replay start', async () => {
  const retryName = `${name.slice(0, 72)}-retry1`;
  const pending = { schema_version: 3, record_type: 'anywear_e2e_service_cleanup_operation', operation: {
    execution_name: retryName, execution_arn: cleanupExecutionArn(environment.BETA_CLEANUP_STATE_MACHINE_VERSION_ARN, retryName),
    input: envelope, started_at: '2026-10-10T00:00:00.000Z' } };
  const io = fixture({ history: { events: history([scheduled, submitted]).events.slice(0, -1) } });
  io.describe = async () => description(retryName, { status: 'RUNNING' });
  const observed = await observeSubmittedCleanupOperation(pending, environment, io);
  assert.deepEqual(observed.task_arns, [task('verification')]); assert.equal(io.calls.filter(call => call.start).length, 0);
  await assert.rejects(() => observeSubmittedCleanupOperation({ ...pending, operation: { ...pending.operation, started_at: 'different' } }, environment, io));
  const unknown = fixture({ history: { ...history(), nextToken: 'more' } }); unknown.describe = io.describe;
  await assert.rejects(() => observeSubmittedCleanupOperation(pending, environment, unknown));
});

function operationEvidence(input, status = 'FAILED', stateMachineVersionArn = environment.BETA_CLEANUP_STATE_MACHINE_VERSION_ARN) {
  const executionName = deterministicCleanupExecutionName(input);
  return { schema_version: 3, record_type: 'anywear_e2e_service_cleanup_operation', operation: {
    ...(input.operation_mode ? { operation_mode: input.operation_mode } : {}),
    ...(input.recovery_attempt ? { recovery_attempt: input.recovery_attempt } : {}),
    input, input_sha256: hash(JSON.stringify(input)), execution_name: executionName,
    execution_arn: cleanupExecutionArn(stateMachineVersionArn, executionName),
    state_machine_version_arn: stateMachineVersionArn, status, proof_status: 'refused',
  } };
}

function statefulRecoveryIo(options = {}) {
  const executions = new Map();
  const calls = [];
  const currentVersionArn = options.currentVersionArn ?? environment.BETA_CLEANUP_STATE_MACHINE_VERSION_ARN;
  const ownerVersionArn = options.ownerVersionArn ?? currentVersionArn;
  const recoveryVersionArn = options.recoveryVersionArn ?? currentVersionArn;
  let currentInput = options.original ?? envelope;
  let currentStatus = 'FAILED';
  const insert = (input, status, stateMachineVersionArn = input.operation_mode === 'recovery' ? recoveryVersionArn : ownerVersionArn) => {
    const executionName = deterministicCleanupExecutionName(input);
    const value = description(executionName, { status, ...(status === 'RUNNING' ? { stopDate: undefined } : {}) }, input, stateMachineVersionArn);
    executions.set(value.executionArn, value);
    return value;
  };
  insert(currentInput, options.ownerStatus ?? 'FAILED');
  for (const [input, status] of options.existing ?? []) insert(input, status);
  const base = fixture({
    task: (value, kind) => ({ ...value, lastStatus: options.activeTask ? 'RUNNING' : 'STOPPED',
      containers: [{ ...value.containers[0], imageDigest: currentInput.service_image_digest, exitCode: kind === 'cleanup' && currentStatus === 'FAILED' ? 1 : 0 }],
      overrides: { containerOverrides: kind === 'verification' ? [] : [{ name: 'OneShot', command: ['node', 'dist/ops/beta-cleanup-operation.js', JSON.stringify(currentInput)] }] } }),
    definition: value => ({ ...value, containerDefinitions: value.containerDefinitions.map(container => ({ ...container,
      image: `650880818323.dkr.ecr.ap-east-1.amazonaws.com/anywear@${currentInput.service_image_digest}`,
      environment: [{ name: 'SERVICE_COMMIT_SHA', value: currentInput.service_commit_sha }, { name: 'IMAGE_DIGEST', value: currentInput.service_image_digest }] })) }),
    logs: token => ({ events: token ? [] : [{ message: `ANYWEAR_BETA_CLEANUP_RESULT=${JSON.stringify(committed({ users: JSON.parse(currentInput.cleanup_request).users.length }, currentInput))}` }], nextForwardToken: 'end' }),
  });
  const io = { calls, executions, insert,
    async start(input, executionName) {
      calls.push({ start: executionName, input });
      const executionArn = cleanupExecutionArn(currentVersionArn, executionName);
      const old = executions.get(executionArn);
      if (old) {
        if (old.status === 'RUNNING' && old.input === JSON.stringify(input)) return { executionArn };
        throw Object.assign(new Error('Execution exists with its original input/status'), { name: 'ExecutionAlreadyExists' });
      }
      insert(input, options.newStatus ?? 'SUCCEEDED', currentVersionArn);
      if (options.lostResponse) throw Object.assign(new Error('Lost response'), { name: 'TimeoutError' });
      return { executionArn };
    },
    async describe(executionArn) {
      calls.push({ describe: executionArn });
      const record = executions.get(executionArn);
      if (!record) throw new Error('Execution unavailable');
      currentInput = JSON.parse(record.input);
      currentStatus = record.status;
      return structuredClone(record);
    },
    async aws(args) {
      calls.push({ aws: args });
      if (args[0] === 'stepfunctions' && args[1] === 'list-executions') {
        const rows = [...executions.values()].map(record => ({ executionArn: record.executionArn, stateMachineArn: record.stateMachineArn, name: record.name, status: record.status }));
        return options.list?.(rows, args, calls) ?? { executions: rows };
      }
      if (args[0] === 'stepfunctions' && args[1] === 'get-execution-history') {
        const record = executions.get(args[args.indexOf('--execution-arn') + 1]);
        currentInput = JSON.parse(record.input); currentStatus = record.status;
        const value = history([{}, {}, {}, {}], currentInput);
        return options.history?.(value, args) ?? value;
      }
      if (args[0] === 'ecs' && args[1] === 'list-tasks') return options.inventory?.(args, calls) ?? { taskArns: [] };
      if (args[0] === 'ecs' && args[1] === 'describe-tasks' && options.expiredHistorical && currentStatus === 'FAILED') {
        return { tasks: [], failures: [{ arn: args[args.indexOf('--tasks') + 1], reason: 'MISSING' }] };
      }
      return base.aws(args);
    },
    async sleep() {
      if (options.completeRunning) for (const record of executions.values()) {
        if (record.status === 'RUNNING') Object.assign(record, { status: 'SUCCEEDED', stopDate: new Date('2026-10-10T00:00:01Z') });
      }
    },
  };
  return io;
}

async function recoveryCase(options, verify) {
  const directory = await mkdtemp(join(tmpdir(), 'anywear-recovery-attempt-'));
  const original = options.original ?? envelope;
  const envBase = { ...environment, ...(options.environmentPatch ?? {}) };
  const originalPath = join(directory, 'original.json');
  const priorPath = join(directory, 'prior.json');
  const path = join(directory, 'operation.json');
  await writeFile(originalPath, JSON.stringify(operationEvidence(original, 'FAILED', options.originalVersionArn ?? envBase.BETA_CLEANUP_STATE_MACHINE_VERSION_ARN)));
  const io = statefulRecoveryIo({ ...options, currentVersionArn: envBase.BETA_CLEANUP_STATE_MACHINE_VERSION_ARN });
  const env = { ...envBase, E2E_CLEANUP_ORIGINAL_EVIDENCE_PATH: originalPath, E2E_SERVICE_CLEANUP_EVIDENCE_PATH: path,
    E2E_CLEANUP_RECOVERY_ATTEMPT: '1' };
  try { await verify({ io, env, path, priorPath, originalPath, run: patch => runRecoveryCleanupOperation(options.inputs ?? inputs, { ...env, ...patch }, io) }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('AWS-like closed execution cannot be revived by same attempt, repair requires explicit next attempt', async () => {
  await recoveryCase({ newStatus: 'FAILED' }, async ({ io, run, path, priorPath }) => {
    await assert.rejects(run(), /identities retained/);
    const prior = JSON.parse(await readFile(path, 'utf8'));
    await writeFile(priorPath, JSON.stringify(prior));
    const priorEnv = { E2E_CLEANUP_PREVIOUS_RECOVERY_EVIDENCE_PATH: priorPath };
    await assert.rejects(run(priorEnv), /identities retained/);
    assert.equal(io.calls.filter(call => call.start).length, 1);
    await assert.rejects(run({ ...priorEnv, E2E_CLEANUP_SERVICE_IMAGE_DIGEST: `sha256:${'c'.repeat(64)}` }), /identities retained/);
    assert.equal(io.calls.filter(call => call.start).length, 1);
    const failed = [...io.executions.values()].find(record => record.name.endsWith('-a1'));
    await assert.rejects(io.start({ ...JSON.parse(failed.input), service_image_digest: `sha256:${'c'.repeat(64)}` }, failed.name), { name: 'ExecutionAlreadyExists' });
    assert.equal(failed.status, 'FAILED');
    const start = io.start;
    io.start = async (input, name) => { const result = await start(input, name); const execution = io.executions.get(result.executionArn); Object.assign(execution, description(name, {}, input)); return result; };
    const result = await run({ ...priorEnv, E2E_CLEANUP_RECOVERY_ATTEMPT: '2', E2E_CLEANUP_SERVICE_IMAGE_DIGEST: `sha256:${'c'.repeat(64)}` });
    assert.equal(result.operation.proof_status, 'verified');
    assert.equal(result.operation.input.recovery_attempt, 2);
    assert.equal(result.operation.recovery_preflight.predecessor_execution_arn, failed.executionArn);
    assert.equal(failed.status, 'FAILED');
    assert.equal(io.executions.size, 3);
  });
});

test('recovery authenticates an old normal owner and starts the current version exactly once', async () => {
  const ownerVersionArn = versionArn(1);
  const currentVersionArn = versionArn(2);
  await recoveryCase({ ownerVersionArn, originalVersionArn: ownerVersionArn, expiredHistorical: true,
    environmentPatch: { BETA_CLEANUP_STATE_MACHINE_VERSION_ARN: currentVersionArn } }, async ({ io, run, path, priorPath }) => {
    const result = await run();
    assert.equal(result.operation.proof_status, 'verified');
    assert.equal(result.operation.recovery_preflight.predecessor_execution_arn, cleanupExecutionArn(ownerVersionArn, name));
    assert.equal(result.operation.input.recovery_attempt, 1);
    assert.equal(io.calls.filter(call => call.start).length, 1);
    const owner = [...io.executions.values()].find(record => record.input === JSON.stringify(envelope));
    const recovery = [...io.executions.values()].find(record => record.name.startsWith('beta-cleanup-recovery-'));
    assert.equal(owner.stateMachineVersionArn, ownerVersionArn);
    assert.equal(recovery.stateMachineVersionArn, currentVersionArn);
    await writeFile(priorPath, JSON.stringify(result));
    const resumed = await run({ E2E_CLEANUP_PREVIOUS_RECOVERY_EVIDENCE_PATH: priorPath });
    assert.equal(resumed.operation.proof_status, 'verified');
    assert.equal(io.calls.filter(call => call.start).length, 1);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), resumed);
  });
});

test('cross-version recovery refuses unsafe execution inventory before StartExecution', async () => {
  const ownerVersionArn = versionArn(1);
  const currentVersionArn = versionArn(2);
  const recovery = createCleanupOperationEnvelope(inputs, environment, 'recovery', 1);
  const cases = [
    { ownerVersionArn, originalVersionArn: ownerVersionArn, ownerStatus: 'RUNNING' },
    { ownerVersionArn, originalVersionArn: ownerVersionArn, ownerStatus: 'UNKNOWN' },
    { ownerVersionArn, originalVersionArn: ownerVersionArn, existing: [[recovery, 'FAILED']], recoveryVersionArn: ownerVersionArn },
    { ownerVersionArn, originalVersionArn: ownerVersionArn, existing: [[recovery, 'FAILED']], recoveryVersionArn: versionArn(3) },
    { ownerVersionArn, originalVersionArn: ownerVersionArn, list: rows => ({ executions: rows.map(row => ({ ...row, executionArn: `${row.executionArn}-foreign` })) }) },
    { ownerVersionArn: currentVersionArn, originalVersionArn: ownerVersionArn },
  ];
  for (const options of cases) await recoveryCase({ ...options, environmentPatch: { BETA_CLEANUP_STATE_MACHINE_VERSION_ARN: currentVersionArn } }, async ({ io, run, path }) => {
    await assert.rejects(run(), /identities retained/);
    assert.equal(io.calls.filter(call => call.start).length, 0);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).operation.refusal_phase, 'recovery_preflight');
  });
});

test('RUNNING and lost-success recovery resume only the original execution without StartExecution', async () => {
  const recovery = createCleanupOperationEnvelope(inputs, environment, 'recovery', 1);
  for (const status of ['RUNNING', 'SUCCEEDED']) {
    await recoveryCase({ existing: [[recovery, status]], completeRunning: true }, async ({ io, run, priorPath }) => {
      await writeFile(priorPath, JSON.stringify(operationEvidence(recovery, status)));
      const result = await run({ E2E_CLEANUP_PREVIOUS_RECOVERY_EVIDENCE_PATH: priorPath });
      assert.equal(result.operation.proof_status, 'verified');
      assert.equal(io.calls.filter(call => call.start).length, 0);
      assert.equal(io.executions.size, 2);
    });
  }
  await recoveryCase({ lostResponse: true }, async ({ io, run }) => {
    assert.equal((await run()).operation.proof_status, 'verified');
    assert.equal(io.calls.filter(call => call.start).length, 1);
    assert.equal(io.executions.size, 2);
  });
});

test('stale artifacts, gaps, unknown status, incomplete pages and active or unstable inventory refuse before start', async () => {
  const first = createCleanupOperationEnvelope(inputs, environment, 'recovery', 1);
  const second = createCleanupOperationEnvelope(inputs, environment, 'recovery', 2);
  const cases = [
    { existing: [[first, 'FAILED'], [second, 'FAILED']], prior: first, attempt: '3' },
    { existing: [[second, 'FAILED']], prior: second, attempt: '3' },
    { existing: [[first, 'FAILED']], prior: first, attempt: '3' },
    { existing: [[first, 'FAILED']], attempt: '2' },
    { list: rows => ({ executions: rows.map(row => ({ ...row, status: 'UNKNOWN' })) }) },
    { list: rows => ({ executions: rows, nextToken: 'repeated' }) },
    { list: rows => ({ executions: rows, nextToken: '' }) },
    { history: value => ({ ...value, events: value.events.filter(event => event.id !== 8) }) },
    { history: value => ({ ...value, nextToken: 'loop' }) },
    { inventory: args => ({ taskArns: args.includes('RUNNING') ? [task('cleanup')] : [] }), activeTask: true },
    { inventory: args => ({ taskArns: args.includes('STOPPED') ? [task('cleanup')] : [] }), expiredHistorical: true },
    { inventory: () => ({ taskArns: [], nextToken: 'loop' }) },
    { inventory: (_args, calls) => ({ taskArns: calls.filter(call => call.aws?.[1] === 'list-tasks').length > 6 ? [task('cleanup')] : [] }) },
  ];
  for (const options of cases) await recoveryCase(options, async ({ io, run, path, priorPath }) => {
    if (options.prior) await writeFile(priorPath, JSON.stringify(operationEvidence(options.prior)));
    await assert.rejects(run({ E2E_CLEANUP_RECOVERY_ATTEMPT: options.attempt ?? '1',
      ...(options.prior ? { E2E_CLEANUP_PREVIOUS_RECOVERY_EVIDENCE_PATH: priorPath } : {}) }), /identities retained/);
    assert.equal(io.calls.filter(call => call.start).length, 0);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).operation.refusal_phase, 'recovery_preflight');
  });
});

test('complete execution and history pagination retain the latest predecessor before explicit next attempt', async () => {
  const first = createCleanupOperationEnvelope(inputs, environment, 'recovery', 1);
  await recoveryCase({ existing: [[first, 'FAILED']],
    list: (rows, args) => args.includes('--next-token') ? { executions: rows.slice(1) } : { executions: rows.slice(0, 1), nextToken: 'remaining' },
    history: (value, args) => args.includes('--next-token') ? { events: value.events.slice(10) } : { events: value.events.slice(0, 10), nextToken: 'remaining' },
  }, async ({ io, run, priorPath }) => {
    await writeFile(priorPath, JSON.stringify(operationEvidence(first)));
    const result = await run({ E2E_CLEANUP_RECOVERY_ATTEMPT: '2', E2E_CLEANUP_PREVIOUS_RECOVERY_EVIDENCE_PATH: priorPath });
    assert.equal(result.operation.proof_status, 'verified');
    assert.equal(result.operation.recovery_preflight.latest_attempt, 1);
    assert.ok(io.calls.some(call => call.aws?.[1] === 'list-executions' && call.aws.includes('--next-token')));
    assert.ok(io.calls.some(call => call.aws?.[1] === 'get-execution-history' && call.aws.includes('--next-token')));
    assert.equal(io.calls.filter(call => call.start).length, 1);
  });
});

test('legacy schema3 missing-mode owner is only a canonical predecessor source', async () => {
  const legacy = Object.fromEntries(Object.entries(envelope).filter(([key]) => key !== 'operation_mode'));
  await recoveryCase({ original: legacy }, async ({ io, run }) => {
    const result = await run();
    assert.equal(result.operation.proof_status, 'verified');
    assert.equal(result.operation.input.cleanup_request, legacy.cleanup_request);
    assert.equal(result.operation.input.operation_mode, 'recovery');
    assert.equal([...io.executions.values()][0].input, JSON.stringify(legacy));
  });
  for (const bad of [{ ...legacy, recovery_attempt: 1 }, { ...legacy, arbitrary: true }]) {
    await recoveryCase({ original: bad }, async ({ io, run }) => {
      await assert.rejects(run(), /identities retained/);
      assert.equal(io.calls.filter(call => call.start).length, 0);
    });
  }
});

test('new recovery attempt uses stable current inventory when legacy or recovery predecessor tasks expired', async () => {
  const captured = { ...inputs, cleanup_json: JSON.stringify({ runScope: scope, users: [2, 3].map(slot => ({
    sub: `10000000-0000-4000-8000-00000000000${slot}`, email: `e2e-beta-worker-${slot}-chromium@anywear.local`,
  })) }) };
  const legacy = Object.fromEntries(Object.entries(createCleanupOperationEnvelope(captured, environment)).filter(([key]) => key !== 'operation_mode'));
  const first = createCleanupOperationEnvelope(captured, environment, 'recovery', 1);
  for (const latest of [legacy, first]) {
    const subsequent = latest.operation_mode === 'recovery';
    await recoveryCase({ inputs: captured, original: legacy, expiredHistorical: true, ...(subsequent ? { existing: [[first, 'FAILED']] } : {}) }, async ({ io, run, priorPath }) => {
      // The AWS-like mock really reports expired historical ECS identities as MISSING.
      assert.deepEqual(await io.aws(['ecs', 'describe-tasks', '--cluster', cluster, '--tasks', task('cleanup')]), {
        tasks: [], failures: [{ arn: task('cleanup'), reason: 'MISSING' }],
      });
      io.calls.length = 0;
      if (subsequent) await writeFile(priorPath, JSON.stringify(operationEvidence(first)));
      const result = await run({ E2E_CLEANUP_RECOVERY_ATTEMPT: subsequent ? '2' : '1',
        ...(subsequent ? { E2E_CLEANUP_PREVIOUS_RECOVERY_EVIDENCE_PATH: priorPath } : {}) });
      const startedAt = io.calls.findIndex(call => call.start);
      const preflight = io.calls.slice(0, startedAt);
      assert.equal(io.calls.filter(call => call.start).length, 1);
      assert.equal(preflight.filter(call => call.aws?.[1] === 'list-tasks').length, 12);
      assert.equal(preflight.filter(call => call.aws?.[1] === 'describe-tasks').length, 0);
      assert.equal(preflight.filter(call => call.aws?.[0] === 'logs').length, 0);
      assert.deepEqual(result.operation.recovery_preflight.cessation.inventory, []);
      assert.deepEqual(result.operation.recovery_preflight.cessation.historical_submitted_task_arns, [task('verification'), task('cleanup')]);
      assert.equal(result.operation.proof_status, 'verified');
      assert.equal(result.operation.input.cleanup_request, legacy.cleanup_request);
      assert.equal(result.operation.input.recovery_attempt, subsequent ? 2 : 1);
    });
  }
});
