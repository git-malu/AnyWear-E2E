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
  delete process.env.E2E_WORKER_SLOT_OFFSET;
  assert.equal(createWorkerAccount({ parallelIndex: 0 }, 'chromium').email, 'e2e-beta-worker-0-chromium@anywear.local');
  assert.equal(createWorkerAccount({ parallelIndex: 1 }, 'chromium').email, 'e2e-beta-worker-1-chromium@anywear.local');
  process.env.E2E_WORKER_SLOT_OFFSET = '2';
  assert.equal(createWorkerAccount({ parallelIndex: 0 }, 'chromium').email, 'e2e-beta-worker-2-chromium@anywear.local');
  assert.equal(createWorkerAccount({ parallelIndex: 1 }, 'chromium').email, 'e2e-beta-worker-3-chromium@anywear.local');
  process.env.E2E_WORKER_SLOT_OFFSET = '6';
  assert.equal(createWorkerAccount({ parallelIndex: 1 }, 'chromium').email, 'e2e-beta-worker-7-chromium@anywear.local');
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

test('a deleted stable worker email can be re-reserved with a fresh lease and subject', async () => {
  await configureBudget();
  const email = 'e2e-beta-worker-0-chromium@anywear.local';

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

test('retries using one stable address still consume the per-run creation budget', async () => {
  await configureBudget(2);
  const email = 'e2e-beta-worker-0-chromium@anywear.local';

  await reserveAccount(email, 'worker', 'lease-1');
  await markAccountDeleted(email);
  await reserveAccount(email, 'worker', 'lease-2');
  await markAccountDeleted(email);

  await assert.rejects(reserveAccount(email, 'worker', 'lease-3'), /new-account budget exhausted/);
  const manifest = JSON.parse(await readFile(process.env.E2E_ACCOUNT_BUDGET_PATH, 'utf8'));
  assert.equal(manifest.accounts.length, 2);
});

test('quarantine applies to the latest lease of a re-created stable address', async () => {
  await configureBudget();
  const email = 'e2e-beta-worker-0-chromium@anywear.local';

  await reserveAccount(email, 'worker', 'lease-1');
  await markAccountDeleted(email);
  await reserveAccount(email, 'worker', 'lease-2');
  await quarantineAccount(email, 'cleanup failed');

  const manifest = JSON.parse(await readFile(process.env.E2E_ACCOUNT_BUDGET_PATH, 'utf8'));
  assert.deepEqual(manifest.accounts.map(({ status }) => status), ['deleted', 'quarantined']);
});

test('a released attempt returns its address to the pool for a fresh lease generation', async () => {
  await configureBudget();
  const email = 'e2e-beta-worker-0-chromium@anywear.local';

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
  const email = 'e2e-beta-worker-0-chromium@anywear.local';

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
  const email = 'e2e-beta-worker-0-chromium@anywear.local';

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
  const email = 'e2e-beta-worker-0-chromium@anywear.local';

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

test('six attempt reservations of two worker addresses fit the per-run cap and the seventh still refuses', async () => {
  await configureBudget(6);
  process.env.E2E_MAX_ACTIVE_ACCOUNTS = '2';
  const emails = [0, 1].map((slot) => `e2e-beta-worker-${slot}-chromium@anywear.local`);

  for (let retry = 1; retry <= 3; retry += 1) {
    for (const email of emails) {
      await reserveAccount(email, 'worker', `lease-${retry}`);
      await releaseWorkerAccount(email);
    }
  }

  await assert.rejects(reserveAccount(emails[0], 'worker', 'lease-overflow'), /new-account budget exhausted/);
  const manifest = JSON.parse(await readFile(process.env.E2E_ACCOUNT_BUDGET_PATH, 'utf8'));
  assert.equal(manifest.accounts.length, 6);
  assert.deepEqual(manifest.accounts.map(({ status }) => status), Array(6).fill('deleted'));
});
