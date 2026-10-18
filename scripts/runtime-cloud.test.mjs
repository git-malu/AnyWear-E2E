import assert from 'node:assert/strict';
import test from 'node:test';
import { runtimeCloudHarness } from './fixtures/runtime-cloud-harness.mjs';
import { verifyRuntimeDrillEvidence } from './runtime-drill.mjs';
import { parseRuntimeRecovery } from './runtime-recovery.mjs';
import { MAX_RECOVERY_SNAPSHOTS } from './runtime-recovery-snapshots.mjs';
import { LIVE_RUNTIME_SOURCE_READY } from './runtime-source-readiness.mjs';
import { oneShotHarness } from './fixtures/runtime-one-shot-harness.mjs';
import { parseAdmissionMode } from './beta-admission-mode.mjs';

function verifySnapshots(h) {
  let maxBytes = 0;
  for (const snapshot of h.writes) {
    const record = parseRuntimeRecovery(snapshot.json);
    assert.ok(record.one_shots.length <= 100);
    assert.equal(snapshot.options.mode, 0o600);
    assert.ok(!snapshot.json.includes('mocked-memory-only-token'));
    maxBytes = Math.max(maxBytes, Buffer.byteLength(snapshot.json));
  }
  for (const upload of h.uploads) {
    parseRuntimeRecovery(upload.json);
    assert.equal(upload.options.retentionDays, 90);
  }
  assert.equal(new Set(h.uploads.map((upload) => upload.name)).size, h.uploads.length);
  assert.ok(maxBytes <= 262_144);
  return maxBytes;
}

function verifyRestored(h, record) {
  assert.equal(record.runtime_control.restored, true);
  assert.equal(record.runtime_window.restored, true);
  assert.equal(record.owned_cleanup_completed, true);
  assert.ok(record.one_shots.every((operation) => operation.deregistered));
  // The admission record is windowless, so the restored decision and the tester list are
  // compared directly and must match the baseline.
  assert.equal(h.policy.tester_allowlist.Value, h.baselinePolicy.tester_allowlist.Value);
  assert.equal(parseAdmissionMode(h.policy.admission_mode.Value).mode,
    parseAdmissionMode(h.baselinePolicy.admission_mode.Value).mode);
  for (const { taskDefinition, tags } of h.definitions.values()) {
    if (tags.length) assert.equal(taskDefinition.status, 'INACTIVE');
  }
}

// The durable-save budget is exact, so the interruption point is derived from the run
// rather than remembered: it is the first save of the admission restoration phase, which
// one more snapshot then interrupts.
async function restorationBoundary(suspended) {
  const probe = runtimeCloudHarness({ suspended });
  await probe.execute();
  return probe.writes.length - probe.phases.at(-1).saves;
}

for (const suspended of [false, true]) {
  test(`full production runtime orchestration measures durable saves (baseline suspended=${suspended})`, async (context) => {
    const h = runtimeCloudHarness({ suspended });
    const result = await h.execute();
    assert.equal(verifyRuntimeDrillEvidence(result, h.compatibility).passed, true);
    const final = parseRuntimeRecovery(h.writes.at(-1).json);
    verifyRestored(h, final);
    // #145's upload-reservation consumer adds exactly two durable saves to this
    // drill — its own delta on the unrenamed tree was 198/203 -> 200/205 — so the
    // restored admission-mode counts carry the same +2 rather than the pre-#145
    // 220/249. The interruption points stay derived by `restorationBoundary`.
    assert.equal(h.writes.length, suspended ? 222 : 251);
    assert.equal(h.uploads.length, h.writes.length);
    assert.ok(h.uploads.length + 1 <= MAX_RECOVERY_SNAPSHOTS + 1);
    assert.equal(final.one_shots.length, suspended ? 35 : 40);
    assert.equal(h.uploads.at(-1).name, `beta-runtime-recovery-123-1-${h.writes.length}`);
    assert.equal(LIVE_RUNTIME_SOURCE_READY, true);
    let cumulative = 0;
    context.diagnostic(JSON.stringify({ saves: h.writes.length, helpers: final.one_shots.length,
      bytes: Buffer.byteLength(h.writes.at(-1).json), maxBytes: verifySnapshots(h),
      phases: h.phases.map((entry) => ({ ...entry, cumulative: cumulative += entry.saves })) }));
  });

  test(`restoration-boundary interruption restores from last immutable artifact in a fresh run (suspended=${suspended})`, async (context) => {
    const boundary = await restorationBoundary(suspended);
    const h = runtimeCloudHarness({ suspended, originalUploadLimit: boundary });
    await assert.rejects(h.execute(), (error) => {
      assert.match(error.message, /Runtime execution failed in: admission restoration/);
      assert.match(error.cause.message, /Mocked original snapshot upload exhausted/);
      return true;
    });
    assert.equal(h.uploads.length, boundary);
    const record = parseRuntimeRecovery(h.uploads.at(-1).json);
    const recovery = h.makeAdapter({ ...h.environment, GITHUB_RUN_ID: '124' });
    const beforeWrites = h.writes.length;
    const result = await recovery.adapter.recoverOwnedRuntime(record);
    assert.deepEqual(result, { recovered: true, run_scope: h.environment.RUNTIME_DRILL_RUN_SCOPE });
    const saves = h.writes.length - beforeWrites;
    assert.equal(saves, suspended ? 80 : 99);
    const recoveryUploads = h.uploads.filter((upload) => upload.name.startsWith('beta-runtime-recovery-124-1-'));
    assert.equal(recoveryUploads.length, saves);
    assert.ok(recoveryUploads.length + 1 <= MAX_RECOVERY_SNAPSHOTS + 1);
    assert.equal(recoveryUploads[0].name, 'beta-runtime-recovery-124-1-001');
    assert.equal(recoveryUploads.at(-1).name, `beta-runtime-recovery-124-1-${String(saves).padStart(3, '0')}`);
    const final = parseRuntimeRecovery(h.writes.at(-1).json);
    verifyRestored(h, final);
    assert.equal(final.one_shots.length, suspended ? 37 : 42);
    context.diagnostic(JSON.stringify({ boundary, saves, helpers: final.one_shots.length,
      bytes: Buffer.byteLength(h.writes.at(-1).json), maxBytes: verifySnapshots(h) }));
  });

  test(`durable artifact response loss still recovers exact helper proof in a fresh run (suspended=${suspended})`, async (context) => {
    const boundary = await restorationBoundary(suspended);
    const h = runtimeCloudHarness({ suspended, originalUploadResponseLossAt: boundary + 1 });
    await assert.rejects(h.execute(), (error) => {
      assert.match(error.message, /Runtime execution failed in: admission restoration/);
      assert.match(error.cause.message, /durable snapshot upload response lost/);
      return true;
    });
    assert.equal(h.uploads.at(-1).name, `beta-runtime-recovery-123-1-${String(boundary + 1).padStart(3, '0')}`);
    const record = parseRuntimeRecovery(h.uploads.at(-1).json);
    const before = h.uploads.length;
    const recovery = h.makeAdapter({ ...h.environment, GITHUB_RUN_ID: '125' });
    assert.equal((await recovery.adapter.recoverOwnedRuntime(record)).recovered, true);
    const final = parseRuntimeRecovery(h.uploads.at(-1).json);
    verifyRestored(h, final);
    const saves = h.uploads.length - before;
    assert.equal(h.uploads[before].name, 'beta-runtime-recovery-125-1-001');
    assert.ok(saves < MAX_RECOVERY_SNAPSHOTS);
    context.diagnostic(JSON.stringify({ saves, helpers: final.one_shots.length, maxBytes: verifySnapshots(h) }));
  });
}

test('hard snapshot exhaustion refuses file writes, uploads and subsequent owned helper mutation', async () => {
  const h = runtimeCloudHarness();
  const { scope } = oneShotHarness();
  for (let number = 0; number < MAX_RECOVERY_SNAPSHOTS; number++) await h.io.saveRecovery(scope);
  const beforeMutations = h.mutations.length;
  await assert.rejects(h.io.runLifecycle({ scope, action: 'suspend', payload: '' }), /snapshot budget exhausted/);
  assert.equal(h.writes.length, MAX_RECOVERY_SNAPSHOTS);
  assert.equal(h.uploads.length, MAX_RECOVERY_SNAPSHOTS);
  assert.equal(h.uploads.at(-1).name, 'beta-runtime-recovery-123-1-400');
  assert.equal(h.mutations.length, beforeMutations);
  assert.equal(parseRuntimeRecovery(h.uploads.at(-1).json).one_shots.length, 0);
  verifySnapshots(h);
});

test('an awaited recovery upload failure prevents starting the next owned helper', async () => {
  const h = runtimeCloudHarness({ originalUploadLimit: 1 });
  const { scope } = oneShotHarness();
  await h.io.saveRecovery(scope);
  await assert.rejects(h.io.runLifecycle({ scope, action: 'suspend', payload: '' }), /snapshot upload exhausted/);
  assert.equal(h.uploads.length, 1);
  assert.equal(h.mutations.length, 0);
  verifySnapshots(h);
});

for (const boundary of ['retained-after-delete', 'post-delete-lookup-error', 'initially-absent-then-reappeared']) {
  test(`production recovery keeps Beta suspended without baseline restore on ${boundary}`, async () => {
    const h = runtimeCloudHarness({ originalUploadLimit: await restorationBoundary(false) });
    await assert.rejects(h.execute(), (error) => {
      assert.match(error.message, /Runtime execution failed in: admission restoration/);
      assert.match(error.cause.message, /Mocked original snapshot upload exhausted/);
      return true;
    });
    const record = parseRuntimeRecovery(h.uploads.at(-1).json);
    const recovery = h.makeAdapter({ ...h.environment, GITHUB_RUN_ID: '126' });
    let lookups = 0;
    let deletes = 0;
    let terminalMutationCount;
    recovery.io.cognitoSend = async (command) => {
      assert.deepEqual(command.input, { UserPoolId: record.user_pool_id, Username: record.users[0].username });
      if (command.constructor.name === 'AdminDeleteUserCommand') { deletes++; return {}; }
      assert.equal(command.constructor.name, 'AdminGetUserCommand');
      lookups++;
      if (lookups === 1 && boundary === 'initially-absent-then-reappeared') {
        throw Object.assign(new Error('initially absent'), { name: 'UserNotFoundException' });
      }
      if (lookups === 2) {
        terminalMutationCount = h.mutations.length;
        if (boundary === 'post-delete-lookup-error') throw new Error('lookup unavailable');
      }
      return { Username: record.users[0].username, UserAttributes: [
        { Name: 'sub', Value: record.users[0].sub }, { Name: 'email', Value: record.users[0].email },
      ] };
    };
    await assert.rejects(recovery.adapter.recoverOwnedRuntime(record), /absence is not authoritative|lookup unavailable/);
    assert.equal(lookups, 2);
    assert.equal(deletes, boundary === 'initially-absent-then-reappeared' ? 0 : 1);
    assert.equal(h.mutations.length, terminalMutationCount);
    assert.equal(parseAdmissionMode(h.policy.admission_mode.Value).mode, 'closed');
    const final = parseRuntimeRecovery(h.uploads.at(-1).json);
    assert.equal(final.owned_cleanup_completed, false);
    assert.equal(final.runtime_window.restored, false);
    assert.deepEqual(final.cognito_deletion_intent, record.users[0]);
    assert.ok(final.one_shots.some((operation) => !operation.deregistered));
    verifySnapshots(h);
  });
}
