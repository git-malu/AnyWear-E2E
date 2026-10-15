import assert from 'node:assert/strict';
import test from 'node:test';
import * as account from '../tests/support/account.ts';
import {
  BETA_RUN_SCOPE_PATTERN,
  MAX_ADDRESS_LOCAL_PART_LENGTH,
  SCOPED_WORKER_EMAIL_PATTERN,
  STABLE_WORKER_EMAIL_PATTERN,
  betaWorkerAddress,
  isBetaWorkerEmailForScope,
  isCapturedBetaWorkerEmail,
  scopedWorkerEmailPattern,
} from '../tests/support/beta-address.ts';

const environment = ['E2E_STAGE', 'E2E_WORKERS', 'E2E_WORKER_SLOT_OFFSET', 'E2E_ACCOUNT_RUN_SCOPE'];
const originalEnvironment = new Map(environment.map((name) => [name, process.env[name]]));

const runScope = '123456789-1-0123456789abcdef';
const stable = (slot) => `e2e-beta-worker-${slot}-chromium@anywear.local`;
const scoped = (slot, suffix) => `e2e-beta-${runScope}-${slot}-${suffix}@anywear.local`;

function restoreEnvironment() {
  for (const name of environment) {
    const originalValue = originalEnvironment.get(name);
    if (originalValue === undefined) delete process.env[name];
    else process.env[name] = originalValue;
  }
}

function configureBetaAttempt() {
  process.env.E2E_STAGE = 'beta';
  process.env.E2E_WORKERS = '1';
  delete process.env.E2E_WORKER_SLOT_OFFSET;
  process.env.E2E_ACCOUNT_RUN_SCOPE = runScope;
}

test('the scoped Beta worker family is the Service cleanup family with this run scope', () => {
  // The Service matches `^e2e-beta-${runScope}-[0-9]+-[a-f0-9]{8}@anywear\.local$`
  // and refuses a local part longer than 64 characters. This is that same
  // family with the worker slot held to the E2E slot domain, which is also the
  // shape the deployed runtime drill already mints.
  assert.equal(BETA_RUN_SCOPE_PATTERN.test(runScope), true);
  assert.equal(betaWorkerAddress(runScope, '0', 'a1b2c3d4'), scoped(0, 'a1b2c3d4'));
  assert.match(betaWorkerAddress(runScope, '7', '01234567'), SCOPED_WORKER_EMAIL_PATTERN);

  for (const [slot, suffix] of [['8', 'a1b2c3d4'], ['02', 'a1b2c3d4'], ['0', 'A1B2C3D4'], ['0', 'a1b2c3d'], ['0', 'a1b2c3d4e']]) {
    assert.throws(() => betaWorkerAddress(runScope, slot, suffix), /slot|suffix/, `${slot}/${suffix}`);
  }
  // A scope the Service cleanup capability could never address never becomes an
  // address: that identity could not be deleted by the captured-subject path.
  for (const scope of ['local-4242', '123-0-0123456789abcdef', '123-1-0123456789ABCDEF', '0123-1-0123456789abcdef']) {
    assert.throws(() => betaWorkerAddress(scope, '0', 'a1b2c3d4'), /Service-cleanable run scope/, scope);
  }
});

test('the address carries the full run scope and stays inside the Service limits', () => {
  // A 20-digit run id and a 6-digit attempt: the longest scope the Service accepts.
  const longest = `12345678901234567890-123456-${'a'.repeat(16)}`;
  const address = betaWorkerAddress(longest, '7', 'a1b2c3d4');
  assert.equal(address.split('@')[0].length, MAX_ADDRESS_LOCAL_PART_LENGTH);
  assert.equal(address, address.toLowerCase());
  assert.doesNotMatch(address, /\+/);
  assert.equal(isBetaWorkerEmailForScope(address, longest), true);
  // The scope is embedded verbatim, so a truncated or foreign scope never matches.
  assert.equal(address.includes(longest), true);
  assert.equal(isBetaWorkerEmailForScope(address, longest.slice(0, 33)), false);
  assert.throws(() => betaWorkerAddress(`${'1'.repeat(21)}-1-${'a'.repeat(16)}`, '0', 'a1b2c3d4'), /Service-cleanable run scope/);
});

test('every attempt address is unique per call, so no address is ever re-bound', () => {
  configureBetaAttempt();
  const addresses = Array.from({ length: 4 }, () => account.createWorkerAccount({ parallelIndex: 0 }, 'chromium').email);
  assert.equal(new Set(addresses).size, addresses.length);
  for (const address of addresses) {
    assert.equal(scopedWorkerEmailPattern(runScope).test(address), true);
    assert.equal(STABLE_WORKER_EMAIL_PATTERN.test(address), false);
  }
  restoreEnvironment();
});

test('the retained stable allowlist rows stay valid captured identities for historical artifacts', () => {
  // The two retained allowlist rows are still in the SSM allowlist, and a
  // pre-#129 account artifact still names them, so captured-identity deletion
  // and account recovery have to keep accepting them.
  for (const slot of [0, 7]) {
    assert.equal(isCapturedBetaWorkerEmail(stable(slot)), true);
    assert.equal(isBetaWorkerEmailForScope(stable(slot), runScope), true);
  }
  assert.equal(SCOPED_WORKER_EMAIL_PATTERN.test(stable(0)), false);
  for (const address of [
    stable(8),
    'e2e-beta-worker-2-firefox@anywear.local',
    'e2e-test-worker-2-chromium@anywear.local',
    'e2e-beta-worker-2-chromium@example.com',
    'e2e-beta-allowlist-123456789-1-0123456789abcdef-primary@anywear.local',
    'actual-tester@example.com',
  ]) assert.equal(isCapturedBetaWorkerEmail(address), false, address);

  // A scoped address belongs to exactly one run scope, and stays lowercase.
  assert.equal(isBetaWorkerEmailForScope(scoped(0, 'a1b2c3d4'), runScope), true);
  assert.equal(isBetaWorkerEmailForScope(scoped(0, 'a1b2c3d4'), '123456790-1-0123456789abcdef'), false);
  assert.equal(isBetaWorkerEmailForScope(scoped(0, 'a1b2c3d4').toUpperCase(), runScope), false);
  assert.equal(isBetaWorkerEmailForScope(`e2e-beta-${runScope}-0-a1b2c3d4e@anywear.local`, runScope), false);
  assert.equal(isBetaWorkerEmailForScope(`e2e-beta-${runScope}-8-a1b2c3d4@anywear.local`, runScope), false);
});

test('a Beta run whose scope is not Service-cleanable refuses account allocation', () => {
  process.env.E2E_STAGE = 'beta';
  process.env.E2E_WORKERS = '1';
  delete process.env.E2E_WORKER_SLOT_OFFSET;
  delete process.env.E2E_ACCOUNT_RUN_SCOPE;
  delete process.env.GITHUB_RUN_ID;
  delete process.env.GITHUB_RUN_ATTEMPT;
  assert.throws(() => account.createWorkerAccount({ parallelIndex: 0 }, 'chromium'), /Service-cleanable run scope/);
  process.env.GITHUB_RUN_ID = '123456789';
  process.env.GITHUB_RUN_ATTEMPT = '1';
  assert.match(account.createWorkerAccount({ parallelIndex: 0 }, 'chromium').email,
    /^e2e-beta-123456789-1-0000000000000000-0-[a-f0-9]{8}@anywear\.local$/);
  delete process.env.GITHUB_RUN_ID;
  delete process.env.GITHUB_RUN_ATTEMPT;
  restoreEnvironment();
});

test('no Cognito identity is ever adopted for an address that is already bound', () => {
  // Issue #129: the fixed-address reuse path adopted whatever subject already
  // owned the address, which is exactly what the Service refuses on the first
  // profile sync. The path is removed rather than left unreachable, so it cannot
  // be reactivated silently.
  assert.deepEqual(Object.keys(account).filter((name) => /reus|adopt|existing/i.test(name)), []);
  configureBetaAttempt();
  assert.notEqual(
    account.createWorkerAccount({ parallelIndex: 0 }, 'chromium').email,
    account.createWorkerAccount({ parallelIndex: 0 }, 'chromium').email,
  );
  restoreEnvironment();
});
