import assert from 'node:assert/strict';
import test from 'node:test';
import { admissionWindowPayload } from './admission-window.mjs';
import { effectiveAdmissionMode } from './beta-admission-mode.mjs';
import { activateRuntimeWindow, captureRuntimeWindow, guardRuntimeWindow, pauseRuntimeWindow, restoreRuntimeWindow, testerHash } from './runtime-window-controls.mjs';
import { assertLiveRuntimeSourceReady, LIVE_RUNTIME_SOURCE_READY } from './runtime-source-readiness.mjs';

// A reader decides against its own clock, so a fixture window that models an open
// admission window must be live: its bound is measured from now.
const admissionRecord = (mode) => JSON.stringify(mode === 'closed' ? { mode } : { mode, expires_at: new Date(Date.now() + 60 * 60_000).toISOString() });

function windowHarness({ backlog = 0, dbMismatch = false, extraVersion = false, baselineMode = 'closed', baselineRecord } = {}) {
  const policy = { admission_mode: { value: baselineRecord ?? admissionRecord(baselineMode), version: 4 },
    tester_allowlist: { value: '["original@example.com"]', version: 2 } };
  const calls = [];
  const payloads = [];
  const scope = { runScope: '123-1-aaaaaaaaaaaaaaaa', email: 'e2e-beta-123-1-aaaaaaaaaaaaaaaa-0-01234567@anywear.local' };
  const io = {
    async aws(args) { const key = args.at(-1).split('/').at(-1); return { Parameter: { Value: policy[key].value, Version: policy[key].version } }; },
    async saveRecovery() {},
    async auditRuntimeWindow({ request }) { return { schema_version: 1, source: 'durable-runtime-window-audit', binding: request,
      observed_at: '2026-10-05T01:00:00Z', current_rows: { active_tasks: backlog, unpublished_outbox: 0, manual_intervention_outbox: 0 },
      policy: { admission_mode: dbMismatch ? (effectiveAdmissionMode(policy.admission_mode.value).mode === 'closed' ? 'testers' : 'closed')
        : effectiveAdmissionMode(policy.admission_mode.value).mode,
        tester_count: JSON.parse(policy.tester_allowlist.value).length, tester_allowlist_hash: testerHash(JSON.parse(policy.tester_allowlist.value)),
        updated_at: '2026-10-05T01:00:00Z' } }; },
    async runLifecycle({ action, payload }) {
      calls.push(action);
      payloads.push([action, payload]);
      // One mode parameter: a tester write moves the list only, and the mode moves only
      // for `resume`/`suspend`, exactly as the Service writer does.
      if (action === 'set-testers') { policy.tester_allowlist.value = payload; policy.tester_allowlist.version += 1; }
      else {
        policy.admission_mode.value = admissionRecord(action === 'suspend' ? 'closed' : 'testers');
        policy.admission_mode.version += extraVersion ? 2 : 1;
      }
    },
  };
  return { scope, io, policy, calls, payloads };
}

test('private window uses one run-owned tester, nominal mode deltas, and exact original-policy restore', async () => {
  const { scope, io, policy, calls, payloads } = windowHarness();
  await captureRuntimeWindow(io, scope);
  await activateRuntimeWindow(io, scope);
  assert.deepEqual(JSON.parse(policy.tester_allowlist.value), [scope.email]);
  // The tester write does not open admission; only `resume` does, it writes the mode once,
  // and it carries the bounded window request the Service requires.
  assert.deepEqual(calls, ['set-testers', 'resume']);
  assert.deepEqual(payloads, [['set-testers', JSON.stringify([scope.email])], ['resume', admissionWindowPayload()]]);
  assert.equal(scope.runtimeWindow.write_ledger[1].request_payload, admissionWindowPayload());
  assert.equal(scope.runtimeWindow.write_ledger[0].after_versions.admission_mode, 4);
  assert.equal(scope.runtimeWindow.write_ledger[0].after_versions.tester_allowlist, 3);
  assert.equal(scope.runtimeWindow.write_ledger[1].after_versions.admission_mode, 5);
  assert.equal(scope.runtimeWindow.write_ledger[1].after_versions.tester_allowlist, 3);
  assert.equal(JSON.parse(policy.admission_mode.value).mode, 'testers');
  await pauseRuntimeWindow(io, scope);
  scope.ownedCleanupCompleted = true;
  await restoreRuntimeWindow(io, scope);
  assert.equal(policy.tester_allowlist.value, '["original@example.com"]');
  assert.equal(policy.admission_mode.value, admissionRecord('closed'));
  assert.equal(scope.runtimeWindow.restored, true);
  // A repeated restoration is a read-only confirmation, never a second write sequence.
  await restoreRuntimeWindow(io, scope);
  assert.deepEqual(calls, ['set-testers', 'resume', 'suspend', 'set-testers']);
});

test('a baseline admission window is restored as the same decision and exact tester list', async () => {
  const { scope, io, policy, calls } = windowHarness({ baselineMode: 'testers' });
  await captureRuntimeWindow(io, scope);
  await activateRuntimeWindow(io, scope);
  await pauseRuntimeWindow(io, scope);
  scope.ownedCleanupCompleted = true;
  await restoreRuntimeWindow(io, scope);
  assert.deepEqual(calls, ['set-testers', 'resume', 'suspend', 'set-testers', 'resume']);
  assert.equal(policy.tester_allowlist.value, '["original@example.com"]');
  assert.equal(JSON.parse(policy.admission_mode.value).mode, 'testers');
  assert.equal(scope.runtimeWindow.restored, true);
  // Re-entry compares the restored decision and must not reopen or re-close the window.
  await restoreRuntimeWindow(io, scope);
  assert.deepEqual(calls, ['set-testers', 'resume', 'suspend', 'set-testers', 'resume']);
});

test('DB backlog, DB/SSM mismatch, foreign write, and ambiguous non-nominal SDK write all fail closed', async () => {
  for (const options of [{ backlog: 1 }, { dbMismatch: true }]) {
    const { scope, io, calls } = windowHarness(options);
    await assert.rejects(captureRuntimeWindow(io, scope), /backlog|mismatch/);
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
  assert.equal(ambiguous.scope.runtimeWindow.pending_write.action, 'resume');
  assert.deepEqual(ambiguous.scope.runtimeWindow.write_ledger.map((entry) => entry.action), ['set-testers']);
});

test('an abandoned window reads closed on both surfaces and pausing it writes nothing', async () => {
  // The mirror still carries `testers` with a bound that has passed. Every gate reads
  // closed, the Service reports closed, so the drift check agrees and no write is needed.
  const { scope, io, policy, calls } = windowHarness({
    baselineRecord: JSON.stringify({ mode: 'testers', expires_at: new Date(Date.now() - 1_000).toISOString() }) });
  await captureRuntimeWindow(io, scope);
  assert.equal(scope.runtimeWindow.baseline_mode, 'closed');
  await pauseRuntimeWindow(io, scope);
  assert.deepEqual(calls, []);
  await activateRuntimeWindow(io, scope);
  await pauseRuntimeWindow(io, scope);
  assert.deepEqual(calls, ['set-testers', 'resume', 'suspend']);
  scope.ownedCleanupCompleted = true;
  await restoreRuntimeWindow(io, scope);
  assert.equal(scope.runtimeWindow.restored, true);
  assert.equal(policy.tester_allowlist.value, '["original@example.com"]');
  // Restoring a decision the run found closed never reopens it.
  assert.deepEqual(calls, ['set-testers', 'resume', 'suspend', 'set-testers']);
});

test('independently reviewed source checkpoint permits protected execution', () => {
  assert.equal(LIVE_RUNTIME_SOURCE_READY, true);
  assert.doesNotThrow(assertLiveRuntimeSourceReady);
});
