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
    test.setTimeout(120_000);

    page.on('dialog', async (dialog) => {
      await dialog.accept();
    });

    await page.goto('/wardrobe');
    await expect(page.getByRole('heading', { name: 'Wardrobe' })).toBeVisible();

    await page.getByRole('button', { name: 'Add Item' }).click();
    await expect(page.getByRole('heading', { name: 'Add Wardrobe Item' })).toBeVisible();

    await page.locator('input[type="file"]').setInputFiles(uploadFixture);
    await page.getByRole('button', { name: 'Upload & Auto-Tag' }).click();

    await expect(page.getByRole('heading', { name: 'Add Wardrobe Item' })).not.toBeVisible();
    await expect(page.getByText('Analyzing...')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Analyzing...')).not.toBeVisible({ timeout: 90_000 });

    const itemCardTitle = page.locator('main h3').first();
    await expect(itemCardTitle).toBeVisible();
    await itemCardTitle.click();
    await expect(page.getByRole('heading', { name: 'Item Details' })).toBeVisible();

    await page.getByPlaceholder('e.g. My favorite hoodie').fill('E2E Test Sweater');
    await page.getByPlaceholder('e.g. Top').fill('Jacket');
    await page.getByPlaceholder('e.g. Black, White').fill('Red');
    await page.getByPlaceholder('e.g. Cotton').fill('Cotton');
    await page.getByRole('button', { name: 'Save Changes' }).click();

    await expect(page.getByText('E2E Test Sweater')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/red.*cotton/i).first()).toBeVisible({ timeout: 5_000 });

    await page.getByText('E2E Test Sweater').click();
    await page.getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByText('Your wardrobe is empty.')).toBeVisible({ timeout: 10_000 });
  });
});
