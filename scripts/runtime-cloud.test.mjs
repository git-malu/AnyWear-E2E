import assert from 'node:assert/strict';
import test from 'node:test';
import { runtimeCloudHarness } from './fixtures/runtime-cloud-harness.mjs';
import { verifyRuntimeDrillEvidence } from './runtime-drill.mjs';
import { parseRuntimeRecovery } from './runtime-recovery.mjs';
import { MAX_RECOVERY_SNAPSHOTS } from './runtime-recovery-snapshots.mjs';
import { LIVE_RUNTIME_SOURCE_READY } from './runtime-source-readiness.mjs';
import { oneShotHarness } from './fixtures/runtime-one-shot-harness.mjs';

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
  for (const key of Object.keys(h.policy)) assert.equal(h.policy[key].Value, h.baselinePolicy[key].Value);
  for (const { taskDefinition, tags } of h.definitions.values()) {
    if (tags.length) assert.equal(taskDefinition.status, 'INACTIVE');
  }
}

for (const suspended of [false, true]) {
  test(`full production runtime orchestration measures durable saves (baseline suspended=${suspended})`, async (context) => {
    const h = runtimeCloudHarness({ suspended });
    const result = await h.execute();
    assert.equal(verifyRuntimeDrillEvidence(result, h.compatibility).passed, true);
    const final = parseRuntimeRecovery(h.writes.at(-1).json);
    verifyRestored(h, final);
    assert.equal(h.writes.length, suspended ? 205 : 200);
    assert.equal(h.uploads.length, h.writes.length);
    assert.ok(h.uploads.length + 1 <= MAX_RECOVERY_SNAPSHOTS + 1);
    assert.equal(final.one_shots.length, suspended ? 32 : 31);
    assert.equal(h.uploads.at(-1).name, `beta-runtime-recovery-123-1-${h.writes.length}`);
    assert.equal(LIVE_RUNTIME_SOURCE_READY, true);
    let cumulative = 0;
    context.diagnostic(JSON.stringify({ saves: h.writes.length, helpers: final.one_shots.length,
      bytes: Buffer.byteLength(h.writes.at(-1).json), maxBytes: verifySnapshots(h),
      phases: h.phases.map((entry) => ({ ...entry, cumulative: cumulative += entry.saves })) }));
  });

  test(`snapshot 150 interruption restores from last immutable artifact in a fresh run (suspended=${suspended})`, async (context) => {
    const h = runtimeCloudHarness({ suspended, originalUploadLimit: 150 });
    await assert.rejects(h.execute(), (error) => {
      assert.match(error.message, /Runtime execution failed in: admission-window restoration/);
      assert.match(error.cause.message, /Mocked original snapshot upload exhausted/);
      return true;
    });
    assert.equal(h.uploads.length, 150);
    const record = parseRuntimeRecovery(h.uploads.at(-1).json);
    const recovery = h.makeAdapter({ ...h.environment, GITHUB_RUN_ID: '124' });
    const beforeWrites = h.writes.length;
    const result = await recovery.adapter.recoverOwnedRuntime(record);
    assert.deepEqual(result, { recovered: true, run_scope: h.environment.RUNTIME_DRILL_RUN_SCOPE });
    const saves = h.writes.length - beforeWrites;
    assert.equal(saves, suspended ? 107 : 78);
    const recoveryUploads = h.uploads.filter((upload) => upload.name.startsWith('beta-runtime-recovery-124-1-'));
    assert.equal(recoveryUploads.length, saves);
    assert.ok(recoveryUploads.length + 1 <= MAX_RECOVERY_SNAPSHOTS + 1);
    assert.equal(recoveryUploads[0].name, 'beta-runtime-recovery-124-1-001');
    assert.equal(recoveryUploads.at(-1).name, `beta-runtime-recovery-124-1-${String(saves).padStart(3, '0')}`);
    const final = parseRuntimeRecovery(h.writes.at(-1).json);
    verifyRestored(h, final);
    assert.equal(final.one_shots.length, suspended ? 40 : 35);
    context.diagnostic(JSON.stringify({ saves, helpers: final.one_shots.length,
      bytes: Buffer.byteLength(h.writes.at(-1).json), maxBytes: verifySnapshots(h) }));
  });

  test(`durable artifact response loss still recovers exact helper proof in a fresh run (suspended=${suspended})`, async (context) => {
    const h = runtimeCloudHarness({ suspended, originalUploadResponseLossAt: 151 });
    await assert.rejects(h.execute(), (error) => {
      assert.match(error.message, /Runtime execution failed in: admission-window restoration/);
      assert.match(error.cause.message, /durable snapshot upload response lost/);
      return true;
    });
    assert.equal(h.uploads.at(-1).name, 'beta-runtime-recovery-123-1-151');
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
  await assert.rejects(h.io.runLifecycle({ scope, action: 'close', payload: '' }), /snapshot budget exhausted/);
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
  await assert.rejects(h.io.runLifecycle({ scope, action: 'close', payload: '' }), /snapshot upload exhausted/);
  assert.equal(h.uploads.length, 1);
  assert.equal(h.mutations.length, 0);
  verifySnapshots(h);
});

for (const boundary of ['retained-after-delete', 'post-delete-lookup-error', 'initially-absent-then-reappeared']) {
  test(`production recovery keeps Beta suspended without baseline restore on ${boundary}`, async () => {
    const h = runtimeCloudHarness({ originalUploadLimit: 150 });
    await assert.rejects(h.execute(), (error) => {
      assert.match(error.message, /Runtime execution failed in: admission-window restoration/);
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
    assert.equal(h.policy.admission_suspended.Value, 'true');
    const final = parseRuntimeRecovery(h.uploads.at(-1).json);
    assert.equal(final.owned_cleanup_completed, false);
    assert.equal(final.runtime_window.restored, false);
    assert.deepEqual(final.cognito_deletion_intent, record.users[0]);
    assert.ok(final.one_shots.some((operation) => !operation.deregistered));
    verifySnapshots(h);
  });
}
