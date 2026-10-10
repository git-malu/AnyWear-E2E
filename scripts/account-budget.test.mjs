import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { createWorkerAccount } from '../tests/support/account.ts';
import {
  markAccountDeleted,
  markAccountInUse,
  quarantineAccount,
  recordAccountSubject,
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
