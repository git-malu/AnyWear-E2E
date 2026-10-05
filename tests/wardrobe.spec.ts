import { expect, login, test } from './support/fixtures.js';
import { fileURLToPath } from 'node:url';
import {
  requireEnvironment,
} from './support/account.js';
import { isTerminalTaggingStatus } from './support/wardrobe-lifecycle.js';

const uploadFixture = fileURLToPath(new URL('./fixtures/dummy.png', import.meta.url));

interface WardrobeStatus {
  id: string;
  taggingStatus: string;
  taggingStateVersion: number;
}

test.describe('Wardrobe Management @full-stack', () => {
  // This scenario invokes the external VLM. A failed attempt must not be
  // repeated automatically; protected recovery owns non-terminal resources.
  test.describe.configure({ retries: 0 });

  let createdItemId: string | undefined;
  let authorization: string | undefined;
  let observedTerminalState = false;

  test.beforeEach(async ({ page, workerAccount }) => {
    requireEnvironment('USER_POOL_ID');
    requireEnvironment('VITE_COGNITO_CLIENT_ID');
    createdItemId = undefined;
    authorization = undefined;
    observedTerminalState = false;
    await login(page, workerAccount);
  });

  test.afterEach(async ({ page }) => {
    if (createdItemId && authorization && observedTerminalState) {
      const response = await page.request.delete(
        `${requireEnvironment('E2E_SERVICE_URL')}/wardrobe/items/${createdItemId}`,
        { headers: { Authorization: authorization } },
      );
      expect([200, 404]).toContain(response.status());
    }
  });

  test('recovers an idempotent auto-tag request across reloads and browser pages, then edits and deletes it', async ({ page, context }) => {
    test.setTimeout(180_000);

    page.on('dialog', async (dialog) => {
      await dialog.accept();
    });

    await page.goto('/wardrobe');
    await expect(page.getByRole('heading', { name: 'Wardrobe' })).toBeVisible();

    await page.getByRole('button', { name: 'Add Item' }).click();
    await expect(page.getByRole('heading', { name: 'Add Wardrobe Item' })).toBeVisible();

    await page.locator('input[type="file"]').setInputFiles(uploadFixture);
    const uploaded = page.waitForResponse((response) => (
      new URL(response.url()).pathname === '/wardrobe/upload-url'
      && response.request().method() === 'POST'
    ));
    const confirmed = page.waitForResponse((response) => (
      new URL(response.url()).pathname === '/wardrobe/upload'
      && response.request().method() === 'POST'
    ));
    await page.getByRole('button', { name: 'Upload & Auto-Tag' }).click();

    const uploadedResponse = await uploaded;
    expect(uploadedResponse.status()).toBe(200);
    createdItemId = ((await uploadedResponse.json()) as { itemId: string }).itemId;
    authorization = await uploadedResponse.request().headerValue('authorization') ?? undefined;
    expect(createdItemId).toBeTruthy();
    expect(authorization).toBeTruthy();

    const confirmedResponse = await confirmed;
    expect(confirmedResponse.status()).toBe(202);
    const accepted = await confirmedResponse.json();
    expect(accepted).toEqual({ itemId: createdItemId, taggingStatus: 'processing' });
    const idempotencyKey = await confirmedResponse.request().headerValue('idempotency-key');
    expect(idempotencyKey).toBeTruthy();
    const headers = { Authorization: authorization!, 'Idempotency-Key': idempotencyKey! };
    const serviceUrl = requireEnvironment('E2E_SERVICE_URL');

    const replay = await page.request.post(`${serviceUrl}/wardrobe/upload`, {
      headers,
      data: { itemId: createdItemId },
    });
    expect(replay.status()).toBe(202);
    expect(await replay.json()).toEqual(accepted);

    await expect(page.getByRole('heading', { name: 'Add Wardrobe Item' })).not.toBeVisible();
    const observer = await context.newPage();
    await Promise.all([page.reload(), observer.goto('/wardrobe')]);
    await expect(observer.getByRole('heading', { name: 'Wardrobe' })).toBeVisible();

    let latest: WardrobeStatus | undefined;
    let lastVersion = 0;
    await expect.poll(async () => {
      const response = await page.request.get(`${serviceUrl}/wardrobe/items/${createdItemId}`, { headers });
      expect(response.status()).toBe(200);
      latest = await response.json() as WardrobeStatus;
      expect(latest.id).toBe(createdItemId);
      expect(latest.taggingStateVersion).toBeGreaterThanOrEqual(lastVersion);
      lastVersion = latest.taggingStateVersion;
      observedTerminalState = isTerminalTaggingStatus(latest.taggingStatus);
      return latest.taggingStatus;
    }, { timeout: 120_000, intervals: [1_000, 2_000, 5_000] }).toBe('ready');

    for (const viewer of [page, observer]) {
      await expect(viewer.getByText('Analyzing...')).not.toBeVisible({ timeout: 15_000 });
      await expect(viewer.getByText('Failed', { exact: true })).not.toBeVisible();
      await expect(viewer.locator('main h3').first()).toBeVisible();
    }

    const terminalReplay = await observer.request.post(`${serviceUrl}/wardrobe/upload`, {
      headers,
      data: { itemId: createdItemId },
    });
    expect(terminalReplay.status()).toBe(202);
    expect(await terminalReplay.json()).toEqual(accepted);
    const afterReplay = await observer.request.get(`${serviceUrl}/wardrobe/items/${createdItemId}`, { headers });
    expect(afterReplay.status()).toBe(200);
    expect(await afterReplay.json()).toMatchObject({
      id: createdItemId,
      taggingStatus: 'ready',
      taggingStateVersion: latest!.taggingStateVersion,
    });
    await observer.close();

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
