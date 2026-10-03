import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
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
