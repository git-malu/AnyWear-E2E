import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
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

// The eight stable Beta worker-pool rows (issue #213). The budget leases only these.
const workerAddress = (slot = 0) => `e2e-beta-worker-${slot}-chromium@anywear.local`;

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

test('a deleted pool address can be re-reserved with a fresh lease and subject', async () => {
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

  await reserveAccount(workerAddress(0), 'worker', 'lease-1');
  await markAccountDeleted(workerAddress(0));
  await reserveAccount(workerAddress(1), 'worker', 'lease-2');
  await markAccountDeleted(workerAddress(1));

  await assert.rejects(reserveAccount(workerAddress(0), 'worker', 'lease-3'), /new-account budget exhausted/);
  const manifest = JSON.parse(await readFile(process.env.E2E_ACCOUNT_BUDGET_PATH, 'utf8'));
  assert.equal(manifest.accounts.length, 2);
});

test('quarantine applies to the latest lease of a re-created pool address', async () => {
  await configureBudget();
  const email = workerAddress();

  await reserveAccount(email, 'worker', 'lease-1');
  await markAccountDeleted(email);
  await reserveAccount(email, 'worker', 'lease-2');
  await quarantineAccount(email, 'cleanup failed');

  const manifest = JSON.parse(await readFile(process.env.E2E_ACCOUNT_BUDGET_PATH, 'utf8'));
  assert.deepEqual(manifest.accounts.map(({ status }) => status), ['deleted', 'quarantined']);
});

test('a released attempt returns its pool address for a fresh lease generation', async () => {
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

test('a quarantined pool slot is never silently reused and never released', async () => {
  await configureBudget();
  const email = workerAddress();

  await reserveAccount(email, 'worker', 'lease-1');
  await quarantineAccount(email, 'teardown: identity is still present');
  const refusal = await reserveAccount(email, 'worker', 'lease-2').then(
    () => assert.fail('a quarantined slot must not be re-reserved'),
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

test('a depleted pool fails with the account-budget error instead of minting another address', async () => {
  await configureBudget();
  process.env.E2E_MAX_ACTIVE_ACCOUNTS = '2';
  process.env.E2E_MAX_QUARANTINED_ACCOUNTS = '2';
  for (const slot of [0, 1]) {
    await reserveAccount(workerAddress(slot), 'worker', `lease-${slot}`);
    await quarantineAccount(workerAddress(slot), 'teardown: identity is still present');
  }
  // Both leased rows are quarantined, so a retry has no address to take. The refusal is the
  // budget's own error; it is never a fresh synthetic address the allowlist does not list.
  for (const slot of [0, 1]) {
    const error = await reserveAccount(workerAddress(slot), 'worker', 'lease-retry').then(
      () => assert.fail('a depleted pool must refuse the attempt'),
      (thrown) => thrown,
    );
    assert.ok(error instanceof AccountLeaseRefusalError);
    assert.equal(error.code, 'E2E_ACCOUNT_LEASE_REFUSED');
  }
  const manifest = JSON.parse(await readFile(process.env.E2E_ACCOUNT_BUDGET_PATH, 'utf8'));
  assert.deepEqual(manifest.accounts.map(({ email, status }) => ({ email, status })), [
    { email: workerAddress(0), status: 'quarantined' },
    { email: workerAddress(1), status: 'quarantined' },
  ]);
});

test('the budget refuses a worker address outside the eight-row pool', async () => {
  await configureBudget();
  for (const email of [
    'e2e-beta-worker-8-chromium@anywear.local',
    'e2e-beta-worker-0-firefox@anywear.local',
    'e2e-beta-123456789-1-0123456789abcdef-0-a1b2c3d4@anywear.local',
    'e2e-functional-account@anywear.local',
  ]) {
    await assert.rejects(reserveAccount(email, 'worker', 'lease-foreign'), /leases only the eight Beta worker-pool addresses/, email);
  }
  await assert.rejects(readFile(process.env.E2E_ACCOUNT_BUDGET_PATH, 'utf8'), { code: 'ENOENT' });
});

test('a refused re-reservation is diagnosed, keeps its exact message, and writes nothing', async () => {
  await configureBudget();
  const email = workerAddress();

  await reserveAccount(email, 'worker', 'lease-1');
  await quarantineAccount(email, 'teardown: identity is still present');
  const before = await readFile(process.env.E2E_ACCOUNT_BUDGET_PATH, 'utf8');

  const error = await reserveAccount(email, 'worker', 'lease-2').then(
    () => assert.fail('a quarantined slot must not be re-reserved'),
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

test('six attempt reservations of two pool slots fit the per-run cap and the seventh still refuses', async () => {
  await configureBudget(6);
  process.env.E2E_MAX_ACTIVE_ACCOUNTS = '2';
  // Two slots, three attempts each; a retry re-leases its own slot's row.
  const addresses = [0, 1].flatMap((slot) => [0, 1, 2].map(() => workerAddress(slot)));

  for (const [index, address] of addresses.entries()) {
    await reserveAccount(address, 'worker', `lease-${index}`);
    await releaseWorkerAccount(address);
  }

  await assert.rejects(reserveAccount(workerAddress(0), 'worker', 'lease-overflow'), /new-account budget exhausted/);
  const manifest = JSON.parse(await readFile(process.env.E2E_ACCOUNT_BUDGET_PATH, 'utf8'));
  assert.equal(manifest.accounts.length, 6);
  assert.deepEqual(manifest.accounts.map(({ status }) => status), Array(6).fill('deleted'));
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
