import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findServiceCleanupRunId, serviceCleanupDispatchArgs } from '../tests/support/service-cleanup-dispatch.ts';
import { cleanupWorkerAccounts, createServiceCleanupInputs, releaseWorkerLease } from '../tests/support/worker-cleanup.ts';

const runScope = `123456789-1-${'a'.repeat(16)}`;
const workerEmail = 'e2e-beta-worker-0-chromium@anywear.local';
const subject = '10000000-0000-4000-8000-000000000001';

function manifest(accounts = [{ email: workerEmail, subject, mode: 'worker', status: 'cleanup_pending' }]) {
  return { version: 1, runScope, accounts };
}

function cleanupIo({ serviceCleanup = async () => {}, currentEmail = workerEmail, currentSubject = subject } = {}) {
  const calls = [];
  return {
    calls,
    async runServiceCleanup(inputs) { calls.push({ service: inputs }); await serviceCleanup(inputs); },
    async getUser(email) {
      calls.push({ get: email });
      return { Username: subject, UserAttributes: [
        { Name: 'email', Value: currentEmail },
        { Name: 'sub', Value: currentSubject },
      ] };
    },
    async deleteUser(username) { calls.push({ delete: username }); },
  };
}

test('stable worker cleanup transmits the exact runScope and subject/email pair before Cognito verification/deletion', async () => {
  const io = cleanupIo();
  const count = await cleanupWorkerAccounts(manifest([
    { email: workerEmail, subject, mode: 'worker', status: 'cleanup_pending' },
    { email: 'e2e-beta-123456789-1-a1b2c3d4@example.invalid', subject, mode: 'ephemeral', status: 'cleanup_pending' },
  ]), io);

  const cleanupJson = JSON.stringify({ runScope, users: [{ sub: subject, email: workerEmail }] });
  assert.equal(count, 1);
  assert.deepEqual(io.calls, [
    { service: { action: 'cleanup', emails: '[]', cleanup_json: cleanupJson } },
    { get: workerEmail },
    { delete: subject },
  ]);
  assert.deepEqual(createServiceCleanupInputs(manifest()).cleanup_json, cleanupJson);
});

test('Service transport sends cleanup_json only as an input to the protected workflow on main', () => {
  const cleanupJson = JSON.stringify({ runScope, users: [{ sub: subject, email: workerEmail }] });
  assert.deepEqual(serviceCleanupDispatchArgs({ action: 'cleanup', emails: '[]', cleanup_json: cleanupJson }), [
    'workflow', 'run', 'beta-testers.yml',
    '--repo', 'git-malu/AnyWear-Service',
    '--ref', 'main',
    '--raw-field', 'action=cleanup',
    '--raw-field', 'emails=[]',
    '--raw-field', `cleanup_json=${cleanupJson}`,
  ]);
});

test('Service workflow correlation selects the unique matching run after dispatch and ignores unrelated runs', () => {
  const dispatchedAt = '2026-10-04T12:00:00.000Z';
  const runs = [
    { databaseId: 1, createdAt: '2026-10-04T11:59:59.000Z', event: 'workflow_dispatch', headBranch: 'main', workflowName: 'Manage Beta Tester Allowlist', displayTitle: 'Beta tester allowlist: cleanup · @tester' },
    { databaseId: 2, createdAt: '2026-10-04T12:00:01.000Z', event: 'workflow_dispatch', headBranch: 'main', workflowName: 'Manage Beta Tester Allowlist', displayTitle: 'Beta tester allowlist: cleanup · @tester' },
    { databaseId: 3, createdAt: '2026-10-04T12:00:02.000Z', event: 'workflow_dispatch', headBranch: 'main', workflowName: 'Manage Beta Tester Allowlist', displayTitle: 'Beta tester allowlist: status · @tester' },
    { databaseId: 4, createdAt: '2026-10-04T12:00:03.000Z', event: 'workflow_dispatch', headBranch: 'feature', workflowName: 'Manage Beta Tester Allowlist', displayTitle: 'Beta tester allowlist: cleanup · @tester' },
    { databaseId: 5, createdAt: '2026-10-04T12:00:04.000Z', event: 'workflow_dispatch', headBranch: 'main', workflowName: 'Other workflow', displayTitle: 'Beta tester allowlist: cleanup · @tester' },
  ];
  assert.equal(findServiceCleanupRunId(runs, dispatchedAt), '2');
  assert.equal(findServiceCleanupRunId([], dispatchedAt), undefined);
});

test('Service workflow correlation rejects ambiguous candidates instead of watching an arbitrary run', () => {
  const first = { databaseId: 2, createdAt: '2026-10-04T12:00:01.000Z', event: 'workflow_dispatch', headBranch: 'main', workflowName: 'Manage Beta Tester Allowlist', displayTitle: 'Beta tester allowlist: cleanup · @tester' };
  const second = { ...first, databaseId: 3, createdAt: '2026-10-04T12:00:02.000Z' };
  assert.throws(() => findServiceCleanupRunId([first, second], '2026-10-04T12:00:00.000Z'), /Multiple Service workflow runs/);
});

test('failed subject-bound Service cleanup never reads or deletes a Cognito identity', async () => {
  const io = cleanupIo({ serviceCleanup: async () => { throw new Error('Service cleanup refused active resources'); } });
  await assert.rejects(cleanupWorkerAccounts(manifest(), io), /Service cleanup refused/);
  assert.deepEqual(io.calls, [{
    service: {
      action: 'cleanup',
      emails: '[]',
      cleanup_json: JSON.stringify({ runScope, users: [{ sub: subject, email: workerEmail }] }),
    },
  }]);
});

test('malformed or subject-less pre-existing stable identity fails closed before Service or Cognito calls', async () => {
  const io = cleanupIo();
  await assert.rejects(cleanupWorkerAccounts(manifest([
    { email: workerEmail, mode: 'worker', status: 'cleanup_pending' },
  ]), io), /captured stable worker emails and subjects/);
  assert.deepEqual(io.calls, []);
});

test('pre-existing identity quarantined during provisioning is excluded from cleanup and retained', async () => {
  const io = cleanupIo();
  const count = await cleanupWorkerAccounts(manifest([
    { email: workerEmail, mode: 'worker', status: 'quarantined' },
  ]), io);
  assert.equal(count, 0);
  assert.deepEqual(io.calls, []);
});

test('changed pre-existing Cognito identity is retained after successful Service cleanup', async () => {
  const io = cleanupIo({ currentSubject: '20000000-0000-4000-8000-000000000002' });
  await assert.rejects(cleanupWorkerAccounts(manifest(), io), /different Cognito identity/);
  assert.deepEqual(io.calls, [
    { service: {
      action: 'cleanup',
      emails: '[]',
      cleanup_json: JSON.stringify({ runScope, users: [{ sub: subject, email: workerEmail }] }),
    } },
    { get: workerEmail },
  ]);
});

test('deleted leases are excluded and an empty worker set does not dispatch cleanup', async () => {
  const io = cleanupIo();
  const count = await cleanupWorkerAccounts(manifest([
    { email: workerEmail, subject, mode: 'worker', status: 'deleted' },
  ]), io);
  assert.equal(count, 0);
  assert.deepEqual(io.calls, []);
});

test('successful worker provisioning releases its stable slot as cleanup_pending', async () => {
  const released = [];
  await releaseWorkerLease(workerEmail, true, true, async (email) => released.push(email));
  assert.deepEqual(released, [workerEmail]);
});

test('a pre-existing identity rejected during provisioning retains its quarantined lease', async () => {
  const released = [];
  await releaseWorkerLease(workerEmail, true, false, async (email) => released.push(email));
  assert.deepEqual(released, []);
  const io = cleanupIo();
  const count = await cleanupWorkerAccounts(manifest([
    { email: workerEmail, mode: 'worker', status: 'quarantined' },
  ]), io);
  assert.equal(count, 0);
  assert.deepEqual(io.calls, []);
});
