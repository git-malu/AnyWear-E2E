import { expect, login, test } from './support/fixtures.js';
import { declareNoBusinessCleanup } from './support/attempt-cleanup-registry.js';

test.describe('Worker account smoke @smoke @full-stack', () => {
  test('signs in and reaches the dashboard and wardrobe', async ({ page, workerAccount }, testInfo) => {
    // This attempt creates no business resources, so it declares that explicitly:
    // the worker-lease teardown then releases the address on a committed
    // declaration instead of quarantining an undeclared attempt.
    declareNoBusinessCleanup(testInfo, { teardownResult: 'passed', reason: 'this attempt creates no business resources' });
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
