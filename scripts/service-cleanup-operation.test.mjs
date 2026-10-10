import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cleanupExecutionArn, createCleanupOperationEnvelope, deterministicCleanupExecutionName, runCleanupOperation } from '../tests/support/service-cleanup-operation.ts';

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

function output() {
  return { schema_version: 1, record_type: 'anywear_beta_cleanup_tasks', operation_id: envelope.operation_id,
    request_sha256: envelope.request_sha256, run_scope: scope, service_commit_sha: environment.E2E_CLEANUP_SERVICE_SHA,
    service_image_digest: environment.E2E_CLEANUP_SERVICE_IMAGE_DIGEST, cluster_arn: cluster, log_group_name: '/anywear/beta/one-shot',
    ...Object.fromEntries(['verification', 'cleanup'].flatMap(kind => Object.entries({ task_arn: task(kind),
      task_definition_arn: definition(kind), task_status: 'STOPPED', exit_code: 0, log_stream_prefix: prefix(kind) }).map(([key, value]) => [`${kind}_${key}`, value]))) };
}
function description(currentName = name, patch = {}) {
  return { executionArn: cleanupExecutionArn(environment.BETA_CLEANUP_STATE_MACHINE_VERSION_ARN, currentName), name: currentName,
    stateMachineArn: environment.BETA_CLEANUP_STATE_MACHINE_VERSION_ARN.replace(/:7$/, ''), stateMachineVersionArn: environment.BETA_CLEANUP_STATE_MACHINE_VERSION_ARN,
    input: JSON.stringify(envelope), inputDetails: { included: true }, status: 'SUCCEEDED', output: JSON.stringify(output()), outputDetails: { included: true },
    startDate: new Date('2026-10-10T00:00:00Z'), stopDate: new Date('2026-10-10T00:00:01Z'), ...patch };
}
function committed(patch = {}) {
  return { schema_version: 1, record_type: 'anywear_beta_cleanup_result', source: 'beta-tester-cleanup', cleanup: 'beta-testers',
    operation_id: envelope.operation_id, request_sha256: envelope.request_sha256, run_scope: scope, transaction_committed: true,
    service_commit_sha: envelope.service_commit_sha, service_image_digest: envelope.service_image_digest, envelope_sha256: hash(JSON.stringify(envelope)),
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
        const value = { taskArn: task(kind), clusterArn: cluster, taskDefinitionArn: definition(kind), lastStatus: 'STOPPED',
          containers: [{ name: 'OneShot', lastStatus: 'STOPPED', exitCode: 0, imageDigest: envelope.service_image_digest }],
          overrides: { containerOverrides: kind === 'verification' ? [] : [{ name: 'OneShot', command: ['node', 'dist/ops/beta-cleanup-operation.js', JSON.stringify(envelope)] }] } };
        return { failures: [], tasks: [options.task?.(value, kind) ?? value] };
      }
      if (args[0] === 'ecs') {
        const kind = args.at(-1) === definition('verification') ? 'verification' : 'cleanup';
        const value = { taskDefinitionArn: definition(kind), containerDefinitions: [{ name: 'OneShot',
          image: `650880818323.dkr.ecr.ap-east-1.amazonaws.com/anywear@${envelope.service_image_digest}`,
          command: kind === 'verification' ? ['node', 'dist/verify.js'] : ['node', 'dist/ops/beta-cleanup-operation.js'],
          environment: [{ name: 'SERVICE_COMMIT_SHA', value: envelope.service_commit_sha }, { name: 'IMAGE_DIGEST', value: envelope.service_image_digest }],
          logConfiguration: { logDriver: 'awslogs', options: { 'awslogs-group': '/anywear/beta/one-shot', 'awslogs-region': 'ap-east-1', 'awslogs-stream-prefix': prefix(kind) } } }] };
        return { taskDefinition: options.definition?.(value, kind) ?? value };
      }
      logCount += 1;
      const token = args.includes('--next-token') ? args.at(-1) : undefined;
      return options.logs?.(token, logCount) ?? { events: token ? [] : [{ message: `ANYWEAR_BETA_CLEANUP_RESULT=${JSON.stringify(committed())}` }], nextForwardToken: 'end' };
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
    assert.equal(io.calls.filter(call => call.start).length, 1);
  } });
});

function history(events = []) {
  return { events: [{ type: 'ExecutionStarted', executionStartedEventDetails: { input: JSON.stringify(envelope), inputDetails: { truncated: false } } }, ...events, { type: 'ExecutionFailed' }] };
}
const scheduled = { type: 'TaskScheduled', taskScheduledEventDetails: { resourceType: 'ecs', resource: 'runTask.sync' } };
const submitted = { type: 'TaskSubmitted', taskSubmittedEventDetails: { resourceType: 'ecs', resource: 'runTask.sync', output: JSON.stringify({ Failures: [], Tasks: [{ TaskArn: task('verification') }] }), outputDetails: { truncated: false } } };

test('explicit one-time retry requires complete history and actual stopped task proof', async () => {
  await run({ description: current => current.endsWith('-retry1') ? {} : { status: 'FAILED' }, history: history([scheduled, submitted]),
    verify: async (execute, io) => {
      const result = await execute();
      assert.equal(result.operation.execution_name, `${name.slice(0, 72)}-retry1`);
      assert.deepEqual(result.operation.preceding_execution.stopped_tasks, [task('verification')]);
      assert.equal(io.calls.filter(call => call.start).length, 2);
    } }, { E2E_CLEANUP_RETRY_FAILED: 'true' });
});

test('unknown launches, truncated history, active tasks and a second failed execution refuse retry', async () => {
  for (const options of [{ history: history([scheduled]) }, { history: { ...history(), nextToken: 'more' } },
    { history: history([scheduled, { ...submitted, taskSubmittedEventDetails: { ...submitted.taskSubmittedEventDetails, outputDetails: { truncated: true } } }]) },
    { history: history([scheduled, submitted]), task: value => ({ ...value, lastStatus: 'RUNNING' }) },
    { history: history(), description: () => ({ status: 'FAILED' }) }]) {
    await run({ description: current => current.endsWith('-retry1') ? {} : { status: 'FAILED' }, ...options,
      verify: async (execute, io) => { await assert.rejects(execute(), /identities retained/); assert.ok(io.calls.filter(call => call.start).length <= 2); } }, { E2E_CLEANUP_RETRY_FAILED: 'true' });
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
    state_machine_version_arn: environment.BETA_CLEANUP_STATE_MACHINE_VERSION_ARN, execution_name: name, execution_arn: arn,
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

test('required source CI and protected recovery carry proof tests, original evidence and bounded retry choice', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(packageJson.scripts['test:core'].includes('scripts/service-cleanup-operation.test.mjs'));
  const workflow = await readFile(new URL('../.github/workflows/account-recovery.yml', import.meta.url), 'utf8');
  assert.match(workflow, /E2E_CLEANUP_ORIGINAL_EVIDENCE_PATH:.*original_operation_path/);
  assert.match(workflow, /retry_failed_execution:/);
  assert.match(workflow, /E2E_CLEANUP_RETRY_FAILED:/);
  for (const name of ['integration', 'beta-qualification']) {
    const owner = await readFile(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8');
    assert.match(owner, /worker_slot_offset:/);
    assert.match(owner, /E2E_WORKER_SLOT_OFFSET:.*inputs.worker_slot_offset/);
  }
});
