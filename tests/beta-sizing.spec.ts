import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { APIResponse, Page } from '@playwright/test';
import { assertE2EExecution } from '../scripts/execution-guard.mjs';
import { hashBytes, loadSizingFixtures, sizingUploadCases, sizingVtoCases,
  SIZING_PROVIDER_ENVELOPE, type SizingFixture, type UploadCase } from '../scripts/beta-sizing-workload.mjs';
import { expect, login, test } from './support/fixtures.js';
import { requireEnvironment } from './support/account.js';

interface Observation {
  case_id: string; resource_id?: string; terminal_state?: string; [key: string]: unknown;
}

test.describe('Representative Beta sizing @full-stack @beta-sizing', () => {
  test.describe.configure({ retries: 0 });
  test.skip(!['S1', 'S2', 'S3'].includes(process.env.BETA_SIZING_STAGE ?? ''), 'Manager-selected sizing workload is disabled');

  test('runs the frozen 24 uploads and 10 VTO cases once', async ({ page, workerAccount }) => {
    test.setTimeout(2_700_000);
    assertE2EExecution();
    if (process.env.GITHUB_WORKFLOW_REF !== 'git-malu/AnyWear-E2E/.github/workflows/beta-qualification.yml@refs/heads/main') {
      throw new Error('Paid sizing workload requires the protected Beta Qualification workflow');
    }
    const frozen = await loadSizingFixtures(new URL('./fixtures/beta-sizing/', import.meta.url));
    const deploymentBytes = await readFile('deployment-evidence-before.json');
    const runtimeBytes = await readFile('.qualification-inputs/beta-sizing-runtime-before.json');
    const deployment = JSON.parse(deploymentBytes.toString());
    const serviceUrl = requireEnvironment('E2E_SERVICE_URL');
    const uploads: Observation[] = [];
    const vto: Observation[] = [];
    const overlapIntent: { upload_resource_ids: string[]; vto_resource_id: string }[] = [];
    const routeSamples: Record<string, number[]> = Object.fromEntries(
      ['/users/me', '/wardrobe', '/vto/base-photos', '/vto/generations'].map(route => [route, []]),
    );
    const record = { schema_version: 1, issue: 95, stage: process.env.BETA_SIZING_STAGE,
      run_id: process.env.GITHUB_RUN_ID, run_attempt: process.env.GITHUB_RUN_ATTEMPT,
      e2e_sha: process.env.GITHUB_SHA, fixture_manifest_sha256: frozen.manifestSha256,
      supported_input_envelope_sha256: frozen.envelopeSha256, provider_envelope: SIZING_PROVIDER_ENVELOPE,
      deployment_evidence_sha256: hashBytes(deploymentBytes), deployment,
      runtime_before_sha256: hashBytes(runtimeBytes),
      started_at: new Date().toISOString(), finished_at: '', result: 'running',
      workload: { uploads, vto, overlap_intent: overlapIntent }, route_samples_ms: routeSamples };
    const output = 'test-results/beta-sizing-workload.json';
    await mkdir('test-results', { recursive: true });
    let saving = Promise.resolve();
    const preserve = () => {
      const bytes = `${JSON.stringify(record, null, 2)}\n`;
      saving = saving.then(() => writeFile(output, bytes));
      return saving;
    };
    await preserve();

    // Obtain the real Client's bearer header without persisting a token or
    // browser state. Fixture leasing and protected account cleanup remain owners.
    const authorized = page.waitForRequest(request => new URL(request.url()).pathname === '/users/me'
      && request.headers().authorization !== undefined);
    await login(page, workerAccount);
    const authorization = (await authorized).headers().authorization;
    const headers = { Authorization: authorization };
    const streams = new Map<string, Promise<{ frames?: Record<string, unknown>[]; error?: string }>>();
    const observeStream = async (path: string) => {
      try {
        const response = await page.request.get(`${serviceUrl}${path}/stream`, { headers, timeout: 600_000 });
        expect(response.status()).toBe(200);
        expect(response.headers()['content-type']).toContain('text/event-stream');
        const frames = (await response.text()).split(/\r?\n\r?\n/)
          .filter(frame => /(^|\n)event: status/.test(frame))
          .map(frame => {
            const data = JSON.parse(frame.split(/\r?\n/).filter(line => line.startsWith('data:'))
              .map(line => line.slice(5).trimStart()).join('\n')) as Record<string, unknown>;
            return Object.fromEntries(['item_id', 'generation_id', 'tagging_status', 'status', 'state_version']
              .filter(key => data[key] !== undefined).map(key => [key, data[key]]));
          });
        expect(frames.length).toBeGreaterThan(0);
        let version = 0;
        for (const frame of frames) {
          expect(Number(frame.state_version)).toBeGreaterThan(version);
          version = Number(frame.state_version);
        }
        return { frames };
      } catch (error) {
        return { error: error instanceof Error ? error.name : 'stream-failed' };
      }
    };
    const check = async (response: APIResponse, status: number) => {
      expect(response.status()).toBe(status);
      return await response.json() as Record<string, unknown>;
    };
    const credit = async () => Number((await check(await page.request.get(`${serviceUrl}/users/me`, { headers }), 200)).dailyCredits);
    const fixture = (id: string) => {
      const value = frozen.fixtures.get(id);
      if (!value) throw new Error(`Missing frozen sizing image ${id}`);
      return value;
    };
    const putImage = async (url: string, image: SizingFixture) => {
      assertE2EExecution();
      const response = await page.request.put(url, { headers: { 'Content-Type': image.mime }, data: image.data });
      expect(response.ok()).toBe(true);
    };
    const waitTerminal = async (path: string, kind: 'tagging' | 'vto', item: Observation, observer: Page = page) => {
      let version = 0;
      await expect.poll(async () => {
        const state = await check(await observer.request.get(`${serviceUrl}${path}`, { headers }), 200);
        const next = Number(kind === 'tagging' ? state.taggingStateVersion : state.state_version);
        expect(next).toBeGreaterThanOrEqual(version);
        version = next;
        const status = String(kind === 'tagging' ? state.taggingStatus : state.status);
        item.terminal_state = status;
        item.last_state_version = version;
        if (status === 'failed' || status === 'Failed') throw new Error(`Sizing task failed: ${item.case_id}`);
        if (status === 'ready' || status === 'Complete') {
          item.finished_at = new Date().toISOString();
          if (kind === 'vto') {
            expect(typeof state.image_key).toBe('string');
            const result = await observer.request.get(String(state.image_key));
            expect(result.ok()).toBe(true);
            const bytes = await result.body();
            expect(bytes.length).toBeGreaterThan(0);
            item.output_retrievable = true;
            item.output_sha256 = hashBytes(bytes);
            item.output_bytes = bytes.length;
          }
        }
        return status;
      }, { timeout: 600_000, intervals: [1_000, 2_000, 5_000] }).toBe(kind === 'tagging' ? 'ready' : 'Complete');
    };
    const submitUpload = async (entry: UploadCase) => {
      assertE2EExecution();
      const image = fixture(entry.fixture);
      const item: Observation = { ...entry, mime: image.mime, fixture_sha256: image.sha256, fixture_bytes: image.bytes,
        fixture_dimensions: [image.width, image.height], started_at: new Date().toISOString() };
      uploads.push(item);
      const presign = await check(await page.request.post(`${serviceUrl}/wardrobe/upload-url`, {
        headers, data: { contentType: image.mime, extension: image.file.split('.').at(-1) },
      }), 200);
      item.resource_id = String(presign.itemId);
      await preserve();
      await putImage(String(presign.url), image);
      const acceptedHeaders = { ...headers, 'Idempotency-Key': randomUUID() };
      const accepted = await check(await page.request.post(`${serviceUrl}/wardrobe/upload`, {
        headers: acceptedHeaders, data: { itemId: item.resource_id },
      }), 202);
      streams.set(item.resource_id!, observeStream(`/wardrobe/items/${item.resource_id}`));
      const replay = await check(await page.request.post(`${serviceUrl}/wardrobe/upload`, {
        headers: acceptedHeaders, data: { itemId: item.resource_id },
      }), 202);
      expect(replay).toEqual(accepted);
      item.replay_verified = true;
      return item;
    };
    const reloadCheck = async (items: Observation[], kind: 'tagging' | 'vto') => {
      await page.reload();
      for (const item of items) {
        const path = kind === 'tagging' ? `/wardrobe/items/${item.resource_id}` : `/vto/generations/${item.resource_id}`;
        const state = await check(await page.request.get(`${serviceUrl}${path}`, { headers }), 200);
        expect(Number(kind === 'tagging' ? state.taggingStateVersion : state.state_version)).toBeGreaterThanOrEqual(Number(item.last_state_version));
        expect(kind === 'tagging' ? state.taggingStatus : state.status).toBe(kind === 'tagging' ? 'ready' : 'Complete');
        const live = await streams.get(item.resource_id!);
        const reconnected = await observeStream(path);
        item.stream_observations = { live, reconnected };
        expect(live?.error).toBeUndefined();
        expect(reconnected.error).toBeUndefined();
        for (const observed of [live, reconnected]) {
          const terminal = observed?.frames?.at(-1);
          expect(terminal?.[kind === 'tagging' ? 'item_id' : 'generation_id']).toBe(item.resource_id);
          expect(terminal?.[kind === 'tagging' ? 'tagging_status' : 'status']).toBe(kind === 'tagging' ? 'ready' : 'Complete');
          expect(Number(terminal?.state_version)).toBeGreaterThanOrEqual(Number(item.last_state_version));
        }
        item.notification_recovery_verified = true;
        item[kind === 'tagging' ? 'reload_verified' : 'progress_reload_verified'] = true;
      }
    };

    try {
      expect(await credit()).toBeGreaterThanOrEqual(10);
      const basePhotos = new Map<string, string>();
      for (const name of ['base-photo-ordinary.jpg', 'base-photo-large.jpg']) {
        const image = fixture(name);
        assertE2EExecution();
        const response = await check(await page.request.post(`${serviceUrl}/vto/base-photos`, {
          headers, data: { contentType: image.mime, extension: 'jpg' },
        }), 201);
        basePhotos.set(name, String(response.id));
        await putImage(String(response.uploadUrl), image);
      }
      for (const entry of sizingUploadCases().filter(item => item.submission === 'sequential')) {
        const item = await submitUpload(entry);
        await waitTerminal(`/wardrobe/items/${item.resource_id}`, 'tagging', item);
        await reloadCheck([item], 'tagging');
        await preserve();
      }
      const burst = sizingUploadCases().filter(item => item.submission === 'burst');
      const cases = sizingVtoCases();
      for (const [index, entry] of cases.entries()) {
        const garmentIds = [
          uploads.find(item => item.fixture === 'sweater-ordinary.png')?.resource_id,
          ...['trousers', 'jacket', 'shoes', 'bag'].map(name => uploads.find(item => item.fixture === `${name}-ordinary.jpg`)?.resource_id),
        ].slice(0, entry.garment_count);
        expect(garmentIds.every(id => typeof id === 'string')).toBe(true);
        const before = await credit();
        const item: Observation = { ...entry, started_at: new Date().toISOString(),
          fixture_sha256: fixture(entry.base_fixture).sha256, garment_resource_ids: garmentIds };
        vto.push(item);
        const requestBody = { base_photo_id: basePhotos.get(entry.base_fixture), wearable_item_ids: garmentIds,
          ...(entry.advanced_settings ? { advanced_settings: entry.advanced_settings } : {}) };
        const acceptedHeaders = { ...headers, 'Idempotency-Key': randomUUID() };
        assertE2EExecution();
        const accepted = await check(await page.request.post(`${serviceUrl}/vto/generations`, {
          headers: acceptedHeaders, data: requestBody,
        }), 202);
        item.resource_id = String(accepted.generation_id);
        streams.set(item.resource_id, observeStream(`/vto/generations/${item.resource_id}`));
        await preserve();
        const pairedPromise = index < 2
          ? Promise.all(burst.slice(index * 6, index * 6 + 6).map(submitUpload))
            .then(items => ({ items, error: undefined }), error => ({ items: [], error }))
          : Promise.resolve({ items: [], error: undefined });
        const replay = await check(await page.request.post(`${serviceUrl}/vto/generations`, {
          headers: acceptedHeaders, data: requestBody,
        }), 202);
        expect(replay).toEqual(accepted);
        item.replay_verified = true;
        item.credit_debit = before - await credit();
        expect(item.credit_debit).toBe(1);
        await page.goto('/mirror');
        await page.reload();
        const reloaded = await check(await page.request.get(`${serviceUrl}/vto/generations/${item.resource_id}`, { headers }), 200);
        expect(reloaded.generation_id).toBe(item.resource_id);
        item.reload_state = reloaded.status;
        const pairedResult = await pairedPromise;
        if (pairedResult.error) throw pairedResult.error;
        const paired: Observation[] = pairedResult.items;
        if (index < 2) {
          overlapIntent.push({ upload_resource_ids: paired.map(upload => upload.resource_id!), vto_resource_id: item.resource_id });
        }
        await Promise.all([waitTerminal(`/vto/generations/${item.resource_id}`, 'vto', item),
          ...paired.map(upload => waitTerminal(`/wardrobe/items/${upload.resource_id}`, 'tagging', upload))]);
        await reloadCheck([item], 'vto');
        await reloadCheck(paired, 'tagging');
        expect(await credit()).toBe(before - 1);
        await preserve();
      }
      // Pace ordinary authenticated routes; retain samples, never an invented p95.
      for (let sample = 0; sample < 100; sample += 1) {
        for (const route of Object.keys(routeSamples)) {
          const start = performance.now();
          await check(await page.request.get(`${serviceUrl}${route}`, { headers }), 200);
          routeSamples[route].push(performance.now() - start);
        }
        await page.waitForTimeout(500);
      }
      record.result = 'passed';
    } finally {
      record.finished_at = new Date().toISOString();
      if (record.result !== 'passed') record.result = 'failed-or-incomplete';
      await preserve();
      // No ad hoc deletion: protected application cleanup receives the exact
      // leased subjects even after a partial/provider failure.
    }
  });
});
