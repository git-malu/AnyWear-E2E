import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { byteHash } from './evidence-contract.mjs';
import { qualificationFixture } from './fixtures/infra-qualification.mjs';
import {
  buildV2Compatibility, listRunArtifacts, migrationArguments, selectDeploymentArtifact,
} from './migrate-compatibility.mjs';

function inputs() {
  const fixture = qualificationFixture();
  const v1 = {
    version: 1,
    client: { repository: 'git-malu/AnyWear-Client', sha: fixture.compatibility.client.sha },
    service: { repository: 'git-malu/AnyWear-Service', sha: fixture.compatibility.service.sha },
  };
  const recordBytes = Buffer.from(`${JSON.stringify(fixture.deployment, null, 2)}\n`);
  return { v1, deployment: fixture.deployment, recordBytes };
}

test('builds v2 from unchanged v1 pins and an exact deployment record', () => {
  const { v1, deployment, recordBytes } = inputs();
  const result = buildV2Compatibility(v1, deployment, recordBytes, 40);
  assert.equal(result.version, 2);
  assert.deepEqual(result.client, v1.client);
  assert.deepEqual(result.service, v1.service);
  assert.equal(result.infra.sha, deployment.infra.sha);
  assert.equal(result.service_artifacts.release_id, deployment.selection.release.id);
  assert.equal(result.service_artifacts.manifest_asset_id, deployment.selection.release.manifest_asset_id);
  assert.equal(result.deployment.run_id, deployment.infra.run_id);
  assert.equal(result.deployment.artifact_id, 40);
  assert.equal(result.deployment.record_sha256, byteHash(recordBytes));
  assert.equal(v1.version, 1);
});

test('rejects missing or null artifact identity rather than emitting an incomplete v2 tuple', () => {
  const { v1, deployment, recordBytes } = inputs();
  assert.throws(() => buildV2Compatibility(v1, deployment, recordBytes), /artifact ID is required/);
  assert.throws(() => buildV2Compatibility(v1, deployment, recordBytes, null), /artifact ID is required/);
});

test('rejects stale or mismatched application pins from the deployment record', () => {
  const { v1, deployment, recordBytes } = inputs();
  const staleClient = structuredClone(deployment);
  staleClient.observed.client_sha = 'c'.repeat(40);
  assert.throws(() => buildV2Compatibility(v1, staleClient,
    Buffer.from(`${JSON.stringify(staleClient, null, 2)}\n`), 40), /Client source does not match/);
  const staleService = structuredClone(deployment);
  staleService.observed.service_sha = 'c'.repeat(40);
  assert.throws(() => buildV2Compatibility(v1, staleService,
    Buffer.from(`${JSON.stringify(staleService, null, 2)}\n`), 40), /Service source does not match/);
  assert.doesNotThrow(() => buildV2Compatibility(v1, deployment, recordBytes, 40));
});

test('rejects a deployment object that differs from its supplied exact bytes', () => {
  const { v1, deployment, recordBytes } = inputs();
  const altered = structuredClone(deployment);
  altered.stacks[0].template_sha256 = 'c'.repeat(64);
  assert.throws(() => buildV2Compatibility(v1, altered, recordBytes, 40), /byte payload mismatch/);
});

test('rejects historical deployment records and non-v1 migration input', () => {
  const { v1, deployment, recordBytes } = inputs();
  const historical = structuredClone(deployment);
  historical.schema_version = 1;
  assert.throws(() => buildV2Compatibility(v1, historical,
    Buffer.from(`${JSON.stringify(historical, null, 2)}\n`), 40), /historical v1/);
  const alreadyMigrated = { ...v1, version: 2 };
  assert.throws(() => buildV2Compatibility(alreadyMigrated, deployment, recordBytes, 40), /version 1/);
});

test('migration CLI accepts no alternate v1 baseline', () => {
  assert.deepEqual(migrationArguments(['--deployment-record', 'record.json', '--output', 'reviewed-v2.json']), {
    inputPath: resolve('record.json'),
    outputPath: resolve('reviewed-v2.json'),
  });
  assert.throws(() => migrationArguments(['--v1', 'alternate.json', '--deployment-record', 'record.json', '--output', 'reviewed-v2.json']), /Unsupported argument --v1/);
  assert.throws(() => migrationArguments(['--deployment-record', 'record.json', '--deployment-record', 'other.json', '--output', 'out.json']), /only once/);
  assert.throws(() => migrationArguments(['--deployment-record', 'record.json']), /--output is required/);
});

test('selects exactly one unexpired artifact bound to the exact Infra workflow attempt', () => {
  const run = { id: 30, run_attempt: 2, head_sha: 'e'.repeat(40) };
  const artifact = { id: 40, name: 'infra-deployment-30-2', expired: false,
    workflow_run: { id: 30, head_sha: run.head_sha } };
  assert.equal(selectDeploymentArtifact([artifact], run).id, artifact.id);
  assert.throws(() => selectDeploymentArtifact([], run), /exactly one/);
  assert.throws(() => selectDeploymentArtifact([artifact, { ...artifact, id: 41 }], run), /exactly one/);
  assert.throws(() => selectDeploymentArtifact([{ ...artifact, expired: true }], run), /exactly one/);
  assert.throws(() => selectDeploymentArtifact([{ ...artifact, workflow_run: { id: 29, head_sha: run.head_sha } }], run), /exactly one/);
});

test('paginates artifacts through exact page boundaries and accepts a final partial page', async () => {
  const run = { id: 30, run_attempt: 2 };
  const requests = [];
  const pages = new Map([
    [1, { total_count: 201, artifacts: Array.from({ length: 100 }, (_, index) => ({ id: index + 1 })) }],
    [2, { total_count: 201, artifacts: Array.from({ length: 100 }, (_, index) => ({ id: index + 101 })) }],
    [3, { total_count: 201, artifacts: [{ id: 201 }] }],
  ]);
  const result = await listRunArtifacts(run, {}, async (path) => {
    requests.push(path);
    const page = Number(new URL(`https://github.com/${path}`).searchParams.get('page'));
    return JSON.stringify(pages.get(page));
  });
  assert.equal(result.length, 201);
  assert.deepEqual(requests.map((path) => new URL(`https://github.com/${path}`).searchParams.get('page')), ['1', '2', '3']);
});

test('stops on an exact full-page boundary without requesting an empty page', async () => {
  const requests = [];
  const result = await listRunArtifacts({ id: 30, run_attempt: 2 }, {}, async (path) => {
    requests.push(path);
    const page = Number(new URL(`https://github.com/${path}`).searchParams.get('page'));
    return JSON.stringify({ total_count: 200, artifacts: Array.from({ length: 100 }, (_, id) => ({ id: (page - 1) * 100 + id })) });
  });
  assert.equal(result.length, 200);
  assert.deepEqual(requests.map((path) => new URL(`https://github.com/${path}`).searchParams.get('page')), ['1', '2']);
});

test('artifact pagination rejects partial pages, changing totals, over-counts, and bounded-cap exhaustion', async () => {
  const run = { id: 30, run_attempt: 2 };
  const api = (pages) => async (path) => {
    const page = Number(new URL(`https://github.com/${path}`).searchParams.get('page'));
    return JSON.stringify(pages(page));
  };
  await assert.rejects(listRunArtifacts(run, {}, api((page) => page === 1
    ? { total_count: 150, artifacts: [{ id: 1 }] } : { total_count: 150, artifacts: [] })), /pagination is incomplete/);
  await assert.rejects(listRunArtifacts(run, {}, api((page) => page === 1
    ? { total_count: 101, artifacts: Array.from({ length: 100 }, (_, id) => ({ id })) }
    : { total_count: 102, artifacts: [{ id: 100 }] })), /changed while reading/);
  await assert.rejects(listRunArtifacts(run, {}, api(() => ({ total_count: 1, artifacts: [{ id: 1 }, { id: 2 }] }))), /exceeds its reported total_count/);
  let requests = 0;
  await assert.rejects(listRunArtifacts(run, {}, async () => {
    requests++;
    return JSON.stringify({ total_count: 10_001, artifacts: Array.from({ length: 100 }, (_, id) => ({ id })) });
  }), /bounded pagination limit/);
  assert.equal(requests, 100);
});
