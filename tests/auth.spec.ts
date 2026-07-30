import { expect, test } from '@playwright/test';
import {
  createTestAccount,
  deleteTestAccount,
  registerAndLogin,
  requireEnvironment,
  type TestAccount,
} from './support/account.js';

test.describe('Authentication Flow @smoke @full-stack', () => {
  let account: TestAccount | undefined;

  test.beforeEach(() => {
    requireEnvironment('USER_POOL_ID');
    requireEnvironment('VITE_COGNITO_CLIENT_ID');
    account = createTestAccount('auth');
  });

  test.afterEach(async () => {
    if (account) {
      await deleteTestAccount(account.email);
    }
  });

  test('registers, auto-confirms, and signs in a new user', async ({ page }) => {
    await registerAndLogin(page, account!);

    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible({
      timeout: 10_000,
    });
  });
});
