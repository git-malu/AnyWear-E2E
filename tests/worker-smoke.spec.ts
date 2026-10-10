import { expect, login, test } from './support/fixtures.js';

test.describe('Worker account smoke @smoke @full-stack', () => {
  test('signs in and reaches the dashboard and wardrobe', async ({ page, workerAccount }) => {
    await login(page, workerAccount);

    await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible({
      timeout: 10_000,
    });

    await page.goto('/wardrobe');
    await expect(page.getByRole('heading', { name: 'Wardrobe' })).toBeVisible({
      timeout: 10_000,
    });
  });
});
