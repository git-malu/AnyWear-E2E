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

interface WardrobeItem extends WardrobeStatus {
  name: string | null;
  category: string;
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
    // Cover the Service's nominal 552-second retry budget and bounded browser
    // overhead; this completion wait does not assert a latency SLA.
    test.setTimeout(720_000);

    page.on('dialog', async (dialog) => {
      await dialog.accept();
    });

    const initialWardrobe = page.waitForResponse((response) => (
      new URL(response.url()).pathname === '/wardrobe'
      && response.request().method() === 'GET'
    ));
    await page.goto('/wardrobe');
    await expect(page.getByRole('heading', { name: 'Wardrobe' })).toBeVisible();
    const initialWardrobeResponse = await initialWardrobe;
    expect(initialWardrobeResponse.status()).toBe(200);
    const baselineItems = await initialWardrobeResponse.json() as WardrobeItem[];

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
    const ownedItemUrl = `${serviceUrl}/wardrobe/items/${createdItemId}`;

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
      const response = await page.request.get(ownedItemUrl, { headers });
      expect(response.status()).toBe(200);
      latest = await response.json() as WardrobeStatus;
      expect(latest.id).toBe(createdItemId);
      expect(latest.taggingStateVersion).toBeGreaterThanOrEqual(lastVersion);
      lastVersion = latest.taggingStateVersion;
      observedTerminalState = isTerminalTaggingStatus(latest.taggingStatus);
      return latest.taggingStatus;
    }, { timeout: 600_000, intervals: [1_000, 2_000, 5_000] }).toBe('ready');

    const terminalReplay = await observer.request.post(`${serviceUrl}/wardrobe/upload`, {
      headers,
      data: { itemId: createdItemId },
    });
    expect(terminalReplay.status()).toBe(202);
    expect(await terminalReplay.json()).toEqual(accepted);
    const afterReplay = await observer.request.get(ownedItemUrl, { headers });
    expect(afterReplay.status()).toBe(200);
    const ownedItem = await afterReplay.json() as WardrobeItem;
    expect(ownedItem).toMatchObject({
      id: createdItemId,
      taggingStatus: 'ready',
      taggingStateVersion: latest!.taggingStateVersion,
    });

    const ownedItemLabel = ownedItem.name || ownedItem.category || 'wardrobe item';
    const ownedCardName = `View ${ownedItemLabel} details`;
    const wardrobeBeforeEdit = await page.request.get(`${serviceUrl}/wardrobe`, { headers });
    expect(wardrobeBeforeEdit.status()).toBe(200);
    const itemsBeforeEdit = await wardrobeBeforeEdit.json() as WardrobeItem[];
    // The UI exposes a label rather than an ID. Fail before mutation if that
    // label cannot identify exactly the item created by this scenario.
    expect(itemsBeforeEdit.filter((item) => (
      (item.name || item.category || 'wardrobe item') === ownedItemLabel
    )).map((item) => item.id)).toEqual([createdItemId]);

    for (const viewer of [page, observer]) {
      const itemCard = viewer.getByRole('button', { name: ownedCardName, exact: true });
      await expect(itemCard).toHaveCount(1, { timeout: 15_000 });
      await expect(itemCard).toBeVisible();
      await expect(itemCard).toBeEnabled({ timeout: 15_000 });
      await expect(itemCard.getByText('Analyzing...')).not.toBeVisible();
      await expect(itemCard.getByText('Failed', { exact: true })).not.toBeVisible();
    }
    await observer.close();

    const itemCard = page.getByRole('button', { name: ownedCardName, exact: true });
    await expect(itemCard).toHaveCount(1);
    await itemCard.click();
    const details = page.getByRole('dialog', { name: 'Item Details', exact: true });
    await expect(details).toBeVisible();

    const editedItemName = `E2E Test Sweater ${createdItemId}`;
    await details.getByPlaceholder('e.g. My favorite hoodie').fill(editedItemName);
    await details.getByPlaceholder('e.g. Top').fill('Jacket');
    await details.getByPlaceholder('e.g. Black, White').fill('Red');
    await details.getByPlaceholder('e.g. Cotton').fill('Cotton');
    const saved = page.waitForResponse((response) => (
      response.url() === ownedItemUrl && response.request().method() === 'PATCH'
    ));
    await details.getByRole('button', { name: 'Save Changes', exact: true }).click();
    const savedResponse = await saved;
    expect(savedResponse.status()).toBe(200);
    expect(await savedResponse.json()).toMatchObject({ id: createdItemId, name: editedItemName });
    await expect(details).not.toBeVisible();

    const editedCard = page.getByRole('button', { name: `View ${editedItemName} details`, exact: true });
    await expect(editedCard).toHaveCount(1, { timeout: 10_000 });
    await expect(editedCard.getByRole('heading', { name: editedItemName, exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(editedCard.getByText(/red.*cotton/i)).toBeVisible({ timeout: 5_000 });

    await editedCard.click();
    await expect(details).toBeVisible();
    const deleted = page.waitForResponse((response) => (
      response.url() === ownedItemUrl && response.request().method() === 'DELETE'
    ));
    await details.getByRole('button', { name: 'Delete', exact: true }).click();
    expect((await deleted).status()).toBe(200);
    await expect(details).not.toBeVisible();
    await expect(editedCard).toHaveCount(0);
    const deletedItem = await page.request.get(ownedItemUrl, { headers });
    expect(deletedItem.status()).toBe(404);

    const finalWardrobe = await page.request.get(`${serviceUrl}/wardrobe`, { headers });
    expect(finalWardrobe.status()).toBe(200);
    const finalItems = await finalWardrobe.json() as WardrobeItem[];
    expect(finalItems.map((item) => item.id)).not.toContain(createdItemId);
    for (const baselineItem of baselineItems) {
      expect(finalItems.find((item) => item.id === baselineItem.id)).toMatchObject({
        id: baselineItem.id,
        name: baselineItem.name,
      });
    }
  });
});
