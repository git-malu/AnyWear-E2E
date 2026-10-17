import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { byteHash } from './evidence-contract.mjs';
import { qualificationFixture } from './fixtures/infra-qualification.mjs';
import {
  buildV2Compatibility, buildV3Compatibility, listRunArtifacts, migrationArguments, selectDeploymentArtifact,
} from './migrate-compatibility.mjs';

function v2Input() {
  const f = qualificationFixture();
  const v2 = {
    version: 2,
    client: structuredClone(f.compatibility.client),
    service: structuredClone(f.compatibility.service),
    infra: structuredClone(f.compatibility.infra),
    service_artifacts: structuredClone(f.compatibility.service_artifacts),
    deployment: { repository: 'git-malu/AnyWear-Infra', workflow_path: '.github/workflows/runtime.yml',
      run_id: 10, run_attempt: 1, artifact_id: 20, record_sha256: 'a'.repeat(64) },
  };
  const v1 = { version: 1, client: structuredClone(v2.client), service: structuredClone(v2.service) };
  const v2Record = {
    schema_version: 2, record_type: 'anywear_infra_deployment',
    infra: { repository: 'git-malu/AnyWear-Infra', sha: v2.infra.sha, workflow_path: '.github/workflows/runtime.yml',
      workflow_ref: 'git-malu/AnyWear-Infra/.github/workflows/runtime.yml@refs/heads/main', run_id: 10, run_attempt: 1 },
    selection: { file: 'selections/old.json', sha256: 'b'.repeat(64),
      release: { repository: 'git-malu/AnyWear-Service', id: v2.service_artifacts.release_id,
        manifest_asset_id: v2.service_artifacts.manifest_asset_id, manifest_sha256: v2.service_artifacts.manifest_sha256 },
      components: {} },
    observed: { client_sha: v2.client.sha, service_sha: v2.service.sha },
  };
  const v2RecordBytes = Buffer.from(`${JSON.stringify(v2Record, null, 2)}\n`);
  return { f, v1, v2, v2Record, v2RecordBytes };
}

test('historical v1 -> v2 migration copies unchanged pins and the exact record bytes', () => {
  const { v1, v2, v2Record, v2RecordBytes } = v2Input();
  const result = buildV2Compatibility(v1, v2Record, v2RecordBytes, 40, { validate: () => {} });
  assert.equal(result.version, 2);
  assert.deepEqual(result.client, v1.client);
  assert.deepEqual(result.service, v1.service);
  assert.equal(result.infra.sha, v2Record.infra.sha);
  assert.equal(result.service_artifacts.release_id, v2Record.selection.release.id);
  assert.equal(result.service_artifacts.manifest_asset_id, v2Record.selection.release.manifest_asset_id);
  assert.equal(result.deployment.run_id, v2Record.infra.run_id);
  assert.equal(result.deployment.artifact_id, 40);
  assert.equal(result.deployment.record_sha256, byteHash(v2RecordBytes));
  assert.equal(v1.version, 1);
  assert.equal(v2.version, 2);
});

test('historical v1 -> v2 rejects a missing artifact id, stale pins and mismatched bytes', () => {
  const { v1, v2Record, v2RecordBytes } = v2Input();
  assert.throws(() => buildV2Compatibility(v1, v2Record, v2RecordBytes, undefined, { validate: () => {} }), /artifact ID is required/);
  const staleClient = structuredClone(v2Record); staleClient.observed.client_sha = 'c'.repeat(40);
  assert.throws(() => buildV2Compatibility(v1, staleClient, Buffer.from(`${JSON.stringify(staleClient, null, 2)}\n`), 40,
    { validate: () => {} }), /Client source does not match/);
});

test('strict v2 -> v3 migration writes both producer identities and exact record hashes', () => {
  const { f, v2 } = v2Input();
  const platformRun = { run_id: 30, run_attempt: 2, artifact_id: 40 };
  const workloadRun = { run_id: 50, run_attempt: 1, artifact_id: 60 };
  const result = buildV3Compatibility(v2, {
    platformRecord: f.platformRecord, platformBytes: f.bytes.platform, platformRun,
    workloadRecord: f.workloadRecord, workloadBytes: f.bytes.workload, workloadRun,
  });
  assert.equal(result.version, 3);
  assert.deepEqual(result.client, v2.client);
  assert.deepEqual(result.service, v2.service);
  assert.deepEqual(result.infra, v2.infra);
  assert.deepEqual(result.service_artifacts, v2.service_artifacts);
  assert.deepEqual(result.platform.producer, 'git-malu/AnyWear-Infra');
  assert.equal(result.platform.producer_sha, f.platformRecord.producer.sha);
  assert.equal(result.platform.record.workflow_path, '.github/workflows/runtime.yml');
  assert.equal(result.platform.record.run_id, 30);
  assert.equal(result.platform.record.record_sha256, byteHash(f.bytes.platform));
  assert.deepEqual(result.workload, { producer: 'git-malu/AnyWear-Service', producer_sha: f.workloadRecord.producer.sha });
  assert.equal(result.deployment.producer, 'git-malu/AnyWear-Service');
  assert.equal(result.deployment.run_id, 50);
  assert.equal(result.deployment.record_sha256, byteHash(f.bytes.workload));
});

test('v3 migration rejects the wrong producer, another producer stack and an observed mismatch', () => {
  const { f, v2 } = v2Input();
  const runs = { platformRun: { run_id: 30, run_attempt: 2, artifact_id: 40 }, workloadRun: { run_id: 50, run_attempt: 1, artifact_id: 60 } };
  const swap = structuredClone(f.workloadRecord);
  swap.producer.repository = 'git-malu/AnyWear-Infra';
  assert.throws(() => buildV3Compatibility(v2, { ...runs, platformRecord: swap, platformBytes: f.bytes.workload,
    workloadRecord: swap, workloadBytes: f.bytes.workload }), /Stack producer differs|Platform deployment record producer/);
  const extra = structuredClone(f.platformRecord);
  extra.stacks.push({ ...extra.stacks[0], name: 'AnyWearWorkloadStack-beta' });
  assert.throws(() => buildV3Compatibility(v2, { ...runs, platformRecord: extra, platformBytes: f.bytes.platform,
    workloadRecord: f.workloadRecord, workloadBytes: f.bytes.workload }), /producer|stacks/);
  const stale = structuredClone(f.workloadRecord);
  stale.observed.service_sha = 'a'.repeat(40);
  assert.throws(() => buildV3Compatibility(v2, { ...runs, platformRecord: f.platformRecord, platformBytes: f.bytes.platform,
    workloadRecord: stale, workloadBytes: Buffer.from(`${JSON.stringify(stale, null, 2)}\n`) }), /observed Service/);
  assert.throws(() => buildV3Compatibility({ ...v2, version: 1 }, { ...runs, platformRecord: f.platformRecord,
    platformBytes: f.bytes.platform, workloadRecord: f.workloadRecord, workloadBytes: f.bytes.workload }), /v1 is historical/);
  assert.throws(() => buildV3Compatibility(v2, { ...runs, platformRecord: f.platformRecord, platformBytes: f.bytes.platform,
    workloadRecord: f.workloadRecord, workloadBytes: f.bytes.workload, workloadRun: { run_id: 0, run_attempt: 1, artifact_id: 60 } }), /run identity/);
});

test('migration CLI reads both v3 records and writes one candidate', () => {
  const args = ['--platform-record', 'platform.json', '--deployment-record', 'record.json', '--output', 'reviewed-v3.json'];
  assert.deepEqual(migrationArguments(args), {
    platformRecord: resolve('platform.json'),
    deploymentRecord: resolve('record.json'),
    outputPath: resolve('reviewed-v3.json'),
  });
  assert.throws(() => migrationArguments([...args, '--v1', 'alternate.json']), /Unsupported argument --v1/);
  assert.throws(() => migrationArguments([...args, '--output', 'other.json']), /only once/);
  assert.throws(() => migrationArguments(args.slice(0, -2)), /--output is required/);
  assert.throws(() => migrationArguments(['--platform-record', 'platform.json', '--output', 'out.json']), /--deployment-record is required/);
});

test('selects exactly one unexpired artifact bound to the exact producer workflow attempt', () => {
  const run = { id: 30, run_attempt: 2, head_sha: 'e'.repeat(40) };
  const artifact = { id: 40, name: 'infra-deployment-30-2', expired: false,
    workflow_run: { id: 30, head_sha: run.head_sha } };
  assert.equal(selectDeploymentArtifact([artifact], run).id, artifact.id);
  assert.equal(selectDeploymentArtifact([{ ...artifact, id: 60, name: 'service-deployment-50-1', workflow_run: { id: 50, head_sha: run.head_sha } }],
    { id: 50, run_attempt: 1, head_sha: run.head_sha }, 'service-deployment-50-1').id, 60);
  assert.throws(() => selectDeploymentArtifact([], run), /exactly one/);
  assert.throws(() => selectDeploymentArtifact([artifact, { ...artifact, id: 41 }], run), /exactly one/);
  assert.throws(() => selectDeploymentArtifact([{ ...artifact, expired: true }], run), /exactly one/);
  assert.throws(() => selectDeploymentArtifact([{ ...artifact, workflow_run: { id: 29, head_sha: run.head_sha } }], run), /exactly one/);
});

test('paginates producer artifacts through exact page boundaries and accepts a final partial page', async () => {
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
  }, 'git-malu/AnyWear-Service');
  assert.equal(result.length, 201);
  assert.deepEqual(requests.map((path) => new URL(`https://github.com/${path}`).searchParams.get('page')), ['1', '2', '3']);
  assert.ok(requests.every((path) => path.includes('repos/git-malu/AnyWear-Service/')));
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
