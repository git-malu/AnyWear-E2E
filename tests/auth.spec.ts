import { expect, test } from '@playwright/test';
import {
  createTestAccount,
  deleteTestAccount,
  reserveTestAccount,
  registerAndLogin,
  requireEnvironment,
  type TestAccount,
} from './support/account.js';

test.describe('Authentication Flow @smoke @full-stack', () => {
  test.skip(process.env.E2E_PUBLIC_REGISTRATION_OPEN !== 'true',
    'Public registration is qualified by the controlled Beta allowlist suite when intake is closed');
  let account: TestAccount | undefined;

  test.beforeEach(async () => {
    requireEnvironment('USER_POOL_ID');
    requireEnvironment('VITE_COGNITO_CLIENT_ID');
    account = createTestAccount('auth');
    await reserveTestAccount(account, 'ephemeral');
  });

  test.afterEach(async () => {
    if (account) {
      await deleteTestAccount(account);
    }
  });

  test('registers, auto-confirms, and signs in a new user', async ({ page }) => {
    await registerAndLogin(page, account!);

    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible({
      timeout: 10_000,
    });
  });
});
