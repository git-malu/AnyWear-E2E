import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  cleanupWorkerAccounts,
  createServiceCleanupInputs,
  isAdmittedCleanupWorker,
  releaseWorkerLease,
  workerLeaseGateError,
} from '../tests/support/worker-cleanup.ts';
import { markRepairedWorkerAccounts, skippedWorkerAccounts } from './cleanup-worker-accounts.mjs';

const runScope = `123456789-1-${'a'.repeat(16)}`;
const workerEmail = `e2e-beta-${runScope}-0-a1b2c3d4@anywear.local`;
// The stable allowlist row a pre-#129 artifact still captures.
const stableWorkerEmail = 'e2e-beta-worker-0-chromium@anywear.local';
const subject = '10000000-0000-4000-8000-000000000001';
const immutableUsername = 'cognito-immutable-username';
const attempt = (overrides = {}) => ({
  email: workerEmail,
  subject,
  reserved: true,
  provisioned: true,
  // A committed business cleanup, so the routing cases below isolate the
  // identity/absence behaviour they are named for. `undeclared` is modelled
  // explicitly where it is under test.
  businessCleanup: { state: 'closed', teardownResult: 'passed' },
  ...overrides,
});

/** The same attempt with no business-cleanup declaration at all. */
const undeclaredAttempt = (overrides = {}) => {
  const declared = attempt(overrides);
  delete declared.businessCleanup;
  return declared;
};

function userNotFound() {
  return Object.assign(new Error('User does not exist.'), { name: 'UserNotFoundException' });
}

/**
 * Injected attempt transport. The first read is the ownership verification, the
 * second one is the absence readback; `retainedAfterDelete` models a delete that
 * was accepted while the identity is still readable.
 */
function attemptIo({
  present = true,
  identityEmail = workerEmail,
  identitySubject = subject,
  deleteError,
  retainedAfterDelete = false,
  readbackError,
} = {}) {
  const calls = [];
  let live = present;
  let reads = 0;
  return {
    calls,
    async getUser(username) {
      calls.push({ get: username });
      reads += 1;
      if (reads > 1 && readbackError) throw readbackError;
      if (reads > 1) live = retainedAfterDelete;
      if (!live) throw userNotFound();
      return { Username: immutableUsername, UserAttributes: [{ Name: 'email', Value: identityEmail }, { Name: 'sub', Value: identitySubject }] };
    },
    async deleteUser(username) {
      calls.push({ delete: username });
      if (deleteError) throw deleteError;
      live = false;
    },
    async releaseWorkerAccount(email) {
      calls.push({ release: email });
    },
    async retainWorkerAccount(email, reason) {
      calls.push({ retain: email, reason });
    },
  };
}


function manifest(accounts = [{ email: workerEmail, subject, mode: 'worker', status: 'cleanup_pending' }]) { return { version: 1, runScope, accounts }; }
/**
 * Injected cleanup transport. The first read is the ownership verification, the
 * second one is the absence readback; `retainedAfterDelete` models a deletion
 * that was accepted while the identity is still readable, and `readbackError`
 * models a read that cannot complete.
 */
function cleanupIo({ serviceCleanup = async () => {}, currentEmail = workerEmail, currentSubject = subject, retainedAfterDelete = false, readbackError } = {}) {
  const calls = [];
  let live = true;
  let reads = 0;
  return { calls,
    async runServiceCleanup(inputs) { calls.push({ service: inputs }); return serviceCleanup(inputs); },
    async getUser(email) {
      calls.push({ get: email });
      reads += 1;
      if (reads > 1) {
        if (readbackError) throw readbackError;
        live = retainedAfterDelete;
      }
      if (!live) throw userNotFound();
      return { Username: subject, UserAttributes: [{ Name: 'email', Value: currentEmail }, { Name: 'sub', Value: currentSubject }] };
    },
    async deleteUser(username) { calls.push({ delete: username }); live = false; },
  };
}

test('scoped worker cleanup transmits exact runScope and subject/email before Cognito deletion', async () => {
  const io = cleanupIo();
  const count = await cleanupWorkerAccounts(manifest([{ email: workerEmail, subject, mode: 'worker', status: 'cleanup_pending' }, { email: 'e2e-beta-123456789-1-a1b2c3d4@example.invalid', subject, mode: 'ephemeral', status: 'cleanup_pending' }]), io);
  const cleanupJson = JSON.stringify({ runScope, users: [{ sub: subject, email: workerEmail }] });
  assert.equal(count, 1); assert.deepEqual(io.calls, [{ service: { action: 'cleanup', emails: '[]', cleanup_json: cleanupJson } }, { get: workerEmail }, { delete: subject }, { get: workerEmail }]);
  assert.deepEqual(createServiceCleanupInputs(manifest()).cleanup_json, cleanupJson);
});

test('a pre-#129 stable allowlist row is still cleanable, but only for its own scope', async () => {
  // Historical artifacts name the retained rows and their identities are still
  // in Cognito, so a historical cleanup has to keep accepting them.
  assert.deepEqual(createServiceCleanupInputs(manifest([{ email: stableWorkerEmail, subject, mode: 'worker', status: 'cleanup_pending' }])).cleanup_json,
    JSON.stringify({ runScope, users: [{ sub: subject, email: stableWorkerEmail }] }));
  // A scoped address from another run is not this manifest's captured identity.
  for (const foreign of [
    `e2e-beta-123456790-1-${'a'.repeat(16)}-0-a1b2c3d4@anywear.local`,
    `e2e-beta-${runScope}-0-A1B2C3D4@anywear.local`,
    `e2e-beta-${runScope}-0-a1b2c3d4e@anywear.local`,
    `e2e-beta-${runScope}-0-a1b2c3d4@example.com`,
  ]) {
    assert.throws(() => createServiceCleanupInputs(manifest([{ email: foreign, subject, mode: 'worker', status: 'cleanup_pending' }])),
      /captured Beta worker emails and subjects/, foreign);
  }
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
  await assert.rejects(cleanupWorkerAccounts(manifest([{ email: workerEmail, mode: 'worker', status: 'cleanup_pending' }]), io), /captured Beta worker emails and subjects/); assert.deepEqual(io.calls, []);
});

test('an unproven retained record and a deleted record remain untouched', async () => {
  const io = cleanupIo();
  assert.equal(await cleanupWorkerAccounts(manifest([{ email: workerEmail, mode: 'worker', status: 'retained' }]), io), 0);
  assert.equal(await cleanupWorkerAccounts(manifest([{ email: workerEmail, subject, mode: 'worker', status: 'deleted' }]), io), 0); assert.deepEqual(io.calls, []);
});

test('a proven retained worker is repaired through the same request and absence readback', async () => {
  const io = cleanupIo();
  const count = await cleanupWorkerAccounts(manifest([{ email: workerEmail, subject, mode: 'worker', status: 'retained' }]), io);
  const cleanupJson = JSON.stringify({ runScope, users: [{ sub: subject, email: workerEmail }] });
  assert.equal(count, 1);
  assert.deepEqual(io.calls, [
    { service: { action: 'cleanup', emails: '[]', cleanup_json: cleanupJson } },
    { get: workerEmail }, { delete: subject }, { get: workerEmail },
  ]);
});

test('an unproven retained record never blocks a proven one in the same manifest', async () => {
  const io = cleanupIo();
  const count = await cleanupWorkerAccounts(manifest([
    { email: workerEmail, subject, mode: 'worker', status: 'retained' },
    { email: stableWorkerEmail, mode: 'worker', status: 'retained' },
  ]), io);
  assert.equal(count, 1);
  assert.deepEqual(JSON.parse(io.calls[0].service.cleanup_json), { runScope, users: [{ sub: subject, email: workerEmail }] });
});

test('a returned identity after deletion fails the repair', async () => {
  const io = cleanupIo({ retainedAfterDelete: true });
  await assert.rejects(cleanupWorkerAccounts(manifest([{ email: workerEmail, subject, mode: 'worker', status: 'retained' }]), io),
    /still present after deletion/);
  assert.equal(io.calls.filter((call) => call.delete).length, 1);
});

test('an unreadable absence readback fails closed', async () => {
  const io = cleanupIo({ readbackError: new Error('Cognito readback unavailable') });
  await assert.rejects(cleanupWorkerAccounts(manifest([{ email: workerEmail, subject, mode: 'worker', status: 'retained' }]), io),
    /Cognito readback unavailable/);
  assert.equal(io.calls.filter((call) => call.delete).length, 1);
});

test('a repaired retained record becomes deleted and keeps its reason', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'issue-142-mark-'));
  const names = ['E2E_ACCOUNT_BUDGET_PATH', 'E2E_ACCOUNT_RUN_SCOPE', 'E2E_WORKERS',
    'E2E_MAX_ACTIVE_ACCOUNTS', 'E2E_MAX_NEW_ACCOUNTS_PER_RUN'];
  const saved = names.map((name) => [name, process.env[name]]);
  try {
    process.env.E2E_ACCOUNT_BUDGET_PATH = path.join(directory, 'account-budget.json');
    process.env.E2E_ACCOUNT_RUN_SCOPE = runScope;
    process.env.E2E_WORKERS = '1';
    process.env.E2E_MAX_ACTIVE_ACCOUNTS = '1';
    process.env.E2E_MAX_NEW_ACCOUNTS_PER_RUN = '2';
    await writeFile(process.env.E2E_ACCOUNT_BUDGET_PATH, `${JSON.stringify({
      version: 1, runScope, config: { maxActiveAccounts: 1, maxNewAccountsPerRun: 2 },
      accounts: [{
        email: workerEmail, mode: 'worker', status: 'retained', subject,
        leaseId: 'lease-1', leaseGeneration: 'generation-1',
        createdAt: '2026-10-16T05:03:56.709Z', updatedAt: '2026-10-16T05:03:56.709Z',
        retainedReason: 'teardown: business cleanup partial',
        reconcileBy: '2026-10-17T05:03:56.709Z',
      }],
    })}\n`);
    const admitted = await markRepairedWorkerAccounts(manifest([{ email: workerEmail, subject, mode: 'worker', status: 'retained' }]));
    assert.equal(admitted.length, 1);
    const state = JSON.parse(await readFile(process.env.E2E_ACCOUNT_BUDGET_PATH, 'utf8'));
    assert.equal(state.accounts[0].status, 'deleted');
    // The retention reason and its bound are the trace of the teardown defect; the
    // terminal transition rewrites only the status and the timestamp.
    assert.equal(state.accounts[0].retainedReason, 'teardown: business cleanup partial');
    assert.equal(state.accounts[0].reconcileBy, '2026-10-17T05:03:56.709Z');
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test('a record left non-deleted is reported as skipped, an already deleted one is not', () => {
  const records = [
    { email: workerEmail, subject, mode: 'worker', status: 'retained' },
    { email: stableWorkerEmail, mode: 'worker', status: 'retained' },
    { email: `e2e-beta-${runScope}-1-b1c2d3e4@anywear.local`, subject, mode: 'worker', status: 'deleted' },
  ];
  const workerManifest = manifest(records);
  const admitted = records.filter((account) => isAdmittedCleanupWorker(account, workerManifest));
  assert.deepEqual(admitted.map((account) => account.email), [workerEmail]);
  // The unproven retained record is the only one the step leaves behind.
  assert.deepEqual(skippedWorkerAccounts(workerManifest, admitted).map((account) => account.email), [stableWorkerEmail]);
});

test('changed Cognito subject is retained after successful application cleanup', async () => {
  const io = cleanupIo({ currentSubject: '20000000-0000-4000-8000-000000000002' });
  await assert.rejects(cleanupWorkerAccounts(manifest(), io), /different Cognito identity/); assert.equal(io.calls.filter((call) => call.service).length, 1); assert.equal(io.calls.some((call) => call.delete), false);
});

test('one attempt verifies the captured identity, deletes it, reads absence back, and only then releases', async () => {
  const io = attemptIo();
  const disposition = await releaseWorkerLease(attempt(), io);
  assert.deepEqual(disposition, { email: workerEmail, scope: 'released', teardownResult: 'passed' });
  assert.deepEqual(io.calls, [
    { get: workerEmail },
    { delete: immutableUsername },
    { get: workerEmail },
    { release: workerEmail },
  ]);
  assert.equal(workerLeaseGateError(disposition), undefined);
});

test('a business cleanup that failed or was partial retains the attempt with its identity retained', async () => {
  const scenarios = [
    { outcome: { state: 'closed', teardownResult: 'failed', reason: 'teardown failed; undeleted wardrobe_item:item-1' }, teardownResult: 'failed', reason: /^teardown: business cleanup failed; teardown failed; undeleted wardrobe_item:item-1$/ },
    { outcome: { state: 'closed', teardownResult: 'failed' }, teardownResult: 'failed', reason: /^teardown: business cleanup failed$/ },
    { outcome: { state: 'closed', teardownResult: 'partial', reason: 'teardown partial; undeleted outfit:outfit-1' }, teardownResult: 'partial', reason: /^teardown: business cleanup partial; teardown partial; undeleted outfit:outfit-1$/ },
  ];
  for (const scenario of scenarios) {
    const io = attemptIo();
    const disposition = await releaseWorkerLease(attempt({ businessCleanup: scenario.outcome }), io);
    assert.equal(disposition.scope, 'retained');
    assert.equal(disposition.teardownResult, scenario.teardownResult);
    assert.match(disposition.reason, scenario.reason);
    // The identity is retained: no verification, no delete, no readback, no
    // release. Only the one retain record is written.
    assert.deepEqual(io.calls, [{ retain: workerEmail, reason: disposition.reason }]);
    assert.match(workerLeaseGateError(disposition).message, new RegExp(`teardown gate failed \\(${scenario.teardownResult}, retained\\)`));
  }
});

test('an attempt whose business cleanup is still open retains as partial with no Cognito call', async () => {
  const io = attemptIo({ present: false });
  const disposition = await releaseWorkerLease(attempt({ businessCleanup: { state: 'open' } }), io);
  assert.equal(disposition.scope, 'retained');
  assert.equal(disposition.teardownResult, 'partial');
  assert.match(disposition.reason, /the attempt's business cleanup did not commit/);
  assert.deepEqual(io.calls, [{ retain: workerEmail, reason: disposition.reason }]);
});

test('an undeclared attempt fails closed and retains without touching Cognito', async () => {
  const io = attemptIo({ present: false });
  const disposition = await releaseWorkerLease(undeclaredAttempt(), io);
  assert.equal(disposition.scope, 'retained');
  assert.equal(disposition.teardownResult, 'partial');
  assert.match(disposition.reason, /declared no business-cleanup outcome/);
  assert.deepEqual(io.calls, [{ retain: workerEmail, reason: disposition.reason }]);
});

test('an unreadable declaration read is undeclared, and an explicit none is not', async () => {
  const unreadable = attemptIo();
  unreadable.readAttemptBusinessCleanup = () => { throw new Error('registry unavailable'); };
  const blocked = await releaseWorkerLease(undeclaredAttempt(), unreadable);
  assert.equal(blocked.scope, 'retained');
  assert.match(blocked.reason, /declared no business-cleanup outcome/);
  assert.deepEqual(unreadable.calls, [{ retain: workerEmail, reason: blocked.reason }]);

  // The injected reader is the fixture wiring: it releases only on a committed
  // declaration, through the unchanged verify -> delete -> absence -> release path.
  const wired = attemptIo();
  wired.readAttemptBusinessCleanup = () => ({ state: 'none', teardownResult: 'passed', reason: 'no business resources' });
  const released = await releaseWorkerLease(undeclaredAttempt(), wired);
  assert.deepEqual(released, { email: workerEmail, scope: 'released', teardownResult: 'passed' });
  assert.deepEqual(wired.calls, [
    { get: workerEmail },
    { delete: immutableUsername },
    { get: workerEmail },
    { release: workerEmail },
  ]);
});

test('an attempt whose identity is already absent releases the address after the absence readback', async () => {
  const io = attemptIo({ present: false });
  const disposition = await releaseWorkerLease(attempt(), io);
  assert.equal(disposition.scope, 'released');
  assert.deepEqual(io.calls, [{ get: workerEmail }, { get: workerEmail }, { release: workerEmail }]);
});

test('refused ownership, failed deletion, a retained identity and an uncertain readback retain instead of releasing', async () => {
  const scenarios = [
    { name: 'ownership mismatch', options: { identitySubject: '20000000-0000-4000-8000-000000000002' }, teardownResult: 'failed', reason: /refused/ },
    { name: 'deletion failure', options: { deleteError: Object.assign(new Error('AccessDeniedException'), { name: 'AccessDeniedException' }) }, teardownResult: 'failed', reason: /refused/ },
    { name: 'identity retained after deletion', options: { retainedAfterDelete: true }, teardownResult: 'failed', reason: /still present/ },
    { name: 'uncertain absence readback', options: { readbackError: new Error('AccessDeniedException') }, teardownResult: 'partial', reason: /uncertain/ },
  ];
  for (const scenario of scenarios) {
    const io = attemptIo(scenario.options);
    const disposition = await releaseWorkerLease(attempt(), io);
    assert.equal(disposition.scope, 'retained', scenario.name);
    assert.equal(disposition.teardownResult, scenario.teardownResult, scenario.name);
    assert.match(disposition.reason, scenario.reason, scenario.name);
    assert.equal(io.calls.some((call) => call.release), false, scenario.name);
    assert.equal(io.calls.filter((call) => call.retain).length, 1, scenario.name);
    assert.equal(io.calls.find((call) => call.retain).retain, workerEmail, scenario.name);
    assert.equal(/[\r\n]/.test(disposition.reason), false, `${scenario.name}: sanitized reason`);
    assert.ok(disposition.reason.length <= 300, `${scenario.name}: bounded reason`);
    assert.match(workerLeaseGateError(disposition).message, /teardown gate failed \((failed|partial), retained\)/, scenario.name);
  }
});

test('a live identity is never reported terminal even when the address was leased again', async () => {
  const io = attemptIo({ identitySubject: '20000000-0000-4000-8000-000000000002', retainedAfterDelete: true });
  const disposition = await releaseWorkerLease(attempt(), io);
  assert.equal(disposition.scope, 'retained');
  assert.equal(io.calls.some((call) => call.delete), false, 'a foreign identity is never deleted');
  assert.equal(io.calls.some((call) => call.release), false, 'a live identity is never released');
});

test('an attempt that never confirmed ownership retains without touching Cognito', async () => {
  for (const overrides of [{ provisioned: false }, { subject: undefined }]) {
    const io = attemptIo();
    const disposition = await releaseWorkerLease(attempt(overrides), io);
    assert.equal(disposition.scope, 'retained');
    assert.equal(disposition.teardownResult, 'failed');
    assert.match(disposition.reason, /ownership is unverified/);
    assert.deepEqual(io.calls.map((call) => Object.keys(call)[0]), ['retain']);
  }
});

test('an attempt that never held the lease writes nothing', async () => {
  const io = attemptIo();
  const disposition = await releaseWorkerLease(undeclaredAttempt({ reserved: false, provisioned: false }), io);
  assert.deepEqual(disposition, { email: workerEmail, scope: 'none', teardownResult: 'passed' });
  assert.deepEqual(io.calls, []);
  assert.equal(workerLeaseGateError(disposition), undefined);
});

test('a refused retain record or a refused release write still reports the attempt retained', async () => {
  const refusedRetain = attemptIo({ retainedAfterDelete: true });
  refusedRetain.retainWorkerAccount = async (email, reason) => {
    refusedRetain.calls.push({ retain: email, reason });
    throw new Error('retained record could not be written');
  };
  const retained = await releaseWorkerLease(attempt(), refusedRetain);
  assert.equal(retained.scope, 'retained');
  assert.match(retained.reason, /retained record refused/);
  assert.equal(refusedRetain.calls.some((call) => call.release), false);

  const refusedRelease = attemptIo();
  refusedRelease.releaseWorkerAccount = async (email) => {
    refusedRelease.calls.push({ release: email });
    throw new Error('Account scope is retained pending reconcile and cannot be released');
  };
  const released = await releaseWorkerLease(attempt(), refusedRelease);
  assert.equal(released.scope, 'retained');
  assert.match(released.reason, /could not be released/);
  assert.deepEqual(refusedRelease.calls.at(-1), { release: workerEmail });
});
