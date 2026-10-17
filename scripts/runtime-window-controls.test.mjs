import assert from 'node:assert/strict';
import test from 'node:test';
import { activateRuntimeWindow, captureRuntimeWindow, guardRuntimeWindow, pauseRuntimeWindow, restoreRuntimeWindow, testerHash } from './runtime-window-controls.mjs';
import { assertLiveRuntimeSourceReady, LIVE_RUNTIME_SOURCE_READY } from './runtime-source-readiness.mjs';

function windowHarness({ backlog = 0, dbMismatch = false, extraVersion = false } = {}) {
  const policy = { intake_open: { value: 'false', version: 1 }, admission_suspended: { value: 'true', version: 4 },
    tester_allowlist: { value: '["original@example.com"]', version: 2 } };
  const calls = [];
  const scope = { runScope: '123-1-aaaaaaaaaaaaaaaa', email: 'e2e-beta-123-1-aaaaaaaaaaaaaaaa-0-01234567@anywear.local' };
  const io = {
    async aws(args) { const key = args.at(-1).split('/').at(-1); return { Parameter: { Value: policy[key].value, Version: policy[key].version } }; },
    async saveRecovery() {},
    async auditRuntimeWindow({ request }) { return { schema_version: 1, source: 'durable-runtime-window-audit', binding: request,
      observed_at: '2026-10-05T01:00:00Z', current_rows: { active_tasks: backlog, unpublished_outbox: 0, manual_intervention_outbox: 0 },
      policy: { intake_open: dbMismatch, admission_suspended: policy.admission_suspended.value === 'true',
        tester_count: JSON.parse(policy.tester_allowlist.value).length, tester_allowlist_hash: testerHash(JSON.parse(policy.tester_allowlist.value)),
        updated_at: '2026-10-05T01:00:00Z' } }; },
    async runLifecycle({ action, payload }) {
      calls.push(action);
      if (action === 'configure-testers') { policy.tester_allowlist.value = payload; policy.tester_allowlist.version += 1;
        policy.admission_suspended.value = 'false'; policy.admission_suspended.version += extraVersion ? 3 : 2; }
      else { policy.admission_suspended.value = 'true'; policy.admission_suspended.version += 1; }
    },
  };
  return { scope, io, policy, calls };
}

test('private window uses one run-owned tester, nominal version ledger, and exact original-policy restore', async () => {
  const { scope, io, policy, calls } = windowHarness();
  await captureRuntimeWindow(io, scope);
  await activateRuntimeWindow(io, scope);
  assert.deepEqual(JSON.parse(policy.tester_allowlist.value), [scope.email]);
  assert.equal(policy.intake_open.value, 'false');
  assert.equal(scope.runtimeWindow.write_ledger[0].after_versions.admission_suspended, 6);
  await pauseRuntimeWindow(io, scope);
  scope.ownedCleanupCompleted = true;
  await restoreRuntimeWindow(io, scope);
  assert.equal(policy.tester_allowlist.value, '["original@example.com"]');
  assert.equal(policy.admission_suspended.value, 'true');
  assert.equal(scope.runtimeWindow.restored, true);
  assert.deepEqual(calls, ['configure-testers', 'close', 'configure-testers', 'close']);
});

test('DB backlog, DB/SSM mismatch, foreign write, and ambiguous non-nominal SDK write all fail closed', async () => {
  for (const options of [{ backlog: 1 }, { dbMismatch: true }]) {
    const { scope, io, calls } = windowHarness(options);
    await assert.rejects(captureRuntimeWindow(io, scope), /backlog/);
    assert.deepEqual(calls, []);
  }
  const foreign = windowHarness();
  await captureRuntimeWindow(foreign.io, foreign.scope);
  foreign.policy.tester_allowlist.version += 1;
  await assert.rejects(guardRuntimeWindow(foreign.io, foreign.scope), /Foreign/);
  assert.deepEqual(foreign.calls, []);
  const ambiguous = windowHarness({ extraVersion: true });
  await captureRuntimeWindow(ambiguous.io, ambiguous.scope);
  await assert.rejects(activateRuntimeWindow(ambiguous.io, ambiguous.scope), /non-nominal/);
  assert.ok(ambiguous.scope.runtimeWindow.pending_write);
  assert.equal(ambiguous.scope.runtimeWindow.write_ledger.length, 0);
});

test('independently reviewed source checkpoint permits protected execution', () => {
  assert.equal(LIVE_RUNTIME_SOURCE_READY, true);
  assert.doesNotThrow(assertLiveRuntimeSourceReady);
});
