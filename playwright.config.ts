import { defineConfig, devices } from '@playwright/test';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.dirname(fileURLToPath(import.meta.url));

function configuredWorkers(): number | undefined {
  const raw = process.env.E2E_WORKERS;
  if (raw === undefined) return process.env.CI ? 1 : undefined;
  const workers = Number(raw);
  if (!Number.isInteger(workers) || workers < 1 || workers > 8) {
    throw new Error('E2E_WORKERS must be an integer between 1 and 8');
  }
  return workers;
}

function validateAccountBudget(workers: number | undefined): void {
  if (workers === undefined) return;
  const maxActiveAccounts = Number(process.env.E2E_MAX_ACTIVE_ACCOUNTS ?? workers);
  const raw = process.env.E2E_MAX_NEW_ACCOUNTS_PER_RUN ?? String(workers * 2);
  const maxNewAccounts = Number(raw);
  const maxQuarantinedAccounts = Number(process.env.E2E_MAX_QUARANTINED_ACCOUNTS ?? workers);
  if (!Number.isInteger(maxActiveAccounts) || maxActiveAccounts < workers) {
    throw new Error('E2E_MAX_ACTIVE_ACCOUNTS must be an integer at least E2E_WORKERS');
  }
  if (!Number.isInteger(maxNewAccounts) || maxNewAccounts < maxActiveAccounts) {
    throw new Error('E2E_MAX_NEW_ACCOUNTS_PER_RUN must be an integer at least E2E_WORKERS');
  }
  if (!Number.isInteger(maxQuarantinedAccounts) || maxQuarantinedAccounts < 1) {
    throw new Error('E2E_MAX_QUARANTINED_ACCOUNTS must be a positive integer');
  }
}

dotenv.config({ path: path.join(repositoryRoot, '.env') });

const workers = configuredWorkers();
validateAccountBudget(workers);

export default defineConfig({
  testDir: './tests',
  testIgnore: '**/controlled/**',
  globalSetup: './tests/support/deployed-environment.ts',
  outputDir: 'test-results',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers,
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.E2E_CLIENT_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
