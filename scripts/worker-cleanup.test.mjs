import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanupWorkerAccounts, createServiceCleanupInputs, releaseWorkerLease } from '../tests/support/worker-cleanup.ts';

const runScope = `123456789-1-${'a'.repeat(16)}`;
const workerEmail = 'e2e-beta-worker-0-chromium@anywear.local';
const subject = '10000000-0000-4000-8000-000000000001';

function manifest(accounts = [{ email: workerEmail, subject, mode: 'worker', status: 'cleanup_pending' }]) { return { version: 1, runScope, accounts }; }
function cleanupIo({ serviceCleanup = async () => {}, currentEmail = workerEmail, currentSubject = subject } = {}) {
  const calls = [];
  return { calls,
    async runServiceCleanup(inputs) { calls.push({ service: inputs }); return serviceCleanup(inputs); },
    async getUser(email) { calls.push({ get: email }); return { Username: subject, UserAttributes: [{ Name: 'email', Value: currentEmail }, { Name: 'sub', Value: currentSubject }] }; },
    async deleteUser(username) { calls.push({ delete: username }); },
  };
}

test('stable worker cleanup transmits exact runScope and subject/email before Cognito deletion', async () => {
  const io = cleanupIo();
  const count = await cleanupWorkerAccounts(manifest([{ email: workerEmail, subject, mode: 'worker', status: 'cleanup_pending' }, { email: 'e2e-beta-123456789-1-a1b2c3d4@example.invalid', subject, mode: 'ephemeral', status: 'cleanup_pending' }]), io);
  const cleanupJson = JSON.stringify({ runScope, users: [{ sub: subject, email: workerEmail }] });
  assert.equal(count, 1); assert.deepEqual(io.calls, [{ service: { action: 'cleanup', emails: '[]', cleanup_json: cleanupJson } }, { get: workerEmail }, { delete: subject }]);
  assert.deepEqual(createServiceCleanupInputs(manifest()).cleanup_json, cleanupJson);
});

test('failed subject-bound cleanup never reads or deletes a Cognito identity', async () => {
  const io = cleanupIo({ serviceCleanup: async () => { throw new Error('Service cleanup refused active resources'); } });
  await assert.rejects(cleanupWorkerAccounts(manifest(), io), /Service cleanup refused/); assert.equal(io.calls.length, 1); assert.equal(io.calls[0].get, undefined);
});

test('capability initiation failure defers cleanup without Cognito access', async () => {
  const io = cleanupIo({ serviceCleanup: async () => false });
  assert.equal(await cleanupWorkerAccounts(manifest(), io), undefined); assert.equal(io.calls.length, 1); assert.equal(io.calls[0].get, undefined);
});

test('malformed or subject-less worker identity fails closed before capability or Cognito calls', async () => {
  const io = cleanupIo();
  await assert.rejects(cleanupWorkerAccounts(manifest([{ email: workerEmail, mode: 'worker', status: 'cleanup_pending' }]), io), /captured stable worker emails and subjects/); assert.deepEqual(io.calls, []);
});

test('quarantined and deleted worker sets remain untouched', async () => {
  const io = cleanupIo();
  assert.equal(await cleanupWorkerAccounts(manifest([{ email: workerEmail, mode: 'worker', status: 'quarantined' }]), io), 0);
  assert.equal(await cleanupWorkerAccounts(manifest([{ email: workerEmail, subject, mode: 'worker', status: 'deleted' }]), io), 0); assert.deepEqual(io.calls, []);
});

test('changed Cognito subject is retained after successful application cleanup', async () => {
  const io = cleanupIo({ currentSubject: '20000000-0000-4000-8000-000000000002' });
  await assert.rejects(cleanupWorkerAccounts(manifest(), io), /different Cognito identity/); assert.equal(io.calls.filter((call) => call.service).length, 1); assert.equal(io.calls.some((call) => call.delete), false);
});

test('worker lease release is limited to provisioned accounts', async () => {
  const released = []; await releaseWorkerLease(workerEmail, true, true, async (email) => released.push(email)); await releaseWorkerLease(workerEmail, true, false, async (email) => released.push(email)); assert.deepEqual(released, [workerEmail]);
});
