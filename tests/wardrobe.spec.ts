import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import {
  createTestAccount,
  deleteTestAccount,
  registerAndLogin,
  requireEnvironment,
  type TestAccount,
} from './support/account.js';

const uploadFixture = fileURLToPath(new URL('./fixtures/dummy.png', import.meta.url));

test.describe('Wardrobe Management @full-stack', () => {
  let account: TestAccount | undefined;

  test.beforeEach(async ({ page }) => {
    requireEnvironment('USER_POOL_ID');
    requireEnvironment('VITE_COGNITO_CLIENT_ID');
    account = createTestAccount('wardrobe');
    await registerAndLogin(page, account);
  });

  test.afterEach(async () => {
    if (account) {
      await deleteTestAccount(account.email);
    }
  });

  test('adds, edits, and deletes a wardrobe item', async ({ page }) => {
    page.on('dialog', async (dialog) => {
      await dialog.accept();
    });

    await page.goto('/wardrobe');
    await expect(page.getByRole('heading', { name: 'Wardrobe' })).toBeVisible();

    await page.getByRole('button', { name: 'Add Item' }).click();
    await expect(page.getByRole('heading', { name: 'Add Wardrobe Item' })).toBeVisible();

    await page.locator('input[type="file"]').setInputFiles(uploadFixture);
    await page.getByPlaceholder('e.g. Tops, Pants, Shoes').fill('T-Shirt');
    await page.getByPlaceholder('e.g. Black, Blue').fill('Blue');
    await page.getByPlaceholder('e.g. Cotton, Denim').fill('Cotton');
    await page.getByRole('button', { name: 'Save Item' }).click();

    await expect(page.getByText('T-Shirt').first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/blue.*cotton/i).first()).toBeVisible({ timeout: 5_000 });

    await page.getByText('T-Shirt').first().click();
    await expect(page.getByRole('heading', { name: 'Edit Wardrobe Item' })).toBeVisible();

    await page.locator('div').filter({ hasText: /^Category$/ }).locator('input').fill('Jacket');
    await page.locator('div').filter({ hasText: /^Color$/ }).locator('input').fill('Red');
    await page.getByRole('button', { name: 'Save Changes' }).click();

    await expect(page.getByText('Jacket').first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/red.*cotton/i).first()).toBeVisible({ timeout: 5_000 });

    await page.getByText('Jacket').first().click();
    await page.getByRole('button', { name: 'Delete Item' }).click();
    await expect(page.getByText('Your wardrobe is empty.')).toBeVisible({ timeout: 10_000 });
  });
});
