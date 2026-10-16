import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import type { APIResponse, Page } from '@playwright/test';
import { assertE2EExecution } from '../scripts/execution-guard.mjs';
import { captureSizingSource, validateSizingSource } from '../scripts/beta-sizing-source.mjs';
import { hashBytes, loadSizingFixtures, sizingUploadCases, sizingVtoCases, vtoAggregateSubmittedBytes,
  createSizingVtoGarmentPlan, assertVtoCasesResolvableInPlan, sizingVtoGarmentUploadCases,
  SIZING_PROVIDER_ENVELOPE, type SizingFixture, type UploadCase } from '../scripts/beta-sizing-workload.mjs';
import { expect, login, test } from './support/fixtures.js';
import { requireEnvironment } from './support/account.js';
import { DirectTeardown, deleteRouteFor, quarantinesScope, type ProductResult } from './support/cleanup-operation.js';

interface Observation {
  case_id: string; resource_id?: string; terminal_state?: string; [key: string]: unknown;
}

interface SizingWorkloadRecord {
  schema_version: 1;
  issue: 95;
  stage: string | undefined;
  run_id: string | undefined;
  run_attempt: string | undefined;
  e2e_sha: string | undefined;
  source_proof: ReturnType<typeof captureSizingSource>;
  source_proof_after: ReturnType<typeof captureSizingSource> | null;
  fixture_manifest_sha256: string;
  supported_input_envelope_sha256: string;
  provider_envelope: typeof SIZING_PROVIDER_ENVELOPE;
  deployment_evidence_sha256: string;
  deployment: unknown;
  runtime_before_sha256: string;
  started_at: string;
  finished_at: string;
  result: string;
  workload: { uploads: Observation[]; vto: Observation[]; overlap_intent: { upload_resource_ids: string[]; vto_resource_id: string }[] };
  route_samples_ms: Record<string, number[]>;
}

test.describe('Representative Beta sizing @full-stack @beta-sizing', () => {
  test.describe.configure({ retries: 0 });
  test.skip(!['S1', 'S2', 'S3'].includes(process.env.BETA_SIZING_STAGE ?? ''), 'Manager-selected sizing workload is disabled');

  let teardown: DirectTeardown | undefined;
  // The bearer header this attempt authenticated with; never persisted.
  let authorization: string | undefined;
  let productResult: ProductResult = 'skipped';
  const created = { refs: [] as { kind: Parameters<DirectTeardown['capture']>[0]; id: string }[], streams: new Map<string, Promise<{ frames?: Record<string, unknown>[]; error?: string }>>() };

  // A stable numeric lease generation per attempt keeps every retry on a fresh
  // lease fence while staying reproducible within one attempt.
  const leaseGenerationFor = (seed: string) => (parseInt(createHash('sha256').update(seed).digest('hex').slice(0, 6), 16) % 2_000_000) + 1;

  test.beforeEach(async ({ page, workerAccount }, testInfo) => {
    authorization = undefined;
    productResult = 'skipped';
    created.refs = [];
    created.streams = new Map();
    // Register before the first business side effect, on a scope unique to this
    // attempt so a retry always allocates a fresh operation and lease generation.
    teardown = new DirectTeardown({
      runScope: requireEnvironment('E2E_CLEANUP_RUN_SCOPE'),
      testScope: 'beta-sizing.spec.ts::runs-the-frozen-12-uploads-and-8-vto-cases-once',
      retryIndex: testInfo.retry,
      leaseId: randomUUID(),
      leaseGeneration: leaseGenerationFor(`${workerAccount.email}:${testInfo.retry}:${randomUUID()}`),
      expectedUsername: workerAccount.email,
      expectedEmail: workerAccount.email,
      serviceUrl: requireEnvironment('E2E_SERVICE_URL'),
      request: page.request,
      // This attempt's own key: the worker-lease teardown that runs after
      // `afterEach` reads this attempt's business-cleanup outcome from it.
      testInfo,
    });
    await teardown.register();
    // Obtain the real Client's bearer header without persisting a token or
    // browser state. Fixture leasing and protected account cleanup remain owners.
    const authorized = page.waitForRequest(request => new URL(request.url()).pathname === '/users/me'
      && request.headers().authorization !== undefined);
    await login(page, workerAccount);
    authorization = (await authorized).headers().authorization;
    // The owner binds only after Cognito confirmation, and only to this subject.
    if (!workerAccount.subject) throw new Error('Login did not capture the confirmed Cognito subject');
    await teardown.bindOwner(workerAccount.subject);
  });

  test.afterEach(async ({ page }, testInfo) => {
    if (!teardown) return;
    // The attempt's own evidence decides the product outcome: the body records
    // `passed` only from a passing terminal record and `failed` otherwise, so
    // only an attempt whose body never ran is still `skipped` here.
    if (productResult === 'skipped' && testInfo.status !== 'skipped') productResult = 'failed';
    if (!created.refs.length || !authorization) {
      // Nothing was created — or nothing could be deleted without the attempt's
      // own authorization — so the attempt still declares its own scope.
      await teardown.acknowledge(productResult, 'passed');
      return;
    }
    for (const { kind, id } of created.refs) teardown.capture(kind, id);
    const result = await teardown.finalize(productResult, authorization);

    // Exact absence readback after teardown, independent of the product
    // assertion. `wardrobe_item` and `outfit_generation` have a routed
    // single-resource GET; a base photo has none, so its absence is proven by
    // the exact captured id being absent from the authenticated list route.
    const basePhotoIds = created.refs.filter(({ kind }) => kind === 'base_photo').map(({ id }) => id);
    for (const { kind, id } of created.refs) {
      if (kind === 'base_photo') continue;
      const route = deleteRouteFor({ kind, id });
      if (!route) throw new Error(`No ordinary user-facing absence readback exists for ${kind}`);
      const readback = await page.request.get(`${requireEnvironment('E2E_SERVICE_URL')}${route}`, {
        headers: { Authorization: authorization },
      });
      expect(readback.status()).toBe(404);
    }
    if (basePhotoIds.length) {
      const listed = await page.request.get(`${requireEnvironment('E2E_SERVICE_URL')}/vto/base-photos`, {
        headers: { Authorization: authorization },
      });
      expect(listed.status()).toBe(200);
      const remaining = (await listed.json() as { id: string }[]).map(photo => photo.id);
      for (const id of basePhotoIds) expect(remaining).not.toContain(id);
    }

    // A teardown failure fails the separate teardown gate without rewriting the
    // product outcome, and quarantines the scope so the next attempt is fresh.
    if (quarantinesScope(result.teardown_result)) {
      expect(result.scope_state, result.quarantine_reason ?? 'teardown quarantined its scope').toBe('quarantined');
      throw new Error(`Teardown gate failed (${result.teardown_result}): ${result.quarantine_reason ?? 'unknown'}`);
    }
  });

  test('runs the frozen 12 uploads and 8 VTO cases once', async ({ page }) => {
    test.setTimeout(2_700_000);
    assertE2EExecution();
    if (process.env.GITHUB_WORKFLOW_REF !== 'git-malu/AnyWear-E2E/.github/workflows/beta-qualification.yml@refs/heads/main') {
      throw new Error('Paid sizing workload requires the protected Beta Qualification workflow');
    }
    const frozen = await loadSizingFixtures(new URL('./fixtures/beta-sizing/', import.meta.url));
    // The complete plan of what this run submits, built before any upload is sent.
    // VTO garment ids resolve from here, so no VTO case depends on how far the
    // upload half has progressed or on the order either half runs in.
    const garmentPlan = createSizingVtoGarmentPlan();
    const deploymentBytes = await readFile('deployment-evidence-before.json');
    const runtimeBytes = await readFile('.qualification-inputs/beta-sizing-runtime-before.json');
    const deployment = JSON.parse(deploymentBytes.toString());
    const sourceProof = captureSizingSource();
    const runtime = JSON.parse(runtimeBytes.toString());
    validateSizingSource(runtime.source_proof, { e2eSha: sourceProof.e2e_sha,
      runId: sourceProof.run_id, runAttempt: sourceProof.run_attempt, compatibility: deployment.compatibility });
    expect(runtime.source_proof).toEqual(sourceProof);
    const serviceUrl = requireEnvironment('E2E_SERVICE_URL');
    const uploads: Observation[] = [];
    const vto: Observation[] = [];
    const overlapIntent: { upload_resource_ids: string[]; vto_resource_id: string }[] = [];
    const routeSamples: Record<string, number[]> = Object.fromEntries(
      ['/users/me', '/wardrobe', '/vto/base-photos', '/vto/generations'].map(route => [route, []]),
    );
    const record: SizingWorkloadRecord = { schema_version: 1, issue: 95, stage: process.env.BETA_SIZING_STAGE,
      run_id: process.env.GITHUB_RUN_ID, run_attempt: process.env.GITHUB_RUN_ATTEMPT,
      e2e_sha: process.env.GITHUB_SHA, source_proof: sourceProof,
      source_proof_after: null, fixture_manifest_sha256: frozen.manifestSha256,
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

    const headers = { Authorization: authorization! };
    // The transport stays synchronous on purpose: a created id and its stream
    // observation are recorded in the same statement that creates them.
    const captureCreated = (kind: 'base_photo' | 'wardrobe_item' | 'outfit_generation', id: string, stream?: Promise<{ frames?: Record<string, unknown>[]; error?: string }>) => {
      created.refs.push({ kind, id });
      if (stream) created.streams.set(id, stream);
      return Promise.resolve();
    };
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
      await captureCreated('wardrobe_item', item.resource_id, observeStream(`/wardrobe/items/${item.resource_id}`));
      await preserve();
      await putImage(String(presign.url), image);
      const acceptedHeaders = { ...headers, 'Idempotency-Key': randomUUID() };
      const accepted = await check(await page.request.post(`${serviceUrl}/wardrobe/upload`, {
        headers: acceptedHeaders, data: { itemId: item.resource_id },
      }), 202);
      const replay = await check(await page.request.post(`${serviceUrl}/wardrobe/upload`, {
        headers: acceptedHeaders, data: { itemId: item.resource_id },
      }), 202);
      expect(replay).toEqual(accepted);
      item.replay_verified = true;
      // The plan's own id is registered here, so a VTO case that references this
      // fixture resolves it whether this upload runs before, during or after it.
      garmentPlan.item_resource_id.set(entry.fixture, item.resource_id);
      return item;
    };
    const reloadCheck = async (items: Observation[], kind: 'tagging' | 'vto') => {
      await page.reload();
      for (const item of items) {
        const path = kind === 'tagging' ? `/wardrobe/items/${item.resource_id}` : `/vto/generations/${item.resource_id}`;
        const state = await check(await page.request.get(`${serviceUrl}${path}`, { headers }), 200);
        expect(Number(kind === 'tagging' ? state.taggingStateVersion : state.state_version)).toBeGreaterThanOrEqual(Number(item.last_state_version));
        expect(kind === 'tagging' ? state.taggingStatus : state.status).toBe(kind === 'tagging' ? 'ready' : 'Complete');
        const live = await created.streams.get(item.resource_id!);
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

    let sourceError: unknown;
    try {
      expect(await credit()).toBeGreaterThanOrEqual(10);
      const cases = sizingVtoCases();
      // Only base photos this case set actually submits: the VTO payload is the
      // base photo plus the garments, and both sides stay inside the S1 envelope.
      const basePhotos = new Map<string, string>();
      for (const name of [...new Set(cases.map(entry => entry.base_fixture))].sort()) {
        const image = fixture(name);
        assertE2EExecution();
        const response = await check(await page.request.post(`${serviceUrl}/vto/base-photos`, {
          headers, data: { contentType: image.mime, extension: 'jpg' },
        }), 201);
        basePhotos.set(name, String(response.id));
        // Captured as created: the lease's cleanup deletes this exact base photo.
        await captureCreated('base_photo', String(response.id));
        await putImage(String(response.uploadUrl), image);
      }
      const sequential = sizingUploadCases().filter(item => item.submission === 'sequential');
      // The garment fixtures are submitted FIRST, before any VTO is accepted: a VTO
      // garment has to be a real wardrobe item the API can resolve, not merely a
      // fixture the plan names. They are the plan's pool in its smallest-first
      // order, so a future plan that moves one of them behind the VTO loop - or adds
      // a garment no sequential upload case submits - fails here by name.
      const garmentUploads = sizingVtoGarmentUploadCases();
      const submittedCases = new Set(garmentUploads.map(item => item.case_id));
      const orderedSequential = [...garmentUploads,
        ...sequential.filter(item => !submittedCases.has(item.case_id))];
      for (const entry of orderedSequential) {
        const item = await submitUpload(entry);
        await waitTerminal(`/wardrobe/items/${item.resource_id}`, 'tagging', item);
        await reloadCheck([item], 'tagging');
        await preserve();
      }
      const burst = sizingUploadCases().filter(item => item.submission === 'burst');
      // Authoritative resolution: every garment id comes from the plan built over
      // the COMPLETE fixture set, so no VTO case depends on how far the upload half
      // has progressed. This fails before the first VTO is accepted if any garment
      // is one the submission plan does not submit, or if its planned upload has
      // not run - naming the fixture and the case instead of reporting `false`.
      assertVtoCasesResolvableInPlan(garmentPlan, { requireResolved: true });
      const garmentResourceId = (caseId: string, fixtureName: string) => {
        try {
          return garmentPlan.resolveGarmentId(caseId, fixtureName);
        } catch (error) {
          throw new Error(`${error instanceof Error ? error.message : String(error)} `
            + `(submitted so far: ${uploads.map(entry => entry.fixture).join(', ') || 'none'})`, { cause: error });
        }
      };
      for (const [index, entry] of cases.entries()) {
        // The garment list is the canonical smallest-first one, so the shape
        // carries the least payload it can.
        const garmentIds = entry.garment_fixtures
          .map(fixture => garmentResourceId(entry.case_id, fixture));
        const before = await credit();
        const base = fixture(entry.base_fixture);
        // The VTO payload aggregates the base photo and the garments; the recorded
        // aggregate is what was actually submitted, and the per-input bound does not
        // cover it.
        const aggregateSubmittedBytes = vtoAggregateSubmittedBytes(frozen.fixtures,
          entry.base_fixture, entry.garment_fixtures);
        const item: Observation = { ...entry, started_at: new Date().toISOString(),
          base_fixture_sha256: base.sha256, base_fixture_bytes: base.bytes,
          base_fixture_dimensions: [base.width, base.height],
          garment_resource_ids: garmentIds, aggregate_submitted_bytes: aggregateSubmittedBytes };
        vto.push(item);
        const requestBody = { base_photo_id: basePhotos.get(entry.base_fixture), wearable_item_ids: garmentIds,
          ...(entry.advanced_settings ? { advanced_settings: entry.advanced_settings } : {}) };
        const acceptedHeaders = { ...headers, 'Idempotency-Key': randomUUID() };
        assertE2EExecution();
        const accepted = await check(await page.request.post(`${serviceUrl}/vto/generations`, {
          headers: acceptedHeaders, data: requestBody,
        }), 202);
        item.resource_id = String(accepted.generation_id);
        await captureCreated('outfit_generation', item.resource_id, observeStream(`/vto/generations/${item.resource_id}`));
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
      try { record.source_proof_after = captureSizingSource(); expect(record.source_proof_after).toEqual(sourceProof); }
      catch (error) { record.result = 'failed-or-incomplete'; sourceError = error; }
      record.finished_at = new Date().toISOString();
      if (record.result !== 'passed') record.result = 'failed-or-incomplete';
      // The body's own terminal record decides the product outcome: a completed
      // sizing workload is `passed`, anything else is `failed`.
      productResult = record.result === 'passed' ? 'passed' : 'failed';
      await preserve();
      // No ad hoc deletion: protected application cleanup receives the exact
      // leased subjects even after a partial/provider failure.
    }
    if (sourceError) throw sourceError;
  });
});
