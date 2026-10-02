import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BetaAllowlistSession, buildBetaRecoveryManifest, restoreBetaSession } from '../tests/support/beta-allowlist-session.ts';

function fixture({ suspended = true, failCleanup = false, failRestore = false, failIdentity = false } = {}) {
  const state = {
    runScope: '123-1-abcdef1234567890', serviceCommit: 'a'.repeat(40), imageDigest: `sha256:${'b'.repeat(64)}`,
    original: { testerEmails: [], admissionSuspended: suspended },
    identities: [{ email: 'e2e-beta-allowlist-123-1-abcdef1234567890-primary@anywear.local', sub: '7442ec8e-5051-709b-e2ec-f1b3118f45a0' }],
    objects: [{ bucket: 'beta-owned-fixture', key: 'wearable-items/subject/item/test.png' }], restored: false,
  };
  const calls = [];
  const io = {
    async oneShot(role, action, payload) {
      calls.push({ role, action, payload });
      if (role === 'tester-cleanup' && failCleanup) throw new Error('Synthetic work remains active');
      if (action === 'configure-testers' && failRestore) throw new Error('Policy restoration failed');
    },
    async verifyIdentity(email, sub) {
      calls.push({ verified: { email, sub } });
      if (failIdentity) throw new Error('Captured identity was replaced');
    },
    async deleteObject(bucket, key) { calls.push({ object: { bucket, key } }); },
    async deleteIdentity(email, sub) { calls.push({ identity: { email, sub } }); },
    async save() { calls.push({ saved: true }); },
  };
  return { state, calls, io };
}

test('cleanup failure retains account and S3 resources while restoring the original paused policy', async () => {
  const { state, calls, io } = fixture({ failCleanup: true });
  await assert.rejects(restoreBetaSession(state, io), /cleanup or original policy restoration failed/);
  assert.equal(state.restored, false);
  assert.deepEqual(calls.filter((call) => call.role).map(({ role, action }) => [role, action]), [
    ['lifecycle', 'close'], ['tester-cleanup', ''], ['lifecycle', 'configure-testers'], ['lifecycle', 'close'],
  ]);
  assert.equal(calls.find(({ action }) => action === 'configure-testers').payload, '[]');
  assert.deepEqual(calls.filter((call) => call.verified), [{ verified: state.identities[0] }]);
  assert.equal(calls.some((call) => call.identity || call.object), false);
});

test('successful cleanup removes only captured resources and restores the exact original active list once', async () => {
  const { state, calls, io } = fixture({ suspended: false });
  state.original.testerEmails = ['existing-tester@example.com'];
  await restoreBetaSession(state, io);
  assert.equal(state.restored, true);
  assert.deepEqual(calls.filter((call) => call.object), [{ object: state.objects[0] }]);
  assert.deepEqual(calls.filter((call) => call.identity), [{ identity: state.identities[0] }]);
  assert.ok(calls.findIndex((call) => call.verified) < calls.findIndex((call) => call.role === 'tester-cleanup'));
  assert.equal(calls.find(({ action }) => action === 'configure-testers').payload, '["existing-tester@example.com"]');
  const count = calls.length;
  await restoreBetaSession(state, io);
  assert.equal(calls.length, count);
});

test('a replaced Cognito identity blocks all resource cleanup and still restores the original paused policy', async () => {
  const { state, calls, io } = fixture({ failIdentity: true });
  await assert.rejects(restoreBetaSession(state, io), /cleanup or original policy restoration failed/);
  assert.equal(state.restored, false);
  assert.equal(calls.some((call) => call.role === 'tester-cleanup' || call.identity || call.object), false);
  assert.deepEqual(calls.filter((call) => call.role), [
    { role: 'lifecycle', action: 'close', payload: undefined },
    { role: 'lifecycle', action: 'configure-testers', payload: '[]' },
    { role: 'lifecycle', action: 'close', payload: undefined },
  ]);
});

test('policy restoration failure still attempts suspension and leaves a retryable snapshot', async () => {
  const { state, calls, io } = fixture({ failRestore: true });
  await assert.rejects(restoreBetaSession(state, io), /cleanup or original policy restoration failed/);
  assert.equal(state.restored, false);
  assert.deepEqual(calls.at(-1), { role: 'lifecycle', action: 'close', payload: undefined });
  assert.equal(calls.some((call) => call.saved), false);
});

test('recovery manifest retains exact synthetic resources without the original tester list or credentials', () => {
  const { state } = fixture();
  state.original.testerEmails = ['private-tester@example.com'];
  const manifest = buildBetaRecoveryManifest(state, 'ap-east-1_BetaPool');
  assert.deepEqual(manifest.users, state.identities);
  assert.deepEqual(manifest.cognito_users, state.identities);
  assert.deepEqual(manifest.objects, state.objects);
  assert.equal(manifest.cleanup_completed, false);
  assert.equal(JSON.stringify(manifest).includes('private-tester@example.com'), false);
  assert.equal('original' in manifest, false);
  assert.equal('password' in manifest, false);
  assert.equal('authorization' in manifest, false);
});

test('uncreated probe identities without a captured subject never appear in the recovery manifest or cleanup', async () => {
  const { state, calls, io } = fixture();
  const captured = { ...state.identities[0] };
  state.identities.push({ email: `e2e-beta-allowlist-${state.runScope}-probe@anywear.local` });
  const manifest = buildBetaRecoveryManifest(state, 'ap-east-1_BetaPool');
  assert.deepEqual(manifest.users, [captured]);
  assert.deepEqual(manifest.cognito_users, [captured]);
  await restoreBetaSession(state, io);
  assert.deepEqual(calls.filter((call) => call.verified), [{ verified: captured }]);
  assert.deepEqual(calls.filter((call) => call.identity), [{ identity: captured }]);
});

test('unexpected unlisted signup is captured for recovery without granting it access or replacing an owned subject', async () => {
  const { state } = fixture();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'anywear-allowlist-state-'));
  const originalPath = process.env.BETA_ALLOWLIST_STATE_PATH;
  process.env.BETA_ALLOWLIST_STATE_PATH = path.join(directory, 'session.json');
  try {
    const session = new BetaAllowlistSession(state);
    const email = `e2e-beta-allowlist-${state.runScope}-unlisted@anywear.local`;
    const sub = '11111111-2222-3333-4444-555555555555';
    await session.recordIdentity(email, sub);
    assert.deepEqual(state.identities.at(-1), { email, sub });
    assert.deepEqual(state.original.testerEmails, []);
    assert.deepEqual(JSON.parse(await readFile(process.env.BETA_ALLOWLIST_STATE_PATH, 'utf8')).identities.at(-1), { email, sub });
    await assert.rejects(session.recordIdentity(email, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'), /must not be overwritten/);
    await assert.rejects(session.recordIdentity('real@example.com', sub), /Only current synthetic/);
    await assert.rejects(session.recordIdentity(`e2e-beta-allowlist-${state.runScope}-other@anywear.local`, sub), /Only current synthetic/);
    assert.deepEqual(state.identities.at(-1), { email, sub });
  } finally {
    if (originalPath === undefined) delete process.env.BETA_ALLOWLIST_STATE_PATH;
    else process.env.BETA_ALLOWLIST_STATE_PATH = originalPath;
    await rm(directory, { recursive: true, force: true });
  }
});
