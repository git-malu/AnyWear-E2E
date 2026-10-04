import { test as base } from '@playwright/test';
import {
  createWorkerAccount,
  provisionConfirmedTestAccount,
  reserveTestAccount,
  type TestAccount,
} from './account.js';
import { markAccountCleanupPending } from './account-budget.js';
import { releaseWorkerLease } from './worker-cleanup.js';

type WorkerFixtures = {
  workerAccount: TestAccount;
};

export const test = base.extend<Record<never, never>, WorkerFixtures>({
  workerAccount: [async ({ browserName }, use, workerInfo) => {
    const account = createWorkerAccount(workerInfo, browserName);
    let reserved = false;
    let provisioned = false;

    try {
      await reserveTestAccount(account, 'worker');
      reserved = true;
      await provisionConfirmedTestAccount(account);
      provisioned = true;
      await use(account);
    } finally {
      await releaseWorkerLease(account.email, reserved, provisioned, markAccountCleanupPending);
    }
  }, { scope: 'worker' }],
});

export { expect } from '@playwright/test';
export { login } from './account.js';
