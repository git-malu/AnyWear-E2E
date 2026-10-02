import assert from 'node:assert/strict';
import { test } from 'node:test';
import { restoreBetaSession } from '../tests/support/beta-allowlist-session.ts';

function fixture({ suspended = true, failCleanup = false, failRestore = false } = {}) {
  const state = {
    runScope: '123-1-abcdef', serviceCommit: 'a'.repeat(40), imageDigest: `sha256:${'b'.repeat(64)}`,
    original: { testerEmails: [], admissionSuspended: suspended },
    identities: [{ email: 'e2e-beta-allowlist-123-1-abcdef-primary@anywear.local', sub: 'f'.repeat(36) }],
    objects: [{ bucket: 'beta-owned-fixture', key: 'wearable-items/subject/item/test.png' }], restored: false,
  };
  const calls = [];
  const io = {
    async oneShot(role, action, payload) {
      calls.push({ role, action, payload });
      if (role === 'tester-cleanup' && failCleanup) throw new Error('Synthetic work remains active');
      if (action === 'configure-testers' && failRestore) throw new Error('Policy restoration failed');
    },
    async deleteObject(bucket, key) { calls.push({ object: { bucket, key } }); },
    async deleteIdentity(email) { calls.push({ identity: email }); },
    async save() { calls.push({ saved: true }); },
  };
  return { state, calls, io };
}

test('cleanup failure retains account and S3 resources while restoring the original paused policy', async () => {
  const { state, calls, io } = fixture({ failCleanup: true });
  await assert.rejects(restoreBetaSession(state, io), /cleanup or original policy restoration failed/);
  assert.equal(state.restored, false);
  assert.deepEqual(calls.map(({ role, action }) => [role, action]), [
    ['lifecycle', 'close'], ['tester-cleanup', ''], ['lifecycle', 'configure-testers'], ['lifecycle', 'close'],
  ]);
  assert.equal(calls.find(({ action }) => action === 'configure-testers').payload, '[]');
});

test('successful cleanup removes only captured resources and restores the exact original active list once', async () => {
  const { state, calls, io } = fixture({ suspended: false });
  state.original.testerEmails = ['existing-tester@example.com'];
  await restoreBetaSession(state, io);
  assert.equal(state.restored, true);
  assert.deepEqual(calls.filter((call) => call.object), [{ object: state.objects[0] }]);
  assert.deepEqual(calls.filter((call) => call.identity), [{ identity: state.identities[0].email }]);
  assert.equal(calls.find(({ action }) => action === 'configure-testers').payload, '["existing-tester@example.com"]');
  const count = calls.length;
  await restoreBetaSession(state, io);
  assert.equal(calls.length, count);
});

test('policy restoration failure still attempts suspension and leaves a retryable snapshot', async () => {
  const { state, calls, io } = fixture({ failRestore: true });
  await assert.rejects(restoreBetaSession(state, io), /cleanup or original policy restoration failed/);
  assert.equal(state.restored, false);
  assert.deepEqual(calls.at(-1), { role: 'lifecycle', action: 'close', payload: undefined });
  assert.equal(calls.some((call) => call.saved), false);
});
