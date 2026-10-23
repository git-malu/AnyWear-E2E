import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
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
const name0 = deterministicCleanupExecutionName(envelope, 0);
const name1 = deterministicCleanupExecutionName(envelope, 1);
const arn0 = cleanupExecutionArn(environment.BETA_CLEANUP_STATE_MACHINE_VERSION_ARN, name0);
const arn1 = cleanupExecutionArn(environment.BETA_CLEANUP_STATE_MACHINE_VERSION_ARN, name1);
const cluster = 'arn:aws:ecs:ap-east-1:650880818323:cluster/beta-anywear';
const task = kind => `arn:aws:ecs:ap-east-1:650880818323:task/beta-anywear/${(kind === 'verification' ? '1' : '2').repeat(32)}`;
const prefix = kind => kind === 'verification' ? 'beta-anywear-cleanup-verify' : 'beta-anywear-cleanup';
const definition = kind => `arn:aws:ecs:ap-east-1:650880818323:task-definition/${prefix(kind)}:7`;
const hash = text => createHash('sha256').update(text).digest('hex');

function output(input = envelope) {
  return { schema_version: 1, record_type: 'anywear_beta_cleanup_tasks', operation_mode: input.operation_mode, operation_id: input.operation_id,
    request_sha256: input.request_sha256, run_scope: scope, service_commit_sha: input.service_commit_sha,
    service_image_digest: input.service_image_digest, cluster_arn: cluster, log_group_name: '/anywear/beta/one-shot',
    ...Object.fromEntries(['verification', 'cleanup'].flatMap(kind => Object.entries({ task_arn: task(kind),
      task_definition_arn: definition(kind), task_status: 'STOPPED', exit_code: 0, log_stream_prefix: prefix(kind) }).map(([key, value]) => [`${kind}_${key}`, value]))) };
}
function description(currentName = name0, patch = {}, input = envelope, stateMachineVersionArn = environment.BETA_CLEANUP_STATE_MACHINE_VERSION_ARN) {
  return { executionArn: cleanupExecutionArn(stateMachineVersionArn, currentName), name: currentName,
    stateMachineArn: stateMachineVersionArn.replace(/:[1-9][0-9]*$/, ''), stateMachineVersionArn,
    input: JSON.stringify(input), inputDetails: { included: true }, status: 'SUCCEEDED', output: JSON.stringify(output(input)), outputDetails: { included: true },
    startDate: new Date('2026-10-10T00:00:00Z'), stopDate: new Date('2026-10-10T00:00:01Z'), ...patch };
}
function committed(patch = {}, input = envelope) {
  return { schema_version: 1, record_type: 'anywear_beta_cleanup_result', source: 'beta-tester-cleanup', cleanup: 'beta-testers',
    operation_mode: input.operation_mode, operation_id: input.operation_id, request_sha256: input.request_sha256, run_scope: scope, transaction_committed: true,
    service_commit_sha: input.service_commit_sha, service_image_digest: input.service_image_digest, envelope_sha256: hash(JSON.stringify(input)),
    users: 1, missingUsers: 0, tasks: 0, outbox: 0, idempotency: 0, generations: 0, relations: 0, outfits: 0, items: 0, photos: 0, objects: 0, objectsMissing: 0,
    dlq: { deleted: 0, preserved: 0 }, ...patch };
}

/**
 * A stateful two-generation mock. Generation 0 is absent unless seeded, and a
 * start inserts the generation it names; describe reports the current status of
 * that exact execution under the envelope and version it was seeded with.
 * Nothing here models execution history: the new rule never reads it.
 */
function fixture(options = {}) {
  const calls = [];
  const executions = new Map();
  let logCalls = 0;
  const currentVersionArn = options.currentVersionArn ?? environment.BETA_CLEANUP_STATE_MACHINE_VERSION_ARN;
  const seed = (generation, value) => {
    const record = typeof value === 'string' ? { status: value } : value;
    const executionName = deterministicCleanupExecutionName(record.envelope ?? envelope, generation);
    executions.set(executionName, { status: record.status, patch: record.patch ?? {},
      envelope: record.envelope ?? envelope, versionArn: record.versionArn ?? currentVersionArn });
    return executionName;
  };
  const insert = (executionName, status) => {
    executions.set(executionName, { status, patch: {}, envelope, versionArn: currentVersionArn });
    return executionName;
  };
  for (const [generation, value] of Object.entries(options.existing ?? {})) if (value) seed(Number(generation), value);
  const proofEnvelope = options.proofEnvelope ?? envelope;
  const io = { calls, executions,
    async start(input, executionName) {
      calls.push({ start: executionName, input });
      if (options.startError) {
        if (['ExecutionAlreadyExists', 'TimeoutError', 'RequestTimeout', 'NetworkingError', 'InternalServerError', 'ServiceUnavailable'].includes(options.startError)) {
          insert(executionName, options.newStatus ?? 'SUCCEEDED');
        }
        throw Object.assign(new Error('simulated'), { name: options.startError });
      }
      insert(executionName, options.newStatus ?? 'SUCCEEDED');
      return { executionArn: cleanupExecutionArn(currentVersionArn, executionName) };
    },
    async describe(executionArn) {
      calls.push({ describe: executionArn });
      const executionName = executionArn.split(':').at(-1);
      const record = executions.get(executionName);
      if (!record) throw Object.assign(new Error('Execution does not exist'), { name: 'ExecutionDoesNotExist' });
      const patch = { ...record.patch, ...(options.description?.(record.status, executionName) ?? {}) };
      return description(executionName, { status: record.status, ...patch }, record.envelope, record.versionArn);
    },
    async aws(args) {
      calls.push({ aws: args });
      if (args[0] === 'stepfunctions') throw new Error('The single rule never reads execution history');
      if (args[1] === 'list-tasks') return options.inventory?.(args, calls) ?? { taskArns: [] };
      if (args[1] === 'describe-tasks') {
        const kind = args.at(-1) === task('verification') ? 'verification' : 'cleanup';
        if (options.missing?.includes(kind)) return { failures: [{ arn: task(kind), reason: 'MISSING' }], tasks: [] };
        if (options.missingMalformed?.includes(kind)) return { failures: [{ arn: task(kind), reason: 'MISSING', detail: 'unexpected' }], tasks: [] };
        const value = { taskArn: task(kind), clusterArn: cluster, taskDefinitionArn: definition(kind), lastStatus: 'STOPPED',
          desiredStatus: 'STOPPED', startedBy: 'AWS Step Functions',
          containers: [{ name: 'OneShot', lastStatus: 'STOPPED', exitCode: 0, imageDigest: proofEnvelope.service_image_digest }],
          overrides: { containerOverrides: kind === 'verification' ? [] : [{ name: 'OneShot', command: ['node', 'dist/ops/beta-cleanup-operation.js', JSON.stringify(proofEnvelope)] }], inferenceAcceleratorOverrides: [] } };
        return { failures: [], tasks: [options.task?.(value, kind) ?? value] };
      }
      if (args[1] === 'describe-task-definition') {
        const kind = args.at(-1) === definition('verification') ? 'verification' : 'cleanup';
        const value = { taskDefinitionArn: definition(kind), cpu: '512', memory: '1024', networkMode: 'awsvpc', requiresCompatibilities: ['FARGATE'], containerDefinitions: [{ name: 'OneShot',
          image: `650880818323.dkr.ecr.ap-east-1.amazonaws.com/anywear@${proofEnvelope.service_image_digest}`,
          command: kind === 'verification' ? ['node', 'dist/verify.js'] : ['node', 'dist/ops/beta-cleanup-operation.js'],
          environment: [{ name: 'SERVICE_COMMIT_SHA', value: proofEnvelope.service_commit_sha }, { name: 'IMAGE_DIGEST', value: proofEnvelope.service_image_digest }],
          logConfiguration: { logDriver: 'awslogs', options: { 'awslogs-group': '/anywear/beta/one-shot', 'awslogs-region': 'ap-east-1', 'awslogs-stream-prefix': prefix(kind) } } }] };
        return { taskDefinition: options.definition?.(value, kind) ?? value };
      }
      const token = args.includes('--next-token') ? args.at(-1) : undefined;
      logCalls += 1;
      return options.logs?.(token, logCalls) ?? { events: token ? [] : [{ message: `ANYWEAR_BETA_CLEANUP_RESULT=${JSON.stringify(committed({}, proofEnvelope))}` }], nextForwardToken: 'end' };
    },
    async sleep() {
      calls.push({ sleep: 1 });
      if (options.completeRunning) for (const record of executions.values()) if (record.status === 'RUNNING') record.status = 'SUCCEEDED';
    },
  };
  return io;
}
async function run(options = {}, environmentPatch = {}, before) {
  const directory = await mkdtemp(join(tmpdir(), 'anywear-cleanup-proof-'));
  const evidencePath = join(directory, 'operation.json');
  const effective = { ...environment, ...environmentPatch };
  const io = fixture({ currentVersionArn: effective.BETA_CLEANUP_STATE_MACHINE_VERSION_ARN, ...options });
  try {
    const extra = await before?.(directory);
    const execution = () => runCleanupOperation(inputs, { ...effective, E2E_SERVICE_CLEANUP_EVIDENCE_PATH: evidencePath, ...extra }, io);
    return await options.verify(execution, io, evidencePath);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

function ownerEvidenceFor(input, options = {}) {
  const versionArn = options.versionArn ?? environment.BETA_CLEANUP_STATE_MACHINE_VERSION_ARN;
  const name = deterministicCleanupExecutionName(input, options.generation ?? 0);
  return { schema_version: 3, record_type: 'anywear_e2e_service_cleanup_operation', operation: {
    ...(input.operation_mode ? { operation_mode: input.operation_mode } : {}),
    input, input_sha256: hash(JSON.stringify(input)), execution_name: name,
    execution_arn: cleanupExecutionArn(versionArn, name), state_machine_version_arn: versionArn,
    status: options.status ?? 'FAILED', proof_status: 'refused' } };
}

async function runOwner(options, verify) {
  return run({ ...options, verify }, options.environmentPatch ?? {}, async directory => {
    const ownerPath = join(directory, 'owner.json');
    await writeFile(ownerPath, JSON.stringify(options.evidence));
    return { E2E_CLEANUP_ORIGINAL_EVIDENCE_PATH: ownerPath };
  });
}

test('the envelope always emits normal mode with no attempt, and a Service attempt echo is refused', async () => {
  assert.deepEqual(Object.keys(envelope).sort(), ['cleanup_request', 'operation_id', 'operation_mode', 'request_sha256', 'run_scope',
    'schema_version', 'service_commit_sha', 'service_image_digest'].sort());
  assert.equal(envelope.operation_mode, 'normal');
  assert.equal(Object.hasOwn(envelope, 'recovery_attempt'), false);
  assert.equal(envelope.operation_id, `beta-tester-cleanup:${scope}`);
  assert.equal(JSON.stringify(envelope).includes('recovery_attempt'), false);
  // Drive the production committed-result proof with an attempt echo. The
  // regression is non-vacuous: `validateCommitted` (through `readCommitted`)
  // must refuse the marker even though E2E never emits an attempt.
  await run({ existing: { 0: 'SUCCEEDED' },
    logs: token => ({ events: token ? [] : [{ message: `ANYWEAR_BETA_CLEANUP_RESULT=${JSON.stringify(committed({ recovery_attempt: 1 }))}` }], nextForwardToken: 'end' }),
    verify: async (execute, _io, path) => {
      await assert.rejects(execute(), /identities retained/);
      const operation = JSON.parse(await readFile(path, 'utf8')).operation;
      assert.equal(operation.refusal_phase, 'completion_proof');
      assert.equal(operation.refusal_category, 'completion_proof_unavailable');
    } });
});

test('the captured scope has exactly two deterministic names and no recovery-shaped identity', () => {
  assert.equal(name0, `beta-cleanup-${scope}-${envelope.request_sha256.slice(0, 16)}`);
  assert.equal(name1, `${name0}-retry1`);
  assert.throws(() => deterministicCleanupExecutionName(envelope, 2));
  assert.throws(() => deterministicCleanupExecutionName(envelope, -1));
  assert.throws(() => deterministicCleanupExecutionName(envelope, 1.5));
  // The production surface no longer derives a recovery-shaped execution name.
  const source = readFileSync(new URL('../tests/support/service-cleanup-operation.ts', import.meta.url), 'utf8');
  assert.equal(source.includes('beta-cleanup-recovery-'), false);
});

test('a maximum-length run scope still has a startable, legacy-compatible retry name', () => {
  const maxScope = `12345678901234567890-999999-${'a'.repeat(16)}`;
  const maxInputs = { ...inputs, cleanup_json: JSON.stringify({ runScope: maxScope,
    users: [{ sub: '10000000-0000-4000-8000-000000000001', email: `e2e-beta-${maxScope}-0-a1b2c3d4@anywear.local` }] }) };
  const maxEnvelope = createCleanupOperationEnvelope(maxInputs, environment);
  const base = deterministicCleanupExecutionName(maxEnvelope, 0);
  const retry = deterministicCleanupExecutionName(maxEnvelope, 1);
  assert.equal(base.length, 74);
  assert.equal(retry, `${base.slice(0, 72)}-retry1`);
  assert.equal(retry.length, 79);
  assert.ok(cleanupExecutionArn(environment.BETA_CLEANUP_STATE_MACHINE_VERSION_ARN, retry));
});

test('bounded canonical worker envelope and execution identity reject malformed source, scope and foreign versions', () => {
  for (const json of [` ${inputs.cleanup_json}`, inputs.cleanup_json.replace(scope, `${scope}x`), inputs.cleanup_json.replace('"users":', '"runScope":"duplicate","users":')]) {
    assert.throws(() => createCleanupOperationEnvelope({ ...inputs, cleanup_json: json }, environment));
  }
  assert.throws(() => cleanupExecutionArn(environment.BETA_CLEANUP_STATE_MACHINE_VERSION_ARN.replace(':7', ''), name0));
  assert.throws(() => createCleanupOperationEnvelope(inputs, { ...environment, E2E_CLEANUP_SERVICE_IMAGE_DIGEST: 'latest' }));
});

test('the scoped Beta worker address is accepted for its own run scope and never for another', () => {
  // Issue #129: attempt addresses are `e2e-beta-{runScope}-{slot}-{8hex}`, which
  // is the family the Service's own cleanup parser matches. This run's address
  // is a valid envelope input; a foreign, malformed or stable-row address is
  // either re-scoped (refused) or kept only as a historical capture.
  const scoped = `e2e-beta-${scope}-0-a1b2c3d4@anywear.local`;
  const withUser = (email) => ({ ...inputs, cleanup_json: JSON.stringify({ runScope: scope, users: [{ sub: '10000000-0000-4000-8000-000000000001', email }] }) });
  assert.equal(JSON.parse(createCleanupOperationEnvelope(withUser(scoped), environment).cleanup_request).users[0].email, scoped);
  // The retained stable row a pre-#129 manifest captured stays cleanable.
  const stable = withUser('e2e-beta-worker-0-chromium@anywear.local');
  assert.equal(JSON.parse(createCleanupOperationEnvelope(stable, environment).cleanup_request).users[0].email,
    'e2e-beta-worker-0-chromium@anywear.local');
  for (const foreign of [
    `e2e-beta-123456790-1-${'a'.repeat(16)}-0-a1b2c3d4@anywear.local`,
    `e2e-beta-${scope}-0-a1b2c3d4e@anywear.local`,
    `e2e-beta-${scope}-0-A1B2C3D4@anywear.local`,
    `e2e-beta-${scope}-0-a1b2c3d4@example.com`,
    `e2e-beta-allowlist-${scope}-primary@anywear.local`,
  ]) assert.throws(() => createCleanupOperationEnvelope(withUser(foreign), environment), /exact captured worker subjects/, foreign);
});

test('normal cleanup persists pending evidence and requires actual tasks and a unique committed marker', async () => {
  await run({ verify: async (execute, io, path) => {
    const originalStart = io.start;
    io.start = async (...args) => {
      assert.equal(JSON.parse(await readFile(path, 'utf8')).operation.proof_status, 'pending');
      return originalStart(...args);
    };
    const result = await execute();
    assert.equal(result.operation.proof_status, 'verified');
    assert.equal(result.operation.committed_result.transaction_committed, true);
    assert.equal(result.operation.tasks.length, 2);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), result);
    assert.equal(io.calls.filter(call => call.aws?.[0] === 'ecs' && call.aws[1] !== 'list-tasks').length, 4);
  } });
});

test('an absent generation 0 starts exactly once and verifies the committed result', async () => {
  await run({ verify: async (execute, io) => {
    const result = await execute();
    assert.equal(result.operation.execution_name, name0);
    assert.equal(result.operation.execution_arn, arn0);
    assert.equal(result.operation.proof_status, 'verified');
    assert.equal(io.calls.filter(call => call.start).length, 1);
    assert.equal(io.calls.filter(call => call.start)[0].start, name0);
    assert.deepEqual(JSON.parse(JSON.stringify(io.calls.filter(call => call.start)[0].input)), envelope);
    // One absent-name resolution and one observation of the started execution.
    assert.equal(io.calls.filter(call => call.describe).length, 2);
  } });
});

test('an already running execution is resumed and verified without a new start', async () => {
  await run({ existing: { 0: 'RUNNING' }, completeRunning: true, verify: async (execute, io) => {
    const result = await execute();
    assert.equal(result.operation.proof_status, 'verified');
    assert.equal(result.operation.execution_name, name0);
    assert.equal(io.calls.filter(call => call.start).length, 0);
    assert.deepEqual(io.calls.filter(call => call.describe).map(call => call.describe), [arn0, arn0]);
  } });
});

test('an already succeeded execution is verified from one describe without a start', async () => {
  await run({ existing: { 0: 'SUCCEEDED' }, verify: async (execute, io) => {
    const result = await execute();
    assert.equal(result.operation.proof_status, 'verified');
    assert.equal(result.operation.execution_name, name0);
    assert.equal(result.operation.status, 'SUCCEEDED');
    assert.equal(io.calls.filter(call => call.start).length, 0);
    assert.equal(io.calls.filter(call => call.describe).length, 1);
  } });
});

test('one retry after a terminal failure uses one describe, one cleanup-family inventory and one start', async () => {
  await run({ existing: { 0: 'FAILED' }, verify: async (execute, io, path) => {
    const result = await execute();
    assert.equal(result.operation.execution_name, name1);
    assert.equal(result.operation.execution_arn, arn1);
    assert.equal(result.operation.proof_status, 'verified');
    assert.deepEqual(result.operation.preceding_execution, { execution_arn: arn0, status: 'FAILED',
      stopped_at: '2026-10-10T00:00:01.000Z', cleanup_families: ['beta-anywear-cleanup', 'beta-anywear-cleanup-verify', 'beta-anywear-cleanup-acceptance'] });
    assert.equal(io.calls.filter(call => call.start).length, 1);
    assert.equal(io.calls.filter(call => call.start)[0].start, name1);
    assert.deepEqual(JSON.parse(JSON.stringify(io.calls.filter(call => call.start)[0].input)), envelope);
    // Exactly the predecessor describe, the retry-name resolution and the
    // observation of the execution this dispatch started. An extra speculative
    // describe would change this sequence.
    assert.deepEqual(io.calls.filter(call => call.describe).map(call => call.describe), [arn0, arn1, arn1]);
    assert.deepEqual(io.calls.filter(call => call.aws?.[1] === 'list-tasks').map(call => call.aws[call.aws.indexOf('--desired-status') + 1]),
      ['RUNNING', 'RUNNING', 'RUNNING']);
    assert.deepEqual(io.calls.filter(call => call.aws?.[1] === 'list-tasks').map(call => call.aws[call.aws.indexOf('--family') + 1]),
      ['beta-anywear-cleanup', 'beta-anywear-cleanup-verify', 'beta-anywear-cleanup-acceptance']);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), result);
  } });
});

test('a repeated dispatch onto the existing -retry1 neither starts a duplicate nor re-runs the completed cleanup', async () => {
  await run({ existing: { 0: 'FAILED' }, verify: async (execute, io) => {
    const first = await execute();
    assert.equal(first.operation.execution_name, name1);
    assert.equal(io.calls.filter(call => call.start).length, 1);
    const second = await execute();
    assert.equal(second.operation.proof_status, 'verified');
    assert.equal(second.operation.execution_name, name1);
    assert.equal(io.calls.filter(call => call.start).length, 1);
    assert.equal(second.operation.preceding_execution.execution_arn, arn0);
  } });
});

test('a dispatch that finds -retry1 already terminal non-success refuses and starts no third execution', async () => {
  await run({ existing: { 0: 'FAILED', 1: 'FAILED' }, verify: async (execute, io, path) => {
    await assert.rejects(execute(), /identities retained/);
    assert.equal(io.calls.filter(call => call.start).length, 0);
    const operation = JSON.parse(await readFile(path, 'utf8')).operation;
    assert.equal(operation.execution_name, name1);
    assert.equal(operation.refusal_phase, 'retry_eligibility');
    assert.equal(operation.refusal_category, 'retry_not_authorized');
    assert.equal(operation.preceding_execution.execution_arn, arn0);
  } });
});

test('a dispatch refuses to start the retry when the predecessor cannot be shown stopped', async () => {
  const cases = [
    // A RUNNING-desired task returned by any cleanup family.
    args => ({ taskArns: args.includes('beta-anywear-cleanup-verify') ? [task('cleanup')] : [] }),
    // Incomplete or repeated inventory pagination cannot show cessation.
    () => ({ taskArns: [], nextToken: 'loop' }),
    // A returned task outside the fixed cleanup families is not a bound inventory.
    () => ({ taskArns: ['arn:aws:ecs:ap-east-1:650880818323:task/beta-anywear/foreign'] }),
  ];
  for (const inventory of cases) {
    await run({ existing: { 0: 'FAILED' }, inventory, verify: async (execute, io, path) => {
      await assert.rejects(execute(), /identities retained/);
      assert.equal(io.calls.filter(call => call.start).length, 0);
      const operation = JSON.parse(await readFile(path, 'utf8')).operation;
      assert.equal(operation.execution_name, name0);
      assert.equal(operation.refusal_phase, 'retry_proof');
      assert.equal(operation.refusal_category, 'retry_proof_unavailable');
      assert.equal(operation.preceding_execution, undefined);
    } });
  }
});

test('a captured owner from an older state-machine version recovers through one current retry', async () => {
  const ownerVersionArn = environment.BETA_CLEANUP_STATE_MACHINE_VERSION_ARN.replace(':7', ':1');
  const currentVersionArn = environment.BETA_CLEANUP_STATE_MACHINE_VERSION_ARN.replace(':7', ':2');
  await runOwner({
    existing: { 0: { status: 'FAILED', versionArn: ownerVersionArn } },
    evidence: ownerEvidenceFor(envelope, { versionArn: ownerVersionArn }),
    environmentPatch: { BETA_CLEANUP_STATE_MACHINE_VERSION_ARN: currentVersionArn },
  }, async (execute, io) => {
    const result = await execute();
    assert.equal(result.operation.proof_status, 'verified');
    assert.equal(result.operation.execution_name, name1);
    assert.equal(result.operation.state_machine_version_arn, currentVersionArn);
    assert.equal(result.operation.preceding_execution.execution_arn, arn0);
    assert.equal(io.calls.filter(call => call.start).length, 1);
    assert.equal(io.calls.filter(call => call.start)[0].start, name1);
    // The retry is the current normal envelope, not the owner's old input.
    assert.deepEqual(JSON.parse(JSON.stringify(io.calls.filter(call => call.start)[0].input)), envelope);
  });
});

test('an owner captured under a changed Service image/source is still observed and retried', async () => {
  const ownerEnvironment = { ...environment, E2E_CLEANUP_SERVICE_SHA: 'c'.repeat(40), E2E_CLEANUP_SERVICE_IMAGE_DIGEST: `sha256:${'d'.repeat(64)}` };
  const ownerEnvelope = createCleanupOperationEnvelope(inputs, ownerEnvironment);
  assert.notEqual(ownerEnvelope.service_image_digest, envelope.service_image_digest);
  await runOwner({
    existing: { 0: { status: 'FAILED', envelope: ownerEnvelope } },
    evidence: ownerEvidenceFor(ownerEnvelope),
  }, async (execute, io) => {
    const result = await execute();
    assert.equal(result.operation.proof_status, 'verified');
    assert.equal(io.calls.filter(call => call.start).length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(io.calls.filter(call => call.start)[0].input)), envelope);
    assert.equal(io.calls.filter(call => call.describe)[0].describe, cleanupExecutionArn(environment.BETA_CLEANUP_STATE_MACHINE_VERSION_ARN, name0));
  });
});

test('a legacy mode-less owner input is still recoverable and the retry uses normal mode', async () => {
  const legacyEnvelope = Object.fromEntries(Object.entries(envelope).filter(([key]) => key !== 'operation_mode'));
  await runOwner({
    existing: { 0: { status: 'FAILED', envelope: legacyEnvelope } },
    evidence: ownerEvidenceFor(legacyEnvelope),
  }, async (execute, io) => {
    const result = await execute();
    assert.equal(result.operation.proof_status, 'verified');
    assert.equal(io.calls.filter(call => call.start).length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(io.calls.filter(call => call.start)[0].input)), envelope);
    assert.equal(result.operation.execution_name, name1);
  });
});

test('a running owner from an older version resumes under its own envelope without a start', async () => {
  const ownerVersionArn = environment.BETA_CLEANUP_STATE_MACHINE_VERSION_ARN.replace(':7', ':1');
  const currentVersionArn = environment.BETA_CLEANUP_STATE_MACHINE_VERSION_ARN.replace(':7', ':2');
  const ownerEnvironment = { ...environment, E2E_CLEANUP_SERVICE_IMAGE_DIGEST: `sha256:${'d'.repeat(64)}` };
  const ownerEnvelope = createCleanupOperationEnvelope(inputs, ownerEnvironment);
  await runOwner({
    existing: { 0: { status: 'RUNNING', versionArn: ownerVersionArn, envelope: ownerEnvelope } },
    evidence: ownerEvidenceFor(ownerEnvelope, { versionArn: ownerVersionArn }),
    proofEnvelope: ownerEnvelope,
    completeRunning: true,
    environmentPatch: { BETA_CLEANUP_STATE_MACHINE_VERSION_ARN: currentVersionArn },
  }, async (execute, io) => {
    const result = await execute();
    assert.equal(result.operation.proof_status, 'verified');
    assert.equal(result.operation.execution_name, name0);
    assert.equal(result.operation.state_machine_version_arn, ownerVersionArn);
    assert.equal(result.operation.input.service_image_digest, ownerEnvelope.service_image_digest);
    assert.equal(io.calls.filter(call => call.start).length, 0);
    assert.deepEqual(io.calls.filter(call => call.describe).map(call => call.describe), [arn0, arn0]);
  });
});

test('a legacy owner that already used -retry1 refuses a terminal non-success with no third execution', async () => {
  const ownerVersionArn = environment.BETA_CLEANUP_STATE_MACHINE_VERSION_ARN.replace(':7', ':1');
  const legacyEnvelope = Object.fromEntries(Object.entries(envelope).filter(([key]) => key !== 'operation_mode'));
  await runOwner({
    existing: { 1: { status: 'FAILED', versionArn: ownerVersionArn, envelope: legacyEnvelope } },
    evidence: ownerEvidenceFor(legacyEnvelope, { versionArn: ownerVersionArn, generation: 1 }),
    proofEnvelope: legacyEnvelope,
    environmentPatch: { BETA_CLEANUP_STATE_MACHINE_VERSION_ARN: environment.BETA_CLEANUP_STATE_MACHINE_VERSION_ARN.replace(':7', ':2') },
  }, async (execute, io, path) => {
    await assert.rejects(execute(), /identities retained/);
    assert.equal(io.calls.filter(call => call.start).length, 0);
    const operation = JSON.parse(await readFile(path, 'utf8')).operation;
    assert.equal(operation.execution_name, name1);
    assert.equal(operation.state_machine_version_arn, ownerVersionArn);
    assert.equal(operation.refusal_phase, 'retry_eligibility');
    assert.equal(operation.refusal_category, 'retry_not_authorized');
  });
});

for (const startError of ['ExecutionAlreadyExists', 'TimeoutError', 'NetworkingError']) {
  test(`${startError} without an execution ARN resumes only the exact deterministic existing execution`, async () => {
    await run({ startError, verify: async (execute, io) => {
      assert.equal((await execute()).operation.proof_status, 'verified');
      assert.equal(io.calls.find(call => call.describe).describe, arn0);
      assert.equal(io.calls.filter(call => call.start).length, 1);
    } });
  });
}

test('unrelated start failures never permit identity cleanup', async () => {
  await run({ startError: 'AccessDeniedException', verify: async (execute, io, path) => {
    await assert.rejects(execute(), /identities retained/);
    assert.equal(io.calls.some(call => call.aws), false);
    assert.equal(io.calls.filter(call => call.start).length, 1);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).operation.proof_status, 'refused');
  } });
});

test('mismatched execution input, version, name, output and truncation all retain identities', async () => {
  for (const patch of [{ input: '{}' }, { stateMachineVersionArn: environment.BETA_CLEANUP_STATE_MACHINE_VERSION_ARN.replace(':7', ':8') },
    { executionArn: `${arn0}x` }, { name: `${name0}x` }, { inputDetails: { included: false } }, { outputDetails: { included: false } },
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
    await run({ existing: { 0: 'SUCCEEDED' }, task: (value, kind) => kind === 'cleanup' ? transform(value) : value,
      verify: async execute => { await assert.rejects(execute(), /identities retained/); } });
  }
  await run({ existing: { 0: 'SUCCEEDED' }, definition: value => ({ ...value, containerDefinitions: [{ ...value.containerDefinitions[0], environment: [] }] }),
    verify: async execute => { await assert.rejects(execute(), /identities retained/); } });
  await run({ existing: { 0: 'SUCCEEDED' }, task: (value, kind) => kind === 'cleanup' ? { ...value, taskArn: task('verification') } : value,
    verify: async execute => { await assert.rejects(execute(), /identities retained/); } });
});

test('duplicate, truncated, foreign, and unassigned diagnostic message markers fail closed', async () => {
  const record = `ANYWEAR_BETA_CLEANUP_RESULT=${JSON.stringify(committed())}`;
  for (const events of [[{ message: record }, { message: record }], [{ message: 'ANYWEAR_BETA_CLEANUP_RESULT={' }],
    [{ message: `ANYWEAR_BETA_CLEANUP_RESULT=${JSON.stringify(committed({ transaction_committed: false }))}` }],
    [{ message: `ANYWEAR_BETA_CLEANUP_RESULT=${JSON.stringify(committed({ envelope_sha256: 'f'.repeat(64) }))}` }],
    [{ message: `ANYWEAR_BETA_CLEANUP_RESULT=${JSON.stringify(committed({ dlq: { deleted: -1, preserved: 0 } }))}` }],
    [{ message: `ANYWEAR_BETA_CLEANUP_RESULT=${JSON.stringify(committed({ dlq: { deleted: 1, preserved: 0, known_message: { message_id: 'foreign' } } }))}` }]]) {
    await run({ existing: { 0: 'SUCCEEDED' }, logs: token => ({ events: token ? [] : events, nextForwardToken: 'end' }),
      verify: async execute => { await assert.rejects(execute(), /identities retained/); } });
  }
});

test('a trusted Service may report owned terminal-task DLQ deletions without diagnostic message authority', async () => {
  await run({ existing: { 0: 'SUCCEEDED' }, logs: token => ({ events: token ? [] : [{ message: `ANYWEAR_BETA_CLEANUP_RESULT=${JSON.stringify(committed({ dlq: { deleted: 2, preserved: 3 } }))}` }], nextForwardToken: 'end' }),
    verify: async execute => { assert.equal((await execute()).operation.committed_result.dlq.deleted, 2); } });
});

test('bounded log visibility waits and pagination limits preserve incomplete proof', async () => {
  await run({ existing: { 0: 'SUCCEEDED' }, logs: () => ({ events: [], nextForwardToken: 'end' }), verify: async (execute, io) => {
    await assert.rejects(execute(), /identities retained/);
    assert.equal(io.calls.filter(call => call.sleep).length, 14);
  } });
  await run({ existing: { 0: 'SUCCEEDED' }, logs: (_token, count) => ({ events: [], nextForwardToken: String(count) }), verify: async (execute, io) => {
    await assert.rejects(execute(), /identities retained/);
    assert.equal(io.calls.filter(call => call.aws?.[0] === 'logs').length, 20);
  } });
});

test('refusal diagnostics use only finite phase/category values', async () => {
  const refused = async (options, environmentPatch = {}) => run({ ...options, verify: async (execute, _io, path) => {
    await assert.rejects(execute(), /identities retained/);
    return JSON.parse(await readFile(path, 'utf8')).operation;
  } }, environmentPatch);
  const cases = [
    [{ startError: 'AccessDeniedException' }, 'operation_start', 'operation_start_unavailable'],
    [{ description: () => ({ input: '{}' }) }, 'execution_observation', 'execution_observation_unavailable'],
    [{ existing: { 0: 'FAILED' }, inventory: () => ({ taskArns: [task('cleanup')] }) }, 'retry_proof', 'retry_proof_unavailable'],
    [{ existing: { 0: 'FAILED', 1: 'FAILED' } }, 'retry_eligibility', 'retry_not_authorized'],
    [{ existing: { 0: 'RUNNING' } }, 'execution_observation', 'execution_not_succeeded'],
    [{ existing: { 0: 'SUCCEEDED' }, description: () => ({ output: '{}' }) }, 'result_proof', 'result_proof_unavailable'],
    [{ existing: { 0: 'SUCCEEDED' }, task: value => ({ ...value, lastStatus: 'RUNNING' }) }, 'task_proof', 'task_proof_unavailable'],
    [{ existing: { 0: 'SUCCEEDED' }, logs: token => ({ events: token ? [] : [], nextForwardToken: 'end' }) }, 'completion_proof', 'completion_proof_unavailable'],
  ];
  for (const [options, phase, category] of cases) {
    const operation = await refused(options);
    assert.equal(operation.proof_status, 'refused');
    assert.equal(operation.refusal_phase, phase);
    assert.equal(operation.refusal_category, category);
    assert.equal(operation.failure, 'Exact execution/task/committed-result proof unavailable; Cognito identities retained');
  }
});

test('verification name-only override is allowed while environment overrides remain refused', async () => {
  await run({ existing: { 0: 'SUCCEEDED' }, task: (value, kind) => kind === 'verification' ? { ...value, overrides: { containerOverrides: [{ name: 'OneShot' }] } } : value,
    verify: async execute => { assert.equal((await execute()).operation.proof_status, 'verified'); } });
  await run({ existing: { 0: 'SUCCEEDED' }, task: (value, kind) => kind === 'verification' ? { ...value, overrides: { containerOverrides: [{ name: 'OneShot', environment: [] }] } } : value,
    verify: async execute => { await assert.rejects(execute(), /identities retained/); } });
});

test('a pending execution remains bounded and retains its recoverable execution identity on timeout', async () => {
  await run({ existing: { 0: 'RUNNING' }, verify: async (execute, io, path) => {
    await assert.rejects(execute(), /identities retained/);
    assert.equal(io.calls.filter(call => call.describe).length, 900);
    const record = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(record.operation.status, 'RUNNING');
    assert.equal(record.operation.execution_arn, arn0);
  } });
});

test('original operation evidence is validated in its own terms and request drift refuses any start', async () => {
  // A valid owner is consumed in its own terms, even when its version differs
  // from the current one (the dedicated owner tests also cover a changed
  // source/image and a legacy mode-less input).
  await runOwner({ existing: { 0: 'SUCCEEDED' }, evidence: ownerEvidenceFor(envelope) }, async (execute, io) => {
    assert.equal((await execute()).operation.proof_status, 'verified');
    assert.equal(io.calls.filter(call => call.start).length, 0);
  });
  const valid = ownerEvidenceFor(envelope);
  const otherScope = `987654321-1-${'e'.repeat(16)}`;
  const otherInputs = { ...inputs, cleanup_json: JSON.stringify({ runScope: otherScope,
    users: [{ sub: '10000000-0000-4000-8000-000000000001', email: `e2e-beta-${otherScope}-0-a1b2c3d4@anywear.local` }] }) };
  const otherEnvelope = createCleanupOperationEnvelope(otherInputs, environment);
  const corruptions = [
    { ...valid, operation: { ...valid.operation, input_sha256: 'f'.repeat(64) } },
    { ...valid, record_type: 'anywear_e2e_foreign_record' },
    { ...valid, operation: { ...valid.operation, execution_name: 'beta-cleanup-foreign-name' } },
    { ...valid, operation: { ...valid.operation, operation_mode: 'recovery' } },
    ownerEvidenceFor(otherEnvelope),
  ];
  for (const evidence of corruptions) {
    await run({ existing: { 0: 'SUCCEEDED' }, verify: async (execute, io) => {
      await assert.rejects(execute(), /Original cleanup evidence/);
      assert.equal(io.calls.length, 0);
    } }, {}, async directory => {
      const path = join(directory, 'original.json');
      await writeFile(path, JSON.stringify(evidence));
      return { E2E_CLEANUP_ORIGINAL_EVIDENCE_PATH: path };
    });
  }
});

test('the dispatch surface no longer declares the manual recovery entry', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(packageJson.scripts['test:core'].includes('scripts/service-cleanup-operation.test.mjs'));
  const workflow = await readFile(new URL('../.github/workflows/beta-qualification.yml', import.meta.url), 'utf8');
  // #217: the manual `recover` operation, its captured-identity inputs and its original-
  // evidence replay are removed; only `full`, `smoke` and `reconcile` remain.
  assert.doesNotMatch(workflow, /^ {2}recover:$/m, 'the qualify entry must not declare a recover job');
  for (const removed of ['source_run_id', 'source_run_attempt', 'operation_mode', 'recovery_attempt',
    'previous_recovery_run_id', 'previous_recovery_run_attempt', 'retry_failed_execution']) {
    assert.doesNotMatch(workflow, new RegExp(`^ {6}${removed}:$`, 'm'), `${removed} must not remain a dispatch input`);
  }
  assert.doesNotMatch(workflow, /E2E_CLEANUP_(?:OPERATION_MODE|RECOVERY_ATTEMPT|RETRY_FAILED|PREVIOUS_RECOVERY_EVIDENCE_PATH)/);
  assert.doesNotMatch(workflow, /RECOVERY_PREVIOUS_RUN_|E2E_CLEANUP_ORIGINAL_EVIDENCE_PATH/);
  assert.match(workflow, /worker_slot_offset:/);
  assert.match(workflow, /E2E_WORKER_SLOT_OFFSET:.*inputs.worker_slot_offset/);
});

test('the replay chain leaves no tracked production reference or callerless entry behind', () => {
  const production = ['tests/support/service-cleanup-operation.ts', 'scripts/cleanup-worker-accounts.mjs',
    '.github/workflows/beta-qualification.yml'];
  for (const file of production) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    for (const removed of ['beta-cleanup-recovery-', 'assertPreviousRecovery', 'assertRecoveryOperationEvidence',
      'runRecoveryCleanupOperation', 'prepareCleanupRetryIntent', 'submitCleanupRetryIntent',
      'observeFailedCleanupOperation', 'observeSubmittedCleanupOperation', 'recoveryPreflight', 'cessationSnapshot',
      'previous-recovery-operation', 'previous-recovery-owner', 'recovery-selection.json']) {
      assert.equal(source.includes(removed), false, `${file} still references ${removed}`);
    }
  }
  assert.equal(existsSync(new URL('../scripts/delete-recovered-identities.mjs', import.meta.url)), false,
    'the callerless delete-recovered-identities entry point is removed');
  assert.equal(existsSync(new URL('../scripts/account-recovery-inputs.mjs', import.meta.url)), false,
    'the manual recovery input validator is removed');
});
