import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { createWorkerAccount } from '../tests/support/account.ts';
import {
  AccountLeaseRefusalError,
  accountBudgetConfig,
  markAccountDeleted,
  markAccountInUse,
  quarantineAccount,
  recordAccountSubject,
  releaseWorkerAccount,
  reserveAccount,
} from '../tests/support/account-budget.ts';

const environment = [
  'E2E_ACCOUNT_BUDGET_PATH',
  'E2E_ACCOUNT_RUN_SCOPE',
  'E2E_WORKERS',
  'E2E_STAGE',
  'E2E_WORKER_SLOT_OFFSET',
  'E2E_MAX_ACTIVE_ACCOUNTS',
  'E2E_MAX_NEW_ACCOUNTS_PER_RUN',
  'E2E_MAX_QUARANTINED_ACCOUNTS',
];
const originalEnvironment = new Map(environment.map((name) => [name, process.env[name]]));
const temporaryDirectories = [];

// The scoped Beta worker address (issue #129) embeds the run scope verbatim,
// because the Service's cleanup parser matches exactly this grammar.
const RUN_SCOPE = '123456789-1-0123456789abcdef';
const workerAddress = (slot = 0, suffix = 'a1b2c3d4') => `e2e-beta-${RUN_SCOPE}-${slot}-${suffix}@anywear.local`;
const workerAddressPattern = (slot) => new RegExp(`^e2e-beta-${RUN_SCOPE}-${slot}-[a-f0-9]{8}@anywear\\.local$`);

function restoreEnvironment() {
  for (const name of environment) {
    const originalValue = originalEnvironment.get(name);
    if (originalValue === undefined) delete process.env[name];
    else process.env[name] = originalValue;
  }
}

afterEach(async () => {
  restoreEnvironment();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test('worker slot allocation defaults to zero and an allocated offset preserves other captured slots', () => {
  process.env.E2E_STAGE = 'beta';
  process.env.E2E_WORKERS = '2';
  process.env.E2E_ACCOUNT_RUN_SCOPE = RUN_SCOPE;
  delete process.env.E2E_WORKER_SLOT_OFFSET;
  const first = createWorkerAccount({ parallelIndex: 0 }, 'chromium').email;
  const second = createWorkerAccount({ parallelIndex: 1 }, 'chromium').email;
  assert.match(first, workerAddressPattern(0));
  assert.match(second, workerAddressPattern(1));
  // Two attempts of the same slot never share an address, which is the whole
  // point of the scoped shape: a re-bound address reproduces issue #129's 409.
  assert.notEqual(first, createWorkerAccount({ parallelIndex: 0 }, 'chromium').email);
  process.env.E2E_WORKER_SLOT_OFFSET = '2';
  assert.match(createWorkerAccount({ parallelIndex: 0 }, 'chromium').email, workerAddressPattern(2));
  assert.match(createWorkerAccount({ parallelIndex: 1 }, 'chromium').email, workerAddressPattern(3));
  process.env.E2E_WORKER_SLOT_OFFSET = '6';
  assert.match(createWorkerAccount({ parallelIndex: 1 }, 'chromium').email, workerAddressPattern(7));
});

test('the Beta worker address is a Service-cleanable scoped address and never the retained stable row', () => {
  process.env.E2E_STAGE = 'beta';
  process.env.E2E_WORKERS = '2';
  delete process.env.E2E_WORKER_SLOT_OFFSET;
  process.env.E2E_ACCOUNT_RUN_SCOPE = RUN_SCOPE;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const address = createWorkerAccount({ parallelIndex: attempt % 2 }, 'chromium').email;
    // The Service matches `^e2e-beta-${runScope}-[0-9]+-[a-f0-9]{8}@anywear\.local$`
    // and refuses a local part longer than 64 characters.
    assert.match(address, /^e2e-beta-[1-9][0-9]{0,19}-[1-9][0-9]{0,5}-[a-f0-9]{16}-[0-7]-[a-f0-9]{8}@anywear\.local$/);
    assert.equal(address, address.toLowerCase());
    assert.doesNotMatch(address, /\+/);
    assert.ok(address.split('@')[0].length <= 64);
    assert.doesNotMatch(address, /^e2e-beta-worker-[0-7]-chromium@anywear\.local$/);
  }
  // A scope the Service cleanup capability could never address is refused here
  // rather than minting an identity no captured-subject deletion can reach.
  process.env.E2E_ACCOUNT_RUN_SCOPE = 'local-4242';
  assert.throws(() => createWorkerAccount({ parallelIndex: 0 }, 'chromium'), /Service-cleanable run scope/);
});

test('non-Beta stages keep their sanitized run-unique worker address', () => {
  process.env.E2E_STAGE = 'prod';
  process.env.E2E_WORKERS = '1';
  delete process.env.E2E_WORKER_SLOT_OFFSET;
  process.env.E2E_ACCOUNT_RUN_SCOPE = 'test-scope';
  assert.match(createWorkerAccount({ parallelIndex: 0 }, 'chromium').email,
    /^e2e-prod-test-scope-0-chromium-[a-f0-9]{8}@anywear\.local$/);
});

test('invalid offset, pool overflow and invalid parallel index refuse account allocation', () => {
  process.env.E2E_STAGE = 'beta';
  process.env.E2E_WORKERS = '2';
  for (const raw of ['', '-1', '7', '1.5', '02', '1e0', 'invalid']) {
    process.env.E2E_WORKER_SLOT_OFFSET = raw;
    assert.throws(() => createWorkerAccount({ parallelIndex: 0 }, 'chromium'), /SLOT_OFFSET/);
  }
  process.env.E2E_WORKER_SLOT_OFFSET = '6';
  process.env.E2E_WORKERS = '3';
  assert.throws(() => createWorkerAccount({ parallelIndex: 0 }, 'chromium'), /SLOT_OFFSET/);
  process.env.E2E_WORKERS = '2';
  for (const parallelIndex of [-1, 0.5, 2]) assert.throws(() => createWorkerAccount({ parallelIndex }, 'chromium'), /parallelIndex/);
});

async function configureBudget(maxNewAccountsPerRun = 2) {
  const directory = await mkdtemp(path.join(tmpdir(), 'anywear-account-budget-'));
  temporaryDirectories.push(directory);
  process.env.E2E_ACCOUNT_BUDGET_PATH = path.join(directory, 'account-budget.json');
  process.env.E2E_ACCOUNT_RUN_SCOPE = `test-${directory.slice(-8)}`;
  process.env.E2E_WORKERS = '1';
  process.env.E2E_MAX_ACTIVE_ACCOUNTS = '1';
  process.env.E2E_MAX_NEW_ACCOUNTS_PER_RUN = String(maxNewAccountsPerRun);
  process.env.E2E_MAX_QUARANTINED_ACCOUNTS = '1';
}

test('a deleted worker address can be re-reserved with a fresh lease and subject', async () => {
  await configureBudget();
  const email = workerAddress();

  await reserveAccount(email, 'worker', 'lease-1');
  await recordAccountSubject(email, 'subject-1');
  await markAccountDeleted(email);
  await reserveAccount(email, 'worker', 'lease-2');
  await recordAccountSubject(email, 'subject-2');
  await markAccountInUse(email);

  const manifest = JSON.parse(await readFile(process.env.E2E_ACCOUNT_BUDGET_PATH, 'utf8'));
  assert.equal(manifest.accounts.length, 2);
  assert.deepEqual(manifest.accounts.map(({ status, subject }) => ({ status, subject })), [
    { status: 'deleted', subject: 'subject-1' },
    { status: 'in_use', subject: 'subject-2' },
  ]);
  await assert.rejects(reserveAccount(email, 'worker', 'lease-3'), /already has an active lease/);
});

test('every attempt reservation consumes the per-run creation budget', async () => {
  await configureBudget(2);

  await reserveAccount(workerAddress(0, 'aaaaaaaa'), 'worker', 'lease-1');
  await markAccountDeleted(workerAddress(0, 'aaaaaaaa'));
  await reserveAccount(workerAddress(1, 'bbbbbbbb'), 'worker', 'lease-2');
  await markAccountDeleted(workerAddress(1, 'bbbbbbbb'));

  await assert.rejects(reserveAccount(workerAddress(0, 'cccccccc'), 'worker', 'lease-3'), /new-account budget exhausted/);
  const manifest = JSON.parse(await readFile(process.env.E2E_ACCOUNT_BUDGET_PATH, 'utf8'));
  assert.equal(manifest.accounts.length, 2);
});

test('quarantine applies to the latest lease of a re-created worker address', async () => {
  await configureBudget();
  const email = workerAddress();

  await reserveAccount(email, 'worker', 'lease-1');
  await markAccountDeleted(email);
  await reserveAccount(email, 'worker', 'lease-2');
  await quarantineAccount(email, 'cleanup failed');

  const manifest = JSON.parse(await readFile(process.env.E2E_ACCOUNT_BUDGET_PATH, 'utf8'));
  assert.deepEqual(manifest.accounts.map(({ status }) => status), ['deleted', 'quarantined']);
});

test('a released attempt returns its address to the pool for a fresh lease generation', async () => {
  await configureBudget();
  const email = workerAddress();

  await reserveAccount(email, 'worker', 'lease-1');
  await recordAccountSubject(email, 'subject-1');
  await markAccountInUse(email);
  await releaseWorkerAccount(email);
  await reserveAccount(email, 'worker', 'lease-2');
  await recordAccountSubject(email, 'subject-2');
  await markAccountInUse(email);

  const manifest = JSON.parse(await readFile(process.env.E2E_ACCOUNT_BUDGET_PATH, 'utf8'));
  assert.deepEqual(manifest.accounts.map(({ status, leaseGeneration, reason }) => ({ status, leaseGeneration, reason })), [
    { status: 'deleted', leaseGeneration: 'lease-1', reason: 'released after verified identity absence' },
    { status: 'in_use', leaseGeneration: 'lease-2', reason: undefined },
  ]);
  assert.notEqual(manifest.accounts[0].leaseId, manifest.accounts[1].leaseId);
});

test('a quarantined attempt is never silently reused and never released', async () => {
  await configureBudget();
  const email = workerAddress();

  await reserveAccount(email, 'worker', 'lease-1');
  await quarantineAccount(email, 'teardown: identity is still present');
  const refusal = await reserveAccount(email, 'worker', 'lease-2').then(
    () => assert.fail('a quarantined address must not be re-reserved'),
    (thrown) => thrown,
  );
  assert.match(refusal.message, /already has an active lease/);
  assert.equal(refusal.name, 'AccountLeaseRefusalError');
  await assert.rejects(releaseWorkerAccount(email), /quarantined and cannot be released/);

  const manifest = JSON.parse(await readFile(process.env.E2E_ACCOUNT_BUDGET_PATH, 'utf8'));
  assert.deepEqual(manifest.accounts.map(({ status, leaseGeneration }) => ({ status, leaseGeneration })), [
    { status: 'quarantined', leaseGeneration: 'lease-1' },
  ]);
});

test('a refused re-reservation is diagnosed, keeps its exact message, and writes nothing', async () => {
  await configureBudget();
  const email = workerAddress();

  await reserveAccount(email, 'worker', 'lease-1');
  await quarantineAccount(email, 'teardown: identity is still present');
  const before = await readFile(process.env.E2E_ACCOUNT_BUDGET_PATH, 'utf8');

  const error = await reserveAccount(email, 'worker', 'lease-2').then(
    () => assert.fail('a quarantined address must not be re-reserved'),
    (thrown) => thrown,
  );
  assert.ok(error instanceof AccountLeaseRefusalError);
  // Byte-for-byte: the guard's message text is the original defect string, so
  // existing evidence and log comparisons stay valid.
  assert.equal(error.message, 'Account already has an active lease: ' + email);
  assert.equal(error.name, 'AccountLeaseRefusalError');
  assert.equal(error.code, 'E2E_ACCOUNT_LEASE_REFUSED');
  assert.equal(error.email, email);
  assert.equal(error.leaseGeneration, 'lease-1');
  assert.equal(error.reason, 'teardown: identity is still present');
  // The refusal is a read-only diagnosis: the manifest is unchanged.
  assert.equal(await readFile(process.env.E2E_ACCOUNT_BUDGET_PATH, 'utf8'), before);
});

test('a refusal inside the same run scope is still an ordinary guard, not a reuse', async () => {
  await configureBudget();
  const email = workerAddress();

  await reserveAccount(email, 'worker', 'lease-1');
  await markAccountInUse(email);
  const error = await reserveAccount(email, 'worker', 'lease-2').then(
    () => assert.fail('a held lease must not be re-reserved'),
    (thrown) => thrown,
  );
  assert.equal(error.code, 'E2E_ACCOUNT_LEASE_REFUSED');
  assert.equal(error.leaseGeneration, 'lease-1');
  assert.equal(error.reason, undefined, 'a held lease carries no quarantine reason');
});

test('attempt-scoped reservations cover every retry of the configured workers', () => {
  // Two workers run in parallel and Playwright may add two retries, so the
  // per-run creation cap has to cover 2 x 3 attempts.
  delete process.env.E2E_MAX_NEW_ACCOUNTS_PER_RUN;
  delete process.env.E2E_MAX_ACTIVE_ACCOUNTS;
  delete process.env.E2E_MAX_QUARANTINED_ACCOUNTS;
  assert.deepEqual(accountBudgetConfig(2), { maxActiveAccounts: 2, maxNewAccountsPerRun: 6, maxQuarantinedAccounts: 2 });
});

test('six attempt reservations of two worker slots fit the per-run cap and the seventh still refuses', async () => {
  await configureBudget(6);
  process.env.E2E_MAX_ACTIVE_ACCOUNTS = '2';
  // Two slots, three attempts each, and a fresh address per attempt.
  const addresses = [0, 1].flatMap((slot) => [1, 2, 3].map((retry) => workerAddress(slot, String(retry).repeat(8))));

  for (const [index, address] of addresses.entries()) {
    await reserveAccount(address, 'worker', `lease-${index}`);
    await releaseWorkerAccount(address);
  }

  await assert.rejects(reserveAccount(workerAddress(0, 'ffffffff'), 'worker', 'lease-overflow'), /new-account budget exhausted/);
  const manifest = JSON.parse(await readFile(process.env.E2E_ACCOUNT_BUDGET_PATH, 'utf8'));
  assert.equal(manifest.accounts.length, 6);
  assert.deepEqual(manifest.accounts.map(({ status }) => status), Array(6).fill('deleted'));
});
