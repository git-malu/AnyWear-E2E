import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cleanupWorkerAccounts,
  createServiceCleanupInputs,
  releaseWorkerLease,
  workerLeaseGateError,
} from '../tests/support/worker-cleanup.ts';
import { bindCleanupEnvironment } from './cleanup-worker-accounts.mjs';

const runScope = `123456789-1-${'a'.repeat(16)}`;
const workerEmail = 'e2e-beta-worker-0-chromium@anywear.local';
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
    async quarantineWorkerAccount(email, reason) {
      calls.push({ quarantine: email, reason });
    },
  };
}


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

test('a business cleanup that failed or was partial quarantines the attempt with its identity retained', async () => {
  const scenarios = [
    { outcome: { state: 'closed', teardownResult: 'failed', reason: 'teardown failed; undeleted wardrobe_item:item-1' }, teardownResult: 'failed', reason: /^teardown: business cleanup failed; teardown failed; undeleted wardrobe_item:item-1$/ },
    { outcome: { state: 'closed', teardownResult: 'failed' }, teardownResult: 'failed', reason: /^teardown: business cleanup failed$/ },
    { outcome: { state: 'closed', teardownResult: 'partial', reason: 'teardown partial; undeleted outfit:outfit-1' }, teardownResult: 'partial', reason: /^teardown: business cleanup partial; teardown partial; undeleted outfit:outfit-1$/ },
  ];
  for (const scenario of scenarios) {
    const io = attemptIo();
    const disposition = await releaseWorkerLease(attempt({ businessCleanup: scenario.outcome }), io);
    assert.equal(disposition.scope, 'quarantined');
    assert.equal(disposition.teardownResult, scenario.teardownResult);
    assert.match(disposition.reason, scenario.reason);
    // The identity is retained: no verification, no delete, no readback, no
    // release. Only the one quarantine record is written.
    assert.deepEqual(io.calls, [{ quarantine: workerEmail, reason: disposition.reason }]);
    assert.match(workerLeaseGateError(disposition).message, new RegExp(`teardown gate failed \\(${scenario.teardownResult}, quarantined\\)`));
  }
});

test('an attempt whose business cleanup is still open quarantines as partial with no Cognito call', async () => {
  const io = attemptIo({ present: false });
  const disposition = await releaseWorkerLease(attempt({ businessCleanup: { state: 'open' } }), io);
  assert.equal(disposition.scope, 'quarantined');
  assert.equal(disposition.teardownResult, 'partial');
  assert.match(disposition.reason, /the attempt's business cleanup did not commit/);
  assert.deepEqual(io.calls, [{ quarantine: workerEmail, reason: disposition.reason }]);
});

test('an undeclared attempt fails closed and quarantines without touching Cognito', async () => {
  const io = attemptIo({ present: false });
  const disposition = await releaseWorkerLease(undeclaredAttempt(), io);
  assert.equal(disposition.scope, 'quarantined');
  assert.equal(disposition.teardownResult, 'partial');
  assert.match(disposition.reason, /declared no business-cleanup outcome/);
  assert.deepEqual(io.calls, [{ quarantine: workerEmail, reason: disposition.reason }]);
});

test('an unreadable declaration read is undeclared, and an explicit none is not', async () => {
  const unreadable = attemptIo();
  unreadable.readAttemptBusinessCleanup = () => { throw new Error('registry unavailable'); };
  const blocked = await releaseWorkerLease(undeclaredAttempt(), unreadable);
  assert.equal(blocked.scope, 'quarantined');
  assert.match(blocked.reason, /declared no business-cleanup outcome/);
  assert.deepEqual(unreadable.calls, [{ quarantine: workerEmail, reason: blocked.reason }]);

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

test('refused ownership, failed deletion, a retained identity and an uncertain readback quarantine instead of releasing', async () => {
  const scenarios = [
    { name: 'ownership mismatch', options: { identitySubject: '20000000-0000-4000-8000-000000000002' }, teardownResult: 'failed', reason: /refused/ },
    { name: 'deletion failure', options: { deleteError: Object.assign(new Error('AccessDeniedException'), { name: 'AccessDeniedException' }) }, teardownResult: 'failed', reason: /refused/ },
    { name: 'identity retained after deletion', options: { retainedAfterDelete: true }, teardownResult: 'failed', reason: /still present/ },
    { name: 'uncertain absence readback', options: { readbackError: new Error('AccessDeniedException') }, teardownResult: 'partial', reason: /uncertain/ },
  ];
  for (const scenario of scenarios) {
    const io = attemptIo(scenario.options);
    const disposition = await releaseWorkerLease(attempt(), io);
    assert.equal(disposition.scope, 'quarantined', scenario.name);
    assert.equal(disposition.teardownResult, scenario.teardownResult, scenario.name);
    assert.match(disposition.reason, scenario.reason, scenario.name);
    assert.equal(io.calls.some((call) => call.release), false, scenario.name);
    assert.equal(io.calls.filter((call) => call.quarantine).length, 1, scenario.name);
    assert.equal(io.calls.find((call) => call.quarantine).quarantine, workerEmail, scenario.name);
    assert.equal(/[\r\n]/.test(disposition.reason), false, `${scenario.name}: sanitized reason`);
    assert.ok(disposition.reason.length <= 300, `${scenario.name}: bounded reason`);
    assert.match(workerLeaseGateError(disposition).message, /teardown gate failed \((failed|partial), quarantined\)/, scenario.name);
  }
});

test('a live identity is never reported terminal even when the address was leased again', async () => {
  const io = attemptIo({ identitySubject: '20000000-0000-4000-8000-000000000002', retainedAfterDelete: true });
  const disposition = await releaseWorkerLease(attempt(), io);
  assert.equal(disposition.scope, 'quarantined');
  assert.equal(io.calls.some((call) => call.delete), false, 'a foreign identity is never deleted');
  assert.equal(io.calls.some((call) => call.release), false, 'a live identity is never released');
});

test('an attempt that never confirmed ownership quarantines without touching Cognito', async () => {
  for (const overrides of [{ provisioned: false }, { subject: undefined }]) {
    const io = attemptIo();
    const disposition = await releaseWorkerLease(attempt(overrides), io);
    assert.equal(disposition.scope, 'quarantined');
    assert.equal(disposition.teardownResult, 'failed');
    assert.match(disposition.reason, /ownership is unverified/);
    assert.deepEqual(io.calls.map((call) => Object.keys(call)[0]), ['quarantine']);
  }
});

test('an attempt that never held the lease writes nothing', async () => {
  const io = attemptIo();
  const disposition = await releaseWorkerLease(undeclaredAttempt({ reserved: false, provisioned: false }), io);
  assert.deepEqual(disposition, { email: workerEmail, scope: 'none', teardownResult: 'passed' });
  assert.deepEqual(io.calls, []);
  assert.equal(workerLeaseGateError(disposition), undefined);
});

test('a refused quarantine record or a refused release write still reports the attempt quarantined', async () => {
  const refusedQuarantine = attemptIo({ retainedAfterDelete: true });
  refusedQuarantine.quarantineWorkerAccount = async (email, reason) => {
    refusedQuarantine.calls.push({ quarantine: email, reason });
    throw new Error('E2E quarantine budget exhausted; operator recovery is required');
  };
  const quarantined = await releaseWorkerLease(attempt(), refusedQuarantine);
  assert.equal(quarantined.scope, 'quarantined');
  assert.match(quarantined.reason, /quarantine record refused/);
  assert.equal(refusedQuarantine.calls.some((call) => call.release), false);

  const refusedRelease = attemptIo();
  refusedRelease.releaseWorkerAccount = async (email) => {
    refusedRelease.calls.push({ release: email });
    throw new Error('Account scope is quarantined and cannot be released');
  };
  const released = await releaseWorkerLease(attempt(), refusedRelease);
  assert.equal(released.scope, 'quarantined');
  assert.match(released.reason, /could not be released/);
  assert.deepEqual(refusedRelease.calls.at(-1), { release: workerEmail });
});

test('validated diagnostic tuple is copied to the operation environment and mismatches refuse', () => {
  const diagnostic = { service: { source_sha: 'a'.repeat(40), image_digest: `sha256:${'b'.repeat(64)}` }, capability: { state_machine_version_arn: 'arn:aws:states:ap-east-1:650880818323:stateMachine:beta-anywear-tester-cleanup:3' } };
  const bound = bindCleanupEnvironment({}, diagnostic);
  assert.equal(bound.E2E_CLEANUP_SERVICE_SOURCE_SHA, diagnostic.service.source_sha);
  assert.equal(bound.E2E_CLEANUP_SERVICE_IMAGE_DIGEST, diagnostic.service.image_digest);
  assert.equal(bound.BETA_CLEANUP_STATE_MACHINE_VERSION_ARN, diagnostic.capability.state_machine_version_arn);
  assert.throws(() => bindCleanupEnvironment({ E2E_CLEANUP_SERVICE_IMAGE_DIGEST: 'sha256:' + 'c'.repeat(64) }, diagnostic), /differs/);
});

test('cleanup state machine version is validated by shape, not pinned to one revision', () => {
  for (const version of [3, 4, 5, 12]) {
    const candidate = { service: { source_sha: 'a'.repeat(40), image_digest: `sha256:${'b'.repeat(64)}` }, capability: { state_machine_version_arn: `arn:aws:states:ap-east-1:650880818323:stateMachine:beta-anywear-tester-cleanup:${version}` } };
    assert.equal(bindCleanupEnvironment({}, candidate).BETA_CLEANUP_STATE_MACHINE_VERSION_ARN, candidate.capability.state_machine_version_arn);
  }
  for (const invalid of ['0', '01', 'x', '', '3-extra']) {
    const candidate = { service: { source_sha: 'a'.repeat(40), image_digest: `sha256:${'b'.repeat(64)}` }, capability: { state_machine_version_arn: `arn:aws:states:ap-east-1:650880818323:stateMachine:beta-anywear-tester-cleanup:${invalid}` } };
    assert.throws(() => bindCleanupEnvironment({}, candidate), /diagnostic|tuple/);
  }
  const foreign = { service: { source_sha: 'a'.repeat(40), image_digest: `sha256:${'b'.repeat(64)}` }, capability: { state_machine_version_arn: 'arn:aws:states:us-east-1:650880818323:stateMachine:other-machine:5' } };
  assert.throws(() => bindCleanupEnvironment({}, foreign), /diagnostic|tuple/);
});
