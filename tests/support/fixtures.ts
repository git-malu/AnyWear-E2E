import { test as base } from '@playwright/test';
import {
  createWorkerAccount,
  deleteTestAccount,
  provisionConfirmedTestAccount,
  reserveTestAccount,
  type TestAccount,
} from './account.js';

type WorkerFixtures = {
  workerAccount: TestAccount;
};

export const test = base.extend<Record<never, never>, WorkerFixtures>({
  workerAccount: [async ({ browserName }, use, workerInfo) => {
    const account = createWorkerAccount(workerInfo, browserName);

    try {
      await reserveTestAccount(account, 'worker');
      await provisionConfirmedTestAccount(account);
      await use(account);
    } finally {
      await deleteTestAccount(account);
    }
  }, { scope: 'worker' }],
});

export { expect } from '@playwright/test';
export { login } from './account.js';
