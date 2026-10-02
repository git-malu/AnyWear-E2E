import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertRecoveryBinding, parseBetaRecoveryManifest, recoverManifestResources } from '../tests/support/beta-allowlist-recovery.ts';

function manifest() {
  const scope = '36970278486-1-b8e457e661b346ad';
  const sub = '7442ec8e-5051-709b-e2ec-f1b3118f45a0';
  const email = `e2e-beta-allowlist-${scope}-primary@anywear.local`;
  return {
    schema_version: 1, record_type: 'anywear_beta_allowlist_recovery', stage: 'beta',
    aws_account_id: '650880818323', aws_region: 'ap-east-1', run_scope: scope,
    service_commit: 'a'.repeat(40), image_digest: `sha256:${'b'.repeat(64)}`, user_pool_id: 'ap-east-1_BetaPool',
    users: [{ sub, email }], cognito_users: [{ email, sub }],
    objects: [{ bucket: 'beta-owned-fixture', key: `wearable-items/${sub}/1fc92335-0042-4c7b-92cb-ce65645ff218/faad92f5-0a0b-4973-882a-216fb0682c54.png` }],
    cleanup_completed: false,
  };
}

test('recovery accepts actual UUID-shaped Cognito subjects and only their captured synthetic resources', () => {
  const value = manifest();
  assert.deepEqual(parseBetaRecoveryManifest(JSON.stringify(value)), value);
});

test('recovery rejects real users, unowned keys, extra secrets, duplicate identities, and wildcard keys', () => {
  const cases = [
    (value) => { value.users[0].email = 'actual-tester@example.com'; },
    (value) => { value.objects[0].key = value.objects[0].key.replace(value.users[0].sub, 'ffffffff-ffff-ffff-ffff-ffffffffffff'); },
    (value) => { value.password = 'must-never-appear'; },
    (value) => { value.users.push({ ...value.users[0] }); },
    (value) => { value.objects[0].key = 'wearable-items/*'; },
    (value) => { value.objects[0].key += '?X-Amz-Signature=invalid'; },
    (value) => { value.stage = 'prod'; },
    (value) => { delete value.cognito_users[0].sub; },
    (value) => { value.cognito_users[0].sub = 'ffffffff-ffff-ffff-ffff-ffffffffffff'; },
    (value) => { value.cognito_users = []; },
  ];
  for (const mutate of cases) {
    const value = manifest();
    mutate(value);
    assert.throws(() => parseBetaRecoveryManifest(JSON.stringify(value)));
  }
});

test('recovery rejects a mismatched deployment, identity pool, or bucket before any cleanup', () => {
  const value = manifest();
  const health = { status: 'ok', service_commit: value.service_commit, image_digest: value.image_digest, schema_version: 16 };
  assert.doesNotThrow(() => assertRecoveryBinding(value, health, value.user_pool_id, value.objects[0].bucket));
  assert.throws(() => assertRecoveryBinding(value, { ...health, service_commit: 'c'.repeat(40) }, value.user_pool_id, value.objects[0].bucket));
  assert.throws(() => assertRecoveryBinding(value, health, 'ap-east-1_OtherPool', value.objects[0].bucket));
  assert.throws(() => assertRecoveryBinding(value, health, value.user_pool_id, 'some-other-bucket'));
});

function io({ activeWork = false, suspended = true, policyChanged = false, identityReplaced = false } = {}) {
  const calls = [];
  let snapshots = 0;
  return {
    calls,
    async policy() {
      calls.push('policy');
      snapshots += 1;
      return { intake_open: 'false', admission_suspended: suspended ? 'true' : 'false',
        tester_allowlist: policyChanged && snapshots > 1 ? '[]' : '["existing@example.com"]' };
    },
    async verifyIdentity(email, sub) { calls.push({ verified: { email, sub } }); if (identityReplaced) throw new Error('Captured identity replaced'); },
    async cleanup() { calls.push('database'); if (activeWork) throw new Error('Active synthetic task'); },
    async deleteObject(bucket, key) { calls.push({ bucket, key }); },
    async deleteIdentity(email, sub) { calls.push({ email, sub }); },
  };
}

test('an active-task cleanup refusal preserves all S3 and Cognito resources and still checks unchanged policy', async () => {
  const boundary = io({ activeWork: true });
  await assert.rejects(recoverManifestResources(manifest(), boundary), /Beta recovery failed/);
  assert.deepEqual(boundary.calls, ['policy', { verified: manifest().cognito_users[0] }, 'database', 'policy']);
});

test('a Cognito ownership mismatch prevents database, S3, and identity cleanup while checking unchanged policy', async () => {
  const boundary = io({ identityReplaced: true });
  await assert.rejects(recoverManifestResources(manifest(), boundary), /Beta recovery failed/);
  assert.deepEqual(boundary.calls, ['policy', { verified: manifest().cognito_users[0] }, 'policy']);
});

test('recovery requires paused admission and detects a concurrent policy change', async () => {
  const active = io({ suspended: false });
  await assert.rejects(recoverManifestResources(manifest(), active), /requires suspended/);
  assert.deepEqual(active.calls, ['policy']);
  await assert.rejects(recoverManifestResources(manifest(), io({ policyChanged: true })), /Beta recovery failed/);
});

test('successful recovery deletes exact captured objects and synthetic identities without policy mutations', async () => {
  const value = manifest();
  const boundary = io();
  await recoverManifestResources(value, boundary);
  assert.deepEqual(boundary.calls, ['policy', { verified: value.cognito_users[0] }, 'database', value.objects[0], value.cognito_users[0], 'policy']);
});
