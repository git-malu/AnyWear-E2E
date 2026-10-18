import assert from 'node:assert/strict';
import test from 'node:test';
import { runtimeCloudHarness } from './fixtures/runtime-cloud-harness.mjs';
import { oneShotHarness } from './fixtures/runtime-one-shot-harness.mjs';
import { parseAdmissionMode } from './beta-admission-mode.mjs';
import { payloadHash, recoverOneShotRegistrations, runOwnedOneShot, verifyOneShotTask } from './runtime-one-shot.mjs';
import { activateRuntimeWindow, captureRuntimeWindow, reconcilePendingPolicy, testerHash } from './runtime-window-controls.mjs';
import { parseRuntimeRecovery } from './runtime-recovery.mjs';

async function orphan({ definition = true, task = false, inactive = false } = {}) {
  const h = oneShotHarness();
  h.scope.recoverySourceCompleted = true;
  const { operation } = await runOwnedOneShot(h.io, h.scope, 'lifecycle', 'suspend', '', h.runner);
  if (!task) h.tasks.clear();
  if (inactive) h.definitions.get(operation.task_definition_arn).taskDefinition.status = 'INACTIVE';
  if (!definition) h.definitions.clear();
  delete operation.task_arn;
  if (!definition) delete operation.task_definition_arn;
  return { ...h, operation };
}

test('fresh completed source rescans no-definition and registered-but-unstarted helpers instead of trusting saved flags', async () => {
  for (const definition of [false, true]) {
    const h = await orphan({ definition });
    h.operation.proven_not_started = true;
    h.operation.proven_no_active_definition = true;
    const proof = await recoverOneShotRegistrations(h.io, h.scope);
    assert.equal(proof.has(h.operation), true);
    assert.equal(h.operation.task_arn, undefined);
    assert.equal(h.operation.deregistered, true);
    assert.ok(h.calls.some((args) => args[1] === 'list-tasks' && args.includes('RUNNING')));
    assert.ok(h.calls.some((args) => args[1] === 'list-tasks' && args.includes('STOPPED')));
  }
});

test('old, unknown-date, future or noncompleted-source no-start operations fail closed', async () => {
  for (const mutate of [
    (h) => { h.scope.recoverySourceCompleted = false; },
    (h) => { h.operation.started_at = new Date(Date.now() - 45 * 60_000).toISOString(); },
    (h) => { delete h.operation.started_at; },
    (h) => { h.operation.started_at = new Date(Date.now() + 60_000).toISOString(); },
  ]) {
    const h = await orphan();
    mutate(h);
    await assert.rejects(recoverOneShotRegistrations(h.io, h.scope), /completed source workflow and a recent operation/);
    assert.ok(!h.calls.some((args) => args[1] === 'deregister-task-definition'));
  }
});

test('ACTIVE-only absence does not hide a STOPPED or RUNNING task on an INACTIVE definition', async () => {
  for (const running of [false, true]) {
    const h = await orphan({ task: true, inactive: true });
    delete h.operation.task_definition_arn;
    const task = [...h.tasks.values()][0];
    if (running) { task.lastStatus = 'RUNNING'; delete task.containers[0].exitCode; }
    h.operation.deregistered = true;
    h.operation.proven_not_started = true;
    const proof = await recoverOneShotRegistrations(h.io, h.scope);
    assert.equal(proof.has(h.operation), false);
    assert.equal(h.operation.task_arn, task.taskArn);
    if (running) await assert.rejects(verifyOneShotTask(h.io, h.scope, h.operation), /verification failed/);
    else await verifyOneShotTask(h.io, h.scope, h.operation);
  }
});

test('paginated, incomplete or ambiguous cloud scans cannot establish no-start', async () => {
  for (const boundary of ['page', 'missing-array', 'unresolved-task', 'foreign-owned-definition']) {
    const h = await orphan({ task: boundary === 'unresolved-task' });
    const aws = h.io.aws;
    if (boundary === 'foreign-owned-definition') h.definitions.get(h.operation.task_definition_arn).taskDefinition.containerDefinitions[0].image = 'foreign-image';
    h.io.aws = async (args) => {
      if (boundary === 'page' && args[1] === 'list-tasks') return { taskArns: [], nextToken: 'more' };
      if (boundary === 'missing-array' && args[1] === 'list-tasks') return {};
      if (boundary === 'unresolved-task' && args[1] === 'describe-tasks') return { tasks: [] };
      return aws(args);
    };
    await assert.rejects(recoverOneShotRegistrations(h.io, h.scope));
    assert.ok(!h.calls.some((args) => args[1] === 'deregister-task-definition'));
  }
});

async function pending() {
  const h = runtimeCloudHarness();
  const scope = await h.adapter.createSyntheticAccount({ config: { serviceUrl: 'https://service.example' },
    marker: h.environment.RUNTIME_DRILL_ID, stack: h.stack, deployment: h.deployment });
  await captureRuntimeWindow(h.io, scope);
  scope.recoverySourceCompleted = true;
  const payload = JSON.stringify([scope.email]);
  const operation = { run_scope: scope.runScope, purpose: 'lifecycle', action: 'set-testers', request_payload: payload,
    payload_sha256: payloadHash(payload), started_at: new Date().toISOString(), completed: false, deregistered: false };
  scope.oneShots.push(operation);
  scope.runtimeWindow.pending_write = { run_scope: scope.runScope, action: operation.action, one_shot_index: scope.oneShots.length - 1,
    before_policy: structuredClone(scope.runtimeWindow.expected),
    before_versions: Object.fromEntries(Object.entries(scope.runtimeWindow.expected).map(([key, value]) => [key, value.version])),
    request_payload: payload, started_at: operation.started_at, tester_hash: testerHash([scope.email]) };
  return { ...h, scope, operation };
}

test('pending no-start reconciliation requires exact unchanged SSM values/versions and matching authoritative DB audit', async () => {
  for (const boundary of ['none', 'value', 'version', 'database', 'payload']) {
    const h = await pending();
    const proof = await recoverOneShotRegistrations(h.io, h.scope);
    if (boundary === 'value') h.policy.tester_allowlist.Value = '["foreign@example.com"]';
    if (boundary === 'version') h.policy.admission_mode.Version++;
    if (boundary === 'database') h.io.auditRuntimeWindow = async () => ({ source: 'not-authoritative' });
    if (boundary === 'payload') h.scope.runtimeWindow.pending_write.request_payload = '["foreign@example.com"]';
    if (boundary === 'none') {
      await reconcilePendingPolicy(h.io, h.scope, proof);
      assert.equal(h.scope.runtimeWindow.pending_write, undefined);
      assert.equal(h.scope.runtimeWindow.write_ledger.at(-1).not_started, true);
    } else {
      await assert.rejects(reconcilePendingPolicy(h.io, h.scope, proof));
      assert.ok(h.scope.runtimeWindow.pending_write);
    }
    assert.ok(!h.mutations.some(({ operation }) => operation === 'one-shot-lifecycle-set-testers'));
    for (const { json } of h.writes) parseRuntimeRecovery(json);
  }
});

test('fresh recovery handles intent-before-helper, helper-intent and definition-before-launch loss using production orchestration', async () => {
  for (const boundary of ['policy-intent', 'helper-intent', 'definition']) {
    const h = runtimeCloudHarness();
    const scope = await h.adapter.createSyntheticAccount({ config: { serviceUrl: 'https://service.example' },
      marker: h.environment.RUNTIME_DRILL_ID, stack: h.stack, deployment: h.deployment });
    await captureRuntimeWindow(h.io, scope);
    const save = h.io.saveRecovery;
    let lost = false;
    h.io.saveRecovery = async (value) => {
      await save(value);
      const intent = value.runtimeWindow?.pending_write;
      const operation = value.oneShots?.[intent?.one_shot_index];
      if (!lost && intent && ((boundary === 'policy-intent' && intent.one_shot_index === undefined)
        || (boundary === 'helper-intent' && operation && !operation.task_definition_arn)
        || (boundary === 'definition' && operation?.task_definition_arn && !operation.task_arn))) {
        lost = true;
        throw new Error('mocked runner lost at durable boundary');
      }
    };
    await assert.rejects(activateRuntimeWindow(h.io, scope), /runner lost/);
    const record = parseRuntimeRecovery(h.uploads.at(-1).json);
    const originalTaskCount = h.tasks.size;
    const fresh = h.makeAdapter({ ...h.environment, GITHUB_RUN_ID: '456' });
    assert.equal((await fresh.adapter.recoverOwnedRuntime(record)).recovered, true);
    const final = parseRuntimeRecovery(h.writes.at(-1).json);
    assert.equal(final.runtime_window.restored, true);
    assert.ok(final.runtime_window.write_ledger.some((entry) => entry.not_started));
    assert.equal(final.runtime_window.pending_write, undefined);
    assert.ok(h.tasks.size > originalTaskCount);
    // Admission is a windowless mode record, so restoration is proven on the decision and
    // the exact tester list.
    assert.equal(h.policy.tester_allowlist.Value, h.baselinePolicy.tester_allowlist.Value);
    assert.equal(parseAdmissionMode(h.policy.admission_mode.Value).mode,
      parseAdmissionMode(h.baselinePolicy.admission_mode.Value).mode);
    for (const { json } of h.writes) parseRuntimeRecovery(json);
  }
});

test('a STOPPED exit-one helper reconciles only an exact nominal SSM write and authoritative DB agreement', async () => {
  for (const boundary of ['nominal', 'partial', 'retry-version', 'database']) {
    const h = await pending();
    h.scope.oneShots.pop();
    const payload = h.scope.runtimeWindow.pending_write.request_payload;
    const { operation } = await h.io.runLifecycle({ scope: h.scope, action: 'set-testers', payload });
    h.tasks.get(operation.task_arn).containers[0].exitCode = 1;
    if (boundary === 'partial') h.policy.admission_mode.Version--;
    if (boundary === 'retry-version') h.policy.admission_mode.Version++;
    if (boundary === 'database') h.io.auditRuntimeWindow = async () => ({ source: 'not-authoritative' });
    if (boundary === 'nominal') {
      await reconcilePendingPolicy(h.io, h.scope);
      assert.equal(h.scope.runtimeWindow.pending_write, undefined);
      assert.equal(h.scope.runtimeWindow.write_ledger.at(-1).extraction.exit_code, 1);
    } else {
      await assert.rejects(reconcilePendingPolicy(h.io, h.scope));
      assert.ok(h.scope.runtimeWindow.pending_write);
    }
  }
});
