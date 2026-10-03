import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export type AccountMode = 'worker' | 'ephemeral';
export type AccountStatus =
  | 'reserved'
  | 'provisioning'
  | 'in_use'
  | 'cleanup_pending'
  | 'deleted'
  | 'quarantined';

export interface AccountBudgetConfig {
  maxActiveAccounts: number;
  maxNewAccountsPerRun: number;
  maxQuarantinedAccounts: number;
}

interface AccountRecord {
  email: string;
  subject?: string;
  mode: AccountMode;
  status: AccountStatus;
  leaseId: string;
  leaseGeneration: string;
  createdAt: string;
  updatedAt: string;
  reason?: string;
}

interface AccountBudgetState {
  version: 1;
  runScope: string;
  config: AccountBudgetConfig;
  accounts: AccountRecord[];
}

const ACTIVE_STATUSES = new Set<AccountStatus>([
  'reserved',
  'provisioning',
  'in_use',
  'cleanup_pending',
  'quarantined',
]);

function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

export function accountBudgetConfig(workers: number): AccountBudgetConfig {
  const config = {
    maxActiveAccounts: positiveInteger('E2E_MAX_ACTIVE_ACCOUNTS', workers),
    maxNewAccountsPerRun: positiveInteger('E2E_MAX_NEW_ACCOUNTS_PER_RUN', workers * 2),
    maxQuarantinedAccounts: positiveInteger('E2E_MAX_QUARANTINED_ACCOUNTS', workers),
  };
  if (config.maxActiveAccounts < workers) {
    throw new Error('E2E_MAX_ACTIVE_ACCOUNTS must be at least E2E_WORKERS');
  }
  if (config.maxNewAccountsPerRun < config.maxActiveAccounts) {
    throw new Error('E2E_MAX_NEW_ACCOUNTS_PER_RUN must be at least E2E_MAX_ACTIVE_ACCOUNTS');
  }
  return config;
}

function budgetPath(): string {
  return process.env.E2E_ACCOUNT_BUDGET_PATH
    ?? path.join(process.cwd(), 'test-results', 'account-budget.json');
}

function configuredWorkers(): number {
  const value = Number(process.env.E2E_WORKERS ?? (process.env.CI ? 1 : 1));
  if (!Number.isInteger(value) || value < 1 || value > 8) {
    throw new Error('E2E_WORKERS must be an integer between 1 and 8');
  }
  return value;
}

export function accountRunScope(): string {
  return process.env.E2E_ACCOUNT_RUN_SCOPE
    ?? (process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT ?? '1'}-0000000000000000`
      : `local-${process.pid}`);
}

function now(): string {
  return new Date().toISOString();
}

async function acquireLock(lockPath: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  await mkdir(path.dirname(lockPath), { recursive: true });
  while (Date.now() < deadline) {
    try {
      const handle = await open(lockPath, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: now() }));
      await handle.close();
      return;
    } catch (error: unknown) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
      try {
        const lock = await stat(lockPath);
        if (Date.now() - lock.mtimeMs > 10 * 60_000) await rm(lockPath, { force: true });
      } catch (statError: unknown) {
        if (!(statError instanceof Error) || !('code' in statError) || statError.code !== 'ENOENT') throw statError;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`Timed out waiting for account budget lock: ${lockPath}`);
}

async function withLockedState<T>(operation: (state: AccountBudgetState) => Promise<T>): Promise<T> {
  const filePath = budgetPath();
  const lockPath = `${filePath}.lock`;
  await acquireLock(lockPath);
  try {
    let state: AccountBudgetState;
    try {
      state = JSON.parse(await readFile(filePath, 'utf8')) as AccountBudgetState;
    } catch (error: unknown) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
      state = { version: 1, runScope: accountRunScope(), config: accountBudgetConfig(configuredWorkers()), accounts: [] };
    }
    const expectedConfig = accountBudgetConfig(configuredWorkers());
    if (state.runScope !== accountRunScope()) {
      throw new Error('E2E account budget manifest belongs to a different run');
    }
    if (JSON.stringify(state.config) !== JSON.stringify(expectedConfig)) {
      throw new Error('E2E account budget configuration changed during a run');
    }
    const result = await operation(state);
    const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, filePath);
    return result;
  } finally {
    await rm(lockPath, { force: true });
  }
}

function activeCount(state: AccountBudgetState): number {
  return state.accounts.filter((account) => ACTIVE_STATUSES.has(account.status)).length;
}

function newAccountCount(state: AccountBudgetState): number {
  return state.accounts.length;
}

function quarantinedCount(state: AccountBudgetState): number {
  return state.accounts.filter((account) => account.status === 'quarantined').length;
}

export async function reserveAccount(
  email: string,
  mode: AccountMode,
  leaseGeneration: string,
): Promise<void> {
  await withLockedState(async (state) => {
    const existing = state.accounts.find((account) => account.email === email);
    if (existing && existing.status !== 'deleted') {
      if (existing.leaseGeneration !== leaseGeneration) {
        throw new Error(`Account already has an active lease: ${email}`);
      }
      return;
    }
    if (activeCount(state) >= state.config.maxActiveAccounts) {
      throw new Error('E2E active account budget exhausted; wait for cleanup or recovery');
    }
    if (newAccountCount(state) >= state.config.maxNewAccountsPerRun) {
      throw new Error('E2E new-account budget exhausted; deletion does not restore this quota');
    }
    const timestamp = now();
    state.accounts.push({
      email,
      mode,
      status: 'provisioning',
      leaseId: randomUUID(),
      leaseGeneration,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  });
}

export async function markAccountInUse(email: string): Promise<void> {
  await withLockedState(async (state) => {
    const account = state.accounts.find((entry) => entry.email === email);
    if (!account || account.status === 'deleted') throw new Error(`Unknown E2E account lease: ${email}`);
    account.status = 'in_use';
    account.updatedAt = now();
  });
}

export async function recordAccountSubject(email: string, subject: string): Promise<void> {
  await withLockedState(async (state) => {
    const account = state.accounts.find((entry) => entry.email === email);
    if (!account || account.status === 'deleted') throw new Error(`Unknown E2E account lease: ${email}`);
    if (account.subject && account.subject !== subject) {
      throw new Error(`E2E account subject changed for ${email}`);
    }
    account.subject = subject;
    account.updatedAt = now();
  });
}

export async function markAccountCleanupPending(email: string): Promise<void> {
  await withLockedState(async (state) => {
    const account = state.accounts.find((entry) => entry.email === email);
    if (!account || account.status === 'deleted') return;
    account.status = 'cleanup_pending';
    account.updatedAt = now();
  });
}

export async function markAccountDeleted(email: string): Promise<void> {
  await withLockedState(async (state) => {
    const account = state.accounts.find((entry) => entry.email === email);
    if (!account) return;
    account.status = 'deleted';
    account.updatedAt = now();
  });
}

export async function quarantineAccount(email: string, reason: string): Promise<void> {
  await withLockedState(async (state) => {
    const account = state.accounts.find((entry) => entry.email === email);
    if (!account || account.status === 'deleted') return;
    if (account.status !== 'quarantined' && quarantinedCount(state) >= state.config.maxQuarantinedAccounts) {
      throw new Error('E2E quarantine budget exhausted; operator recovery is required');
    }
    account.status = 'quarantined';
    account.reason = reason;
    account.updatedAt = now();
  });
}
