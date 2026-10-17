import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertEqual, byteHash } from './evidence-contract.mjs';
import { qualificationFixture } from './fixtures/infra-qualification.mjs';
import {
  assertDeploymentBinding, assertSealedRelease, assertTrustedArtifact, assertTrustedRun,
  ghApi, loadTrustedInputs, repositoryReadEnvironment,
} from './trusted-deployment-inputs.mjs';

function inputHarness({
  alterPlatformRecord, alterWorkloadRecord, alterPlatformRun, alterWorkloadRun,
  alterPlatformArtifact, alterWorkloadArtifact, alterRelease, corruptPlatformRecord = false,
  corruptWorkloadRecord = false, deferred = false,
} = {}) {
  const f = qualificationFixture({ deferred });
  const manifest = {
    schema_version: 1, record_type: 'anywear_service_artifacts', kind: 'source-build',
    producer: { repository: 'git-malu/AnyWear-Service', workflow_sha: f.compatibility.service.sha,
      workflow_ref: 'git-malu/AnyWear-Service/.github/workflows/service-artifacts.yml@refs/heads/main', run_id: 70, run_attempt: 1 },
    components: { image: { repository_uri: '650880818323.dkr.ecr.ap-east-1.amazonaws.com/beta-anywear-service',
      digest: f.workloadRecord.observed.image_digest, service_sha: f.compatibility.service.sha } },
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  f.compatibility.service_artifacts.manifest_sha256 = byteHash(manifestBytes);
  alterPlatformRecord?.(f.platformRecord);
  alterWorkloadRecord?.(f.workloadRecord);
  const platformBytes = Buffer.from(`${JSON.stringify(f.platformRecord, null, 2)}\n`);
  const workloadBytes = Buffer.from(`${JSON.stringify(f.workloadRecord, null, 2)}\n`);
  const platformRun = { id: 30, run_attempt: 2, repository: { full_name: 'git-malu/AnyWear-Infra' },
    path: '.github/workflows/runtime.yml', head_sha: f.compatibility.platform.producer_sha,
    head_branch: 'main', event: 'workflow_dispatch', status: 'completed', conclusion: 'success',
    run_started_at: '2026-10-08T00:00:00Z', updated_at: '2026-10-08T00:10:00Z' };
  const workloadRun = { id: 50, run_attempt: 1, repository: { full_name: 'git-malu/AnyWear-Service' },
    path: '.github/workflows/service-artifacts.yml', head_sha: f.compatibility.workload.producer_sha,
    head_branch: 'main', event: 'workflow_dispatch', status: 'completed', conclusion: 'success',
    run_started_at: '2026-10-08T00:00:00Z', updated_at: '2026-10-08T00:10:00Z' };
  alterPlatformRun?.(platformRun); alterWorkloadRun?.(workloadRun);
  const platformArtifact = { id: 40, name: 'infra-deployment-30-2', expired: false, expires_at: '2099-01-01T00:00:00Z',
    created_at: '2026-10-08T00:05:00Z', workflow_run: { id: 30, head_sha: platformRun.head_sha } };
  const workloadArtifact = { id: 60, name: 'service-deployment-50-1', expired: false, expires_at: '2099-01-01T00:00:00Z',
    created_at: '2026-10-08T00:05:00Z', workflow_run: { id: 50, head_sha: workloadRun.head_sha } };
  alterPlatformArtifact?.(platformArtifact); alterWorkloadArtifact?.(workloadArtifact);
  const asset = { id: 11, name: 'service-artifacts.json', state: 'uploaded' };
  const release = { id: 10, immutable: true, draft: false, assets: [asset],
    tag_name: `service-artifacts-${f.compatibility.service.sha}` };
  alterRelease?.(release);
  const responses = new Map([
    ['repos/git-malu/AnyWear-Infra/actions/runs/30/attempts/2', platformRun],
    ['repos/git-malu/AnyWear-Infra/actions/artifacts/40', platformArtifact],
    ['repos/git-malu/AnyWear-Service/actions/runs/50/attempts/1', workloadRun],
    ['repos/git-malu/AnyWear-Service/actions/artifacts/60', workloadArtifact],
    ['repos/git-malu/AnyWear-Service/releases/10', release],
    ['repos/git-malu/AnyWear-Service/releases/assets/11', asset],
  ]);
  const requests = [];
  return {
    compatibility: f.compatibility,
    platformRecord: f.platformRecord,
    workloadRecord: f.workloadRecord,
    platformBytes,
    workloadBytes,
    manifest,
    manifestBytes,
    requests,
    io: {
      environment: { GH_TOKEN: 'infra-read-fixture', SERVICE_ARTIFACT_READ_TOKEN: 'service-read-fixture',
        GITHUB_TOKEN: 'unrelated-write-fixture', E2E_EVIDENCE_READ_TOKEN: 'e2e-read-fixture',
        INFRA_EVIDENCE_READ_TOKEN: 'infra-evidence-fixture', CLIENT_CONTENTS_READ_TOKEN: 'client-read-fixture' },
      api: async (path, binary) => {
        requests.push({ path, binary });
        if (binary && path.endsWith('/zip')) return Buffer.from('archive-fixture');
        if (binary && path.endsWith('/releases/assets/11')) return manifestBytes;
        if (!responses.has(path)) throw new Error(`Unexpected fixture API request: ${path}`);
        return JSON.stringify(responses.get(path));
      },
      extractRecord: async (_archivePath, member) => corruptPlatformRecord && member === 'deployment-record.json'
        ? Buffer.from('{}')
        : corruptWorkloadRecord && member === 'service-deployment.json'
          ? Buffer.from('{}')
          : member === 'deployment-record.json' ? platformBytes : workloadBytes,
    },
  };
}

test('ghApi downloads binary artifact bytes through the JSON media type with scoped credentials', () => {
  const archive = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff]);
  const environment = { GH_TOKEN: 'infra-read-fixture' };
  let request;
  const result = ghApi('repos/git-malu/AnyWear-Infra/actions/artifacts/40/zip', true, environment,
    { execute: (command, args, options) => {
      request = { command, args, options };
      return archive;
    } });

  assert.equal(request.command, 'gh');
  assert.deepEqual(request.args, [
    'api', 'repos/git-malu/AnyWear-Infra/actions/artifacts/40/zip',
    '-H', 'Accept: application/json',
  ]);
  assert.equal(request.options.encoding, undefined);
  assert.equal(request.options.env, environment);
  assert.deepEqual(result, archive);
});

test('ghApi downloads release asset bytes with octet-stream and preserves binary output', () => {
  const manifest = Buffer.from('{"record_type":"anywear_service_artifacts"}\n', 'utf8');
  const environment = { GH_TOKEN: 'service-read-fixture' };
  let request;
  const result = ghApi('repos/git-malu/AnyWear-Service/releases/assets/11', true, environment,
    { execute: (command, args, options) => {
      request = { command, args, options };
      return manifest;
    } });

  assert.equal(request.command, 'gh');
  assert.deepEqual(request.args, [
    'api', 'repos/git-malu/AnyWear-Service/releases/assets/11',
    '-H', 'Accept: application/octet-stream',
  ]);
  assert.equal(request.options.encoding, undefined);
  assert.equal(request.options.env, environment);
  assert.deepEqual(result, manifest);
  assert.equal(byteHash(result), byteHash(manifest));
});

async function withDirectory(action) {
  const directory = await mkdtemp(join(tmpdir(), 'anywear-e2e-contract-'));
  try { return await action(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('retrieves both producer records and the immutable Service release before accepting inputs', async () => {
  const harness = inputHarness();
  await withDirectory(async (directory) => {
    const result = await loadTrustedInputs(harness.compatibility, directory, harness.io);
    assert.deepEqual(result.platform, harness.platformRecord);
    assert.deepEqual(result.workload, harness.workloadRecord);
    assert.equal(result.manifest.components.image.service_sha, harness.compatibility.service.sha);
    assert.ok((await readFile(join(directory, 'verified-inputs.json'))).length > 0);
    assert.ok((await readFile(join(directory, 'platform-deployment-record.json'))).equals(harness.platformBytes));
    assert.ok((await readFile(join(directory, 'deployment-record.json'))).equals(harness.workloadBytes));
    assert.ok((await readFile(join(directory, 'service-artifacts.json'))).equals(harness.manifestBytes));
  });
});

test('each producer read uses only its own reader token', async () => {
  const h = inputHarness();
  await withDirectory((directory) => loadTrustedInputs(h.compatibility, directory, h.io));
  assert.ok(h.requests.some(request => request.path.includes('/AnyWear-Infra/')));
  assert.ok(h.requests.some(request => request.path.includes('/AnyWear-Service/')));
  for (const { path } of h.requests) assert.ok(path.includes('/AnyWear-Infra/') || path.includes('/AnyWear-Service/'));
  assert.equal(h.io.environment.GH_TOKEN, 'infra-read-fixture');
  assert.equal(h.io.environment.GITHUB_TOKEN, 'unrelated-write-fixture');
});

test('missing explicit readers fail before API requests and cannot fall back to ambient authentication', async () => {
  for (const key of ['GH_TOKEN', 'SERVICE_ARTIFACT_READ_TOKEN']) {
    const h = inputHarness(); delete h.io.environment[key];
    await withDirectory((directory) => assert.rejects(loadTrustedInputs(h.compatibility, directory, h.io), new RegExp(key)));
    assert.equal(h.requests.length, 0);
  }
  const environment = { GH_TOKEN: 'infra-read-fixture', SERVICE_ARTIFACT_READ_TOKEN: 'service-read-fixture',
    CLIENT_CONTENTS_READ_TOKEN: 'client-read-fixture', E2E_EVIDENCE_READ_TOKEN: 'e2e-read-fixture',
    INFRA_EVIDENCE_READ_TOKEN: 'infra-evidence-fixture', GITHUB_TOKEN: 'unrelated-write-fixture' };
  assert.equal(repositoryReadEnvironment('git-malu/AnyWear-Client', environment).GH_TOKEN, 'client-read-fixture');
  assert.equal(repositoryReadEnvironment('git-malu/AnyWear-Service', environment).GH_TOKEN, 'service-read-fixture');
  assert.equal(repositoryReadEnvironment('git-malu/AnyWear-Infra', environment).GH_TOKEN, 'infra-read-fixture');
  assert.throws(() => repositoryReadEnvironment('git-malu/AnyWear-E2E', environment), /Unexpected repository/);
  delete environment.CLIENT_CONTENTS_READ_TOKEN;
  assert.throws(() => repositoryReadEnvironment('git-malu/AnyWear-Client', environment), /CLIENT_CONTENTS_READ_TOKEN/);
});

test('a deferred pin fails closed before downloading or observing anything', async () => {
  const h = inputHarness({ deferred: true });
  await withDirectory(async (directory) => {
    await assert.rejects(loadTrustedInputs(h.compatibility, directory, h.io), /Deployment evidence deferred/);
    assert.equal(h.requests.length, 0);
  });
});

test('rejects unavailable, expired, unsuccessful, byte-tampered or foreign producer inputs', async () => {
  for (const options of [
    { alterPlatformRun: (run) => { run.status = 'in_progress'; } },
    { alterPlatformRun: (run) => { run.run_attempt = 1; } },
    { alterPlatformRun: (run) => { run.head_sha = 'a'.repeat(40); } },
    { alterWorkloadRun: (run) => { run.conclusion = 'failure'; } },
    { alterWorkloadRun: (run) => { run.path = '.github/workflows/publish.yml'; } },
    { alterPlatformArtifact: (artifact) => { artifact.expired = true; } },
    { alterPlatformArtifact: (artifact) => { artifact.name = 'infra-deployment-30-1'; } },
    { alterWorkloadArtifact: (artifact) => { artifact.id = 61; } },
    { alterWorkloadArtifact: (artifact) => { artifact.name = 'service-deployment-50-2'; } },
    { alterRelease: (release) => { release.immutable = false; } },
    { alterRelease: (release) => { release.assets = []; } },
    { corruptPlatformRecord: true },
    { corruptWorkloadRecord: true },
  ]) {
    const h = inputHarness(options);
    await withDirectory((directory) => assert.rejects(loadTrustedInputs(h.compatibility, directory, h.io)));
  }
});

test('producer, stack and observed application bindings refuse a valid record for another tuple', async () => {
  for (const options of [
    { alterPlatformRecord: (record) => { record.producer.sha = 'a'.repeat(40); } },
    { alterPlatformRecord: (record) => { record.producer.repository = 'git-malu/AnyWear-Service'; } },
    { alterPlatformRecord: (record) => { record.stacks.pop(); } },
    { alterPlatformRecord: (record) => { record.observed.client_sha = 'b'.repeat(40); } },
    { alterWorkloadRecord: (record) => { record.producer.repository = 'git-malu/AnyWear-Infra'; } },
    { alterWorkloadRecord: (record) => { record.stacks[0].name = 'AnyWearPlatformStack-beta'; } },
    { alterWorkloadRecord: (record) => { record.observed.service_sha = 'a'.repeat(40); } },
    { alterWorkloadRecord: (record) => { record.inputs.push({ ...record.inputs[0] }); } },
    { alterWorkloadRecord: (record) => { record.schema.content_sha256 = 'short'; } },
  ]) {
    const h = inputHarness(options);
    await withDirectory((directory) => assert.rejects(loadTrustedInputs(h.compatibility, directory, h.io)));
  }
});

test('a sealed release tag, manifest byte hash and manifest source must match the pin', async () => {
  const h = inputHarness({ alterRelease: (release) => { release.tag_name = 'service-artifacts-other'; } });
  await withDirectory((directory) => assert.rejects(loadTrustedInputs(h.compatibility, directory, h.io)));
  const mismatched = inputHarness();
  mismatched.compatibility.service_artifacts.manifest_sha256 = 'b'.repeat(64);
  await withDirectory((directory) => assert.rejects(loadTrustedInputs(mismatched.compatibility, directory, mismatched.io)));
});

test('deployment binding names the producer and the differing field', () => {
  const f = qualificationFixture();
  assert.doesNotThrow(() => assertDeploymentBinding(f.platformRecord, f.compatibility));
  assert.doesNotThrow(() => assertDeploymentBinding(f.workloadRecord, f.compatibility));
  const wrongProducer = structuredClone(f.platformRecord);
  wrongProducer.producer.run_attempt = 1;
  assert.throws(() => assertDeploymentBinding(wrongProducer, f.compatibility), /Deployment record producer attempt mismatch/);
  const wrongClient = structuredClone(f.platformRecord);
  wrongClient.observed.client_sha = 'f'.repeat(40);
  assert.throws(() => assertDeploymentBinding(wrongClient, f.compatibility), /observed Client .* differs from compatibility\.client\.sha/);
  const deferred = qualificationFixture({ deferred: true }).compatibility;
  assert.throws(() => assertDeploymentBinding(f.platformRecord, deferred), /Deployment evidence deferred/);
});

test('trusted run/artifact bindings require the exact producer workflow attempt and lifetime', () => {
  const f = qualificationFixture();
  const platformSha = f.compatibility.platform.producer_sha;
  const run = { id: 30, run_attempt: 2, repository: { full_name: 'git-malu/AnyWear-Infra' }, path: '.github/workflows/runtime.yml',
    head_sha: platformSha, head_branch: 'main', event: 'workflow_dispatch', status: 'completed', conclusion: 'success',
    run_started_at: '2026-10-08T00:00:00Z', updated_at: '2026-10-08T00:10:00Z' };
  const expected = { repository: 'git-malu/AnyWear-Infra', workflow_path: '.github/workflows/runtime.yml',
    run_id: 30, run_attempt: 2, sha: platformSha };
  assert.doesNotThrow(() => assertTrustedRun(run, expected));
  for (const patch of [{ conclusion: 'failure' }, { status: 'in_progress' }, { run_attempt: 1 }, { head_branch: 'topic' }, { path: '.github/workflows/other.yml' }, { repository: { full_name: 'other/Infra' } }]) {
    assert.throws(() => assertTrustedRun({ ...run, ...patch }, expected));
  }
  const now = new Date('2026-10-08T00:20:00Z').getTime();
  const artifact = { id: 40, name: 'infra-deployment-30-2', expired: false, expires_at: '2026-10-09T00:00:00Z',
    created_at: '2026-10-08T00:05:00Z', workflow_run: { id: 30, head_sha: platformSha } };
  const artifactExpected = { ...expected, artifact_id: 40, artifact_name: 'infra-deployment-30-2' };
  assert.doesNotThrow(() => assertTrustedArtifact(artifact, artifactExpected, run, now));
  for (const patch of [{ expired: true }, { id: 41 }, { name: 'infra-deployment-30-1' }, { expires_at: new Date(now).toISOString() }, { created_at: '2026-10-07T00:00:00Z' }]) {
    assert.throws(() => assertTrustedArtifact({ ...artifact, ...patch }, artifactExpected, run, now));
  }
});

test('service_artifacts remains evidence-only and still refuses an unsealed or foreign release', () => {
  const f = qualificationFixture();
  const manifest = { schema_version: 1, record_type: 'anywear_service_artifacts', kind: 'source-build',
    producer: { repository: 'git-malu/AnyWear-Service' },
    components: { image: { service_sha: f.compatibility.service.sha, digest: f.workloadRecord.observed.image_digest } } };
  const asset = { id: 11, name: 'service-artifacts.json', state: 'uploaded' };
  const release = { id: 10, immutable: true, draft: false, assets: [asset], tag_name: `service-artifacts-${f.compatibility.service.sha}` };
  assert.doesNotThrow(() => assertSealedRelease(release, asset, manifest, f.compatibility));
  assert.throws(() => assertSealedRelease({ ...release, immutable: false }, asset, manifest, f.compatibility), /sealed immutable/);
  assert.throws(() => assertSealedRelease(release, { ...asset, name: 'other.json' }, manifest, f.compatibility), /asset identity/);
  assert.throws(() => assertSealedRelease(release, asset, { ...manifest, record_type: 'other' }, f.compatibility), /Unsupported Service manifest/);
  assert.throws(() => assertSealedRelease({ ...release, tag_name: 'other' }, asset, manifest, f.compatibility), /tag binding/);
});

test('#138: an ECS task-definition revision is audit information, not identity', () => {
  // The v3 record pins exact bytes and template/input content hashes; the ECS
  // revision inside the Service record is audit information. A revision bump with
  // unchanged content still binds, and a content comparison names the differing
  // path with both values.
  const f = qualificationFixture();
  const bumped = structuredClone(f.workloadRecord);
  bumped.observed.ecs.api.task_definition_arn = bumped.observed.ecs.api.task_definition_arn.replace(/:\d+$/, ':99');
  bumped.observed.ecs.worker.task_definition_arn = bumped.observed.ecs.worker.task_definition_arn.replace(/:\d+$/, ':98');
  assert.doesNotThrow(() => assertDeploymentBinding(bumped, f.compatibility));
  const manifest = { components: { image: { digest: f.workloadRecord.observed.image_digest } } };
  const wrong = { components: { image: { digest: `sha256:${'f'.repeat(64)}` } } };
  assert.throws(() => assertEqual(wrong.components.image.digest, manifest.components.image.digest, 'Service manifest image digest'),
    /Service manifest image digest mismatch at <root>: expected/);
});
