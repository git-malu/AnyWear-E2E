import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENVIRONMENT_VERDICT_PATH, SIZING_TASK_RECOVERY_FLOOR_MS, SIZING_TAGGING_TERMINAL_WAIT_MS, SIZING_VTO_TERMINAL_WAIT_MS,
  assertQualificationEnvironment, assertTerminalWaitCoversRecoveryFloor, compareWorkerIdentity, environmentVerdict,
  qualificationRefusalMessage, readOptionalEnvironmentJson, terminalWaitMs, unavailableWorkerIdentityComparison,
  validateWorkerIdentity, workerIdentitySnapshot } from './beta-sizing-environment.mjs';
import { SIZING_WORKLOAD } from './beta-sizing-benchmark.mjs';
import { sizingVtoCases } from './beta-sizing-workload.mjs';

const ACCOUNT = '650880818323';
const WORKER_DEFINITION = `arn:aws:ecs:ap-east-1:${ACCOUNT}:task-definition/beta-anywear-worker:64`;
const NEXT_WORKER_DEFINITION = `arn:aws:ecs:ap-east-1:${ACCOUNT}:task-definition/beta-anywear-worker:65`;
const taskArn = suffix => `arn:aws:ecs:ap-east-1:${ACCOUNT}:task/beta-anywear/${suffix.repeat(32).slice(0, 32)}`;
const workerTask = (suffix, definition = WORKER_DEFINITION) => ({
  taskArn: taskArn(suffix), taskDefinitionArn: definition, lastStatus: 'RUNNING', startedAt: '2026-10-16T07:05:00.000Z',
});

// The capture is offline-tested against an injected reader, the same way the
// sizing runtime snapshot is, because the real reader shells out to the AWS CLI.
function awsStub({ tasks, definition = WORKER_DEFINITION, rolloutStates = ['COMPLETED'] } = {}) {
  const calls = [];
  const aws = args => {
    calls.push(args);
    switch (args.slice(0, 2).join(' ')) {
      case 'sts get-caller-identity':
        return { Account: ACCOUNT, Arn: `arn:aws:sts::${ACCOUNT}:assumed-role/beta-e2e-qualification-role/run` };
      case 'ecs describe-services':
        return {
          failures: [],
          services: [{
            serviceName: 'beta-anywear-worker', taskDefinition: definition, desiredCount: 1,
            runningCount: tasks.length, pendingCount: 0,
            deployments: rolloutStates.map((rolloutState, index) => ({ id: `ecs-svc/${1000 + index}`, rolloutState })),
          }],
        };
      case 'ecs list-tasks':
        return { taskArns: tasks.map(task => task.taskArn) };
      case 'ecs describe-tasks':
        return { failures: [], tasks };
      default:
        throw new Error(`Unallocated AWS call: ${args.slice(0, 2).join(' ')}`);
    }
  };
  return { aws, calls };
}

const capture = (options, phase = 'before') => {
  const { aws, calls } = awsStub(options);
  return { identity: workerIdentitySnapshot(aws, { phase }), calls };
};

// Two captures taken around a suite that really did run for minutes. The suite
// end is placed after the suite start so the pair brackets a window, which is the
// only ordering the comparison accepts.
function suiteWindow({ beforeTasks = [workerTask('a')], afterTasks = [workerTask('a')],
  afterDefinition = WORKER_DEFINITION, afterRollouts } = {}) {
  const before = capture({ tasks: beforeTasks }).identity;
  const captured = capture({ tasks: afterTasks, definition: afterDefinition, ...(afterRollouts ? { rolloutStates: afterRollouts } : {}) }, 'after');
  return {
    before,
    after: { ...captured.identity, observed_at: new Date(Date.parse(before.observed_at) + 60_000).toISOString() },
  };
}

test('the VTO terminal wait outlasts the platform recovery floor and is not a latency measurement', () => {
  assert.equal(SIZING_VTO_TERMINAL_WAIT_MS, 1_200_000);
  assert.ok(SIZING_VTO_TERMINAL_WAIT_MS >= 1_200_000, 'the reviewed budget is the acceptance floor');
  assert.equal(SIZING_TASK_RECOVERY_FLOOR_MS.vto, 960_000, 'the vto floor is its 960 s database lease');
  assert.ok(SIZING_VTO_TERMINAL_WAIT_MS > SIZING_TASK_RECOVERY_FLOOR_MS.vto);
  assert.equal(terminalWaitMs('vto'), 1_200_000);
  // The tagging budget is untouched and still clears its own, smaller floor.
  assert.equal(terminalWaitMs('tagging'), 600_000);
  assert.equal(SIZING_TAGGING_TERMINAL_WAIT_MS, 600_000);
  assert.ok(SIZING_TAGGING_TERMINAL_WAIT_MS > SIZING_TASK_RECOVERY_FLOOR_MS.tagging);
  // The old 600 s VTO budget is exactly the defect: it gave up before the platform
  // was allowed to redeliver the killed execution.
  assert.throws(() => assertTerminalWaitCoversRecoveryFloor('vto', 600_000), /recovery floor/);
  assert.throws(() => terminalWaitMs('unknown'), /Unknown sizing task kind/);
});

test('captures the worker identity and rejects a record that no longer matches it', () => {
  const { identity, calls } = capture({ tasks: [workerTask('a')] });
  assert.equal(identity.phase, 'before');
  assert.equal(identity.record_type, 'beta-worker-identity');
  assert.equal(identity.account_id, ACCOUNT);
  assert.equal(identity.cluster, 'beta-anywear');
  assert.equal(identity.service, 'beta-anywear-worker');
  assert.equal(identity.task_definition_arn, WORKER_DEFINITION);
  assert.deepEqual(identity.task_arns, [taskArn('a')]);
  assert.equal(identity.tasks.length, 1);
  assert.match(identity.identity_sha256, /^[a-f0-9]{64}$/);
  assert.equal(validateWorkerIdentity(identity, { phase: 'before' }), identity);
  assert.deepEqual(calls.map(args => args.slice(0, 2).join(' ')),
    ['sts get-caller-identity', 'ecs describe-services', 'ecs list-tasks', 'ecs describe-tasks']);

  // A rotation still in flight at suite end is a legal capture: recording exactly
  // that is why the record exists, so no completed rollout is required.
  const rotating = capture({ tasks: [workerTask('a'), workerTask('b')], rolloutStates: ['PRIMARY', 'ACTIVE'] }, 'after');
  assert.equal(validateWorkerIdentity(rotating.identity, { phase: 'after' }).task_arns.length, 2);

  const tampered = [structuredClone(identity), structuredClone(identity), structuredClone(identity),
    structuredClone(identity), structuredClone(identity)];
  tampered[0].task_arns = [taskArn('b')];
  tampered[1].unknown_field = true;
  tampered[2].task_arns = [taskArn('b'), taskArn('a')];
  tampered[3].task_arns = [taskArn('a'), taskArn('a')];
  tampered[4].tasks[0].task_arn = taskArn('b');
  for (const record of tampered) assert.throws(() => validateWorkerIdentity(record, { phase: 'before' }));
  assert.throws(() => validateWorkerIdentity(identity, { phase: 'after' }), /not the after one/);
});

test('attributes an interrupted case to the environment when the workers were replaced', () => {
  // The incident: three worker rotations inside the suite window, so the worker
  // task serving Beta at suite start is not the one serving it at suite end.
  const window = suiteWindow({ beforeTasks: [workerTask('a')], afterTasks: [workerTask('b')] });
  const comparison = compareWorkerIdentity(window.before, window.after);
  assert.equal(comparison.verdict, 'changed');
  assert.deepEqual(comparison.added_task_arns, [taskArn('b')]);
  assert.deepEqual(comparison.removed_task_arns, [taskArn('a')]);
  assert.equal(comparison.task_definition_changed, false);

  const verdict = environmentVerdict({ comparison, suiteOutcome: 'failure' });
  assert.equal(verdict.verdict, 'environment-changed');
  assert.equal(verdict.attribution, 'environment');
  assert.equal(verdict.product_failure_asserted, false);
  assert.equal(verdict.identity_coverage, 'established');
  assert.match(verdict.reason, /attributed to the environment, not to a product failure/);
});

test('keeps a product failure when the worker identity is unchanged', () => {
  const window = suiteWindow();
  const comparison = compareWorkerIdentity(window.before, window.after);
  assert.equal(comparison.verdict, 'unchanged');
  const verdict = environmentVerdict({ comparison, suiteOutcome: 'failure' });
  assert.equal(verdict.verdict, 'unchanged');
  assert.equal(verdict.attribution, 'product');
  assert.equal(verdict.product_failure_asserted, true);
  // A redeployment that replaced the task definition is an environment change even
  // when the same task ARN set happens to serve at both ends of the window.
  const redefined = suiteWindow({ afterDefinition: NEXT_WORKER_DEFINITION,
    afterTasks: [workerTask('a', NEXT_WORKER_DEFINITION)] });
  assert.equal(compareWorkerIdentity(redefined.before, redefined.after).verdict, 'changed');
  // A passing suite is never attributed at all.
  assert.equal(environmentVerdict({ comparison, suiteOutcome: 'success' }).attribution, 'none');
});

test('describes an added-only worker change as a scale-out, not a replacement', () => {
  const window = suiteWindow({ afterTasks: [workerTask('a'), workerTask('b'), workerTask('c')] });
  const comparison = compareWorkerIdentity(window.before, window.after);
  assert.equal(comparison.verdict, 'changed');
  assert.equal(comparison.reason,
    'The worker set serving Beta scaled out during the suite: 2 worker task(s) appeared');
  assert.equal(comparison.added_task_arns.length, 2);
  assert.deepEqual(comparison.added_task_arns, [taskArn('b'), taskArn('c')]);
  assert.deepEqual(comparison.removed_task_arns, []);
  assert.equal(comparison.removed_task_arns.length, 0);
  assert.equal(comparison.task_definition_changed, false);
  // "Replaced" is only true when a worker that was serving Beta left the set.
  assert.doesNotMatch(comparison.reason, /replaced/);
});

test('reads a removal as a replacement and reports the counts its reason names', () => {
  const removedOnly = suiteWindow({ beforeTasks: [workerTask('a'), workerTask('b')], afterTasks: [workerTask('a')] });
  const removal = compareWorkerIdentity(removedOnly.before, removedOnly.after);
  assert.equal(removal.reason,
    'The workers serving Beta were replaced during the suite: 1 worker task(s) disappeared');
  assert.deepEqual(removal.removed_task_arns, [taskArn('b')]);
  assert.deepEqual(removal.added_task_arns, []);
  assert.equal(removal.task_definition_changed, false);

  const both = suiteWindow({ beforeTasks: [workerTask('a'), workerTask('b'), workerTask('c')],
    afterTasks: [workerTask('a'), workerTask('d')] });
  const replaced = compareWorkerIdentity(both.before, both.after);
  assert.equal(replaced.reason,
    'The workers serving Beta were replaced during the suite: 2 worker task(s) disappeared and 1 worker task(s) appeared');
  assert.deepEqual(replaced.removed_task_arns, [taskArn('b'), taskArn('c')]);
  assert.deepEqual(replaced.added_task_arns, [taskArn('d')]);
  assert.equal(replaced.task_definition_changed, false);
  assert.match(replaced.reason, new RegExp(`${replaced.removed_task_arns.length} worker task\\(s\\) disappeared`));
  assert.match(replaced.reason, new RegExp(`${replaced.added_task_arns.length} worker task\\(s\\) appeared`));
});

test('names a changed worker task definition and never calls it a replacement', () => {
  // The same task ARN set under a new task definition: a redeployment the ARN set
  // cannot show, and the case the qualification gate must block.
  const byteIdentical = suiteWindow({ afterDefinition: NEXT_WORKER_DEFINITION,
    afterTasks: [workerTask('a', NEXT_WORKER_DEFINITION)] });
  const redefined = compareWorkerIdentity(byteIdentical.before, byteIdentical.after);
  assert.equal(redefined.verdict, 'changed');
  assert.equal(redefined.task_definition_changed, true);
  assert.equal(redefined.reason, 'The worker task definition serving Beta changed during the suite');
  assert.deepEqual(redefined.added_task_arns, []);
  assert.deepEqual(redefined.removed_task_arns, []);
  assert.doesNotMatch(redefined.reason, /replaced|scaled out/);

  const withAddition = suiteWindow({ afterDefinition: NEXT_WORKER_DEFINITION,
    afterTasks: [workerTask('a', NEXT_WORKER_DEFINITION), workerTask('b', NEXT_WORKER_DEFINITION)] });
  const added = compareWorkerIdentity(withAddition.before, withAddition.after);
  assert.equal(added.reason,
    'The worker task definition serving Beta changed during the suite: 1 worker task(s) appeared');
  assert.deepEqual(added.added_task_arns, [taskArn('b')]);
  assert.deepEqual(added.removed_task_arns, []);
  assert.equal(added.task_definition_changed, true);

  const withRemovals = suiteWindow({ beforeTasks: [workerTask('a'), workerTask('b'), workerTask('c')],
    afterDefinition: NEXT_WORKER_DEFINITION, afterTasks: [workerTask('a', NEXT_WORKER_DEFINITION)] });
  const shrunk = compareWorkerIdentity(withRemovals.before, withRemovals.after);
  assert.equal(shrunk.reason,
    'The worker task definition serving Beta changed during the suite: 2 worker task(s) disappeared');
  assert.deepEqual(shrunk.removed_task_arns, [taskArn('b'), taskArn('c')]);
  assert.deepEqual(shrunk.added_task_arns, []);
  assert.doesNotMatch(shrunk.reason, /replaced/);
});

test('refuses a qualification whose passing suite spanned two worker task definitions', () => {
  const window = suiteWindow({ afterDefinition: NEXT_WORKER_DEFINITION,
    afterTasks: [workerTask('a', NEXT_WORKER_DEFINITION)] });
  const record = environmentVerdict({ comparison: compareWorkerIdentity(window.before, window.after),
    suiteOutcome: 'success' });
  assert.equal(record.verdict, 'environment-changed');
  let refusal;
  try { assertQualificationEnvironment({ record, problem: null }); } catch (error) { refusal = error; }
  assert.ok(refusal, 'a passing suite across two worker task definitions must not qualify');
  assert.equal(refusal.message, 'A passing suite measured across two worker task definitions cannot issue a '
    + `qualification record: ${record.reason}. Worker tasks added: 0; removed: 0. `
    + 'Re-run the qualification on one stable worker task definition.');
  assert.equal(qualificationRefusalMessage(record), refusal.message);
  assert.doesNotMatch(refusal.message, /replaced/);
  assert.match(refusal.message, /Worker tasks added: 0; removed: 0/);
  assert.doesNotMatch(refusal.message, /[\r\n]/);
});

test('records an ARN rotation and a non-passing definition change but still qualifies them', () => {
  const rotated = suiteWindow({ afterTasks: [workerTask('a'), workerTask('b')] });
  const rotation = environmentVerdict({ comparison: compareWorkerIdentity(rotated.before, rotated.after),
    suiteOutcome: 'success' });
  assert.equal(rotation.verdict, 'environment-changed');
  assert.equal(rotation.comparison.task_definition_changed, false);
  assert.doesNotThrow(() => assertQualificationEnvironment({ record: rotation, problem: null }));

  // A definition change under a suite that already failed or never completed blocks
  // nothing: no passing record was possible there either way.
  const redefined = suiteWindow({ afterDefinition: NEXT_WORKER_DEFINITION,
    afterTasks: [workerTask('a', NEXT_WORKER_DEFINITION)] });
  const comparison = compareWorkerIdentity(redefined.before, redefined.after);
  assert.equal(comparison.task_definition_changed, true);
  for (const suiteOutcome of ['failure', 'incomplete']) {
    assert.doesNotThrow(() => assertQualificationEnvironment({
      record: environmentVerdict({ comparison, suiteOutcome }), problem: null,
    }));
  }

  // A structurally valid verdict whose comparison is unavailable establishes no task
  // definition change, so it is recorded rather than blocked.
  const unavailable = environmentVerdict({
    comparison: compareWorkerIdentity(null, null, { problem: 'Both captures are missing' }), suiteOutcome: 'success',
  });
  assert.equal(unavailable.verdict, 'unavailable');
  assert.doesNotThrow(() => assertQualificationEnvironment({ record: unavailable, problem: null }));
});

test('refuses a qualification when the environment verdict cannot be consulted', () => {
  const valid = environmentVerdict({
    comparison: compareWorkerIdentity(null, null, { problem: 'Both captures are missing' }), suiteOutcome: 'success',
  });
  const unknownField = structuredClone(valid); unknownField.unexpected = true;
  const missingField = structuredClone(valid); delete missingField.comparison.removed_task_arns;
  const wrongType = structuredClone(valid); wrongType.comparison.task_definition_changed = 'no';
  const unknownOutcome = structuredClone(valid); unknownOutcome.suite_outcome = 'cancelled';
  const cases = [
    ['missing', { record: null, problem: `${ENVIRONMENT_VERDICT_PATH} is missing` }],
    ['unreadable', { record: null, problem: `${ENVIRONMENT_VERDICT_PATH} is not valid JSON` }],
    ['absent', { record: null, problem: null }],
    ['not an object', { record: [1], problem: null }],
    ['truncated', { record: { record_type: 'beta-environment-verdict' }, problem: null }],
    ['unknown field', { record: unknownField, problem: null }],
    ['missing comparison field', { record: missingField, problem: null }],
    ['wrong comparison type', { record: wrongType, problem: null }],
    ['unknown suite outcome', { record: unknownOutcome, problem: null }],
    ['not provided', undefined],
  ];
  for (const [name, environment] of cases) {
    let refusal;
    try { assertQualificationEnvironment(environment); } catch (error) { refusal = error; }
    assert.ok(refusal, `${name} must refuse`);
    assert.match(refusal.message, /could not be established/);
    assert.match(refusal.message, /no qualification record is issued/);
    assert.ok(refusal.message.includes(ENVIRONMENT_VERDICT_PATH), `${name} must name the expected verdict path`);
  }
  // The message names the path the caller actually read.
  let renamed;
  try { assertQualificationEnvironment({ record: null, problem: 'elsewhere.json is missing' }, { source: 'elsewhere.json' }); }
  catch (error) { renamed = error; }
  assert.match(renamed.message, /The Beta environment verdict at elsewhere\.json could not be established/);
});

test('the qualification-gate command fails the run for a definition change and passes the rotation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'anywear-env-gate-'));
  const repository = fileURLToPath(new URL('..', import.meta.url));
  const summary = join(directory, 'step-summary.md');
  let written = 0;
  const gate = async (record) => {
    const verdictPath = join(directory, `verdict-${written += 1}.json`);
    await writeFile(verdictPath, `${JSON.stringify(record, null, 2)}\n`);
    const result = spawnSync(process.execPath, ['scripts/beta-sizing-environment.mjs', 'qualification-gate',
      '--output', verdictPath], { cwd: repository, encoding: 'utf8',
      env: { ...process.env, GITHUB_STEP_SUMMARY: summary } });
    assert.equal(result.error, undefined);
    return result;
  };
  try {
    const redefined = suiteWindow({ afterDefinition: NEXT_WORKER_DEFINITION,
      afterTasks: [workerTask('a', NEXT_WORKER_DEFINITION)] });
    const changed = environmentVerdict({ comparison: compareWorkerIdentity(redefined.before, redefined.after),
      suiteOutcome: 'success' });
    const refused = await gate(changed);
    assert.equal(refused.status, 1);
    assert.ok(refused.stderr.includes('::error title=Worker task definition changed during the suite::'
      + qualificationRefusalMessage(changed)));
    assert.match(await readFile(summary, 'utf8'), /^### Qualification refused across two worker task definitions$/m);

    const rotated = suiteWindow({ afterTasks: [workerTask('a'), workerTask('b')] });
    const rotation = environmentVerdict({ comparison: compareWorkerIdentity(rotated.before, rotated.after),
      suiteOutcome: 'success' });
    assert.equal(rotation.verdict, 'environment-changed');
    const qualified = await gate(rotation);
    assert.equal(qualified.status, 0);
    assert.doesNotMatch(`${qualified.stdout}${qualified.stderr}`, /cannot issue a qualification record/);

    const unavailable = environmentVerdict({
      comparison: compareWorkerIdentity(null, null, { problem: 'Both captures are missing' }), suiteOutcome: 'success',
    });
    assert.equal(unavailable.verdict, 'unavailable');
    const recorded = await gate(unavailable);
    assert.equal(recorded.status, 0);
    assert.doesNotMatch(recorded.stderr, /::error/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('records an unusable identity pair as unavailable without inventing a change', () => {
  const window = suiteWindow();
  const missing = environmentVerdict({
    comparison: compareWorkerIdentity(null, window.after, { problem: 'capture is missing' }), suiteOutcome: 'failure',
  });
  assert.equal(missing.verdict, 'unavailable');
  assert.equal(missing.identity_coverage, 'unavailable');
  assert.equal(missing.product_failure_asserted, true);
  assert.match(missing.reason, /still stands as a product failure/);
  assert.equal(missing.comparison.before_identity_sha256, null);

  // A pair that is not in suite order cannot bracket the run, so it establishes
  // nothing even though both records are individually well formed.
  assert.equal(unavailableWorkerIdentityComparison('unused').verdict, 'unavailable');
  const reversed = compareWorkerIdentity({ ...window.before, observed_at: window.after.observed_at }, window.after);
  assert.equal(reversed.verdict, 'unavailable');
  assert.match(reversed.reason, /not in suite order/);
});

test('binds the sizing workload record to the identity the suite started in', () => {
  const window = suiteWindow();
  const comparison = compareWorkerIdentity(window.before, window.after);
  const bound = environmentVerdict({ comparison, suiteOutcome: 'failure',
    workload: { result: 'failed-or-incomplete', worker_identity_before_sha256: window.before.identity_sha256 } });
  assert.equal(bound.workload_binding.record_present, true);
  assert.equal(bound.workload_binding.record_result, 'failed-or-incomplete');
  assert.equal(bound.workload_binding.matches_before_identity, true);
  const mismatched = environmentVerdict({ comparison, suiteOutcome: 'failure',
    workload: { result: 'failed-or-incomplete', worker_identity_before_sha256: 'f'.repeat(64) } });
  assert.equal(mismatched.workload_binding.matches_before_identity, false);
  assert.equal(environmentVerdict({ comparison, suiteOutcome: 'success' }).workload_binding.record_present, false);
});

test('asserts no product failure for a suite that neither passed nor failed', () => {
  // A cancelled suite and a suite ended by the job timeout both arrive as
  // `incomplete`. No product failure was established, so none may be recorded; the
  // run is already red from the cancelled step.
  const passed = suiteWindow();
  const unchanged = environmentVerdict({
    comparison: compareWorkerIdentity(passed.before, passed.after), suiteOutcome: 'incomplete',
  });
  assert.equal(unchanged.verdict, 'unchanged');
  assert.equal(unchanged.attribution, 'undetermined');
  assert.equal(unchanged.product_failure_asserted, false);
  const rotated = suiteWindow({ afterTasks: [workerTask('b')] });
  const replaced = environmentVerdict({
    comparison: compareWorkerIdentity(rotated.before, rotated.after), suiteOutcome: 'incomplete',
  });
  assert.equal(replaced.verdict, 'environment-changed');
  assert.equal(replaced.product_failure_asserted, false);
  // Only the three known outcomes are accepted, so a new GitHub step outcome cannot
  // be silently mapped onto a product-failure claim.
  assert.throws(() => environmentVerdict({ comparison: unchanged.comparison ?? {}, suiteOutcome: 'cancelled' }),
    /success, failure or incomplete/);
});

test('reads a missing or malformed environment input as a recorded problem', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'anywear-env-'));
  try {
    const valid = join(directory, 'identity.json');
    await writeFile(valid, JSON.stringify({ phase: 'before' }));
    assert.deepEqual(await readOptionalEnvironmentJson(valid), { record: { phase: 'before' }, problem: null });
    const malformed = join(directory, 'broken.json');
    await writeFile(malformed, '{"phase":');
    assert.match((await readOptionalEnvironmentJson(malformed)).problem, /not valid JSON/);
    assert.match((await readOptionalEnvironmentJson(join(directory, 'absent.json'))).problem, /is missing/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('keeps the frozen VTO shape set at four reviewed shapes, each run twice', () => {
  const cases = sizingVtoCases();
  assert.deepEqual([...SIZING_WORKLOAD.vto_shapes], ['ordinary-base-one-garment', 'large-base-one-garment',
    'ordinary-base-three-garments', 'large-base-three-garments']);
  assert.equal(SIZING_WORKLOAD.vto_generations, 8);
  assert.equal(cases.length, 8);
  assert.equal(new Set(cases.map(entry => entry.shape)).size, 4);
  for (const shape of SIZING_WORKLOAD.vto_shapes) {
    assert.equal(cases.filter(entry => entry.shape === shape).length, 2, `${shape} must still run twice`);
  }
  // The three-garment shapes are neither shrunk nor excluded.
  for (const shape of ['ordinary-base-three-garments', 'large-base-three-garments']) {
    for (const entry of cases.filter(item => item.shape === shape)) assert.equal(entry.garment_count, 3);
  }
});
