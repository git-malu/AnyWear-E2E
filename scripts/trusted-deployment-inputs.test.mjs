import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { byteHash, payloadDigest } from './evidence-contract.mjs';
import { qualificationFixture } from './fixtures/infra-qualification.mjs';
import { loadTrustedInputs } from './trusted-deployment-inputs.mjs';

function inputHarness({ baseline = false, alterManifest, alterRun, alterArtifact, alterRelease, corruptRecord = false } = {}) {
  const f = qualificationFixture();
  const strip = (component) => { const copy = { ...component }; delete copy.asset_id; return copy; };
  const manifest = {
    schema_version: 1, record_type: 'anywear_service_artifacts', kind: 'source-build',
    producer: { repository: 'git-malu/AnyWear-Service', workflow_sha: f.compatibility.service.sha,
      workflow_ref: 'git-malu/AnyWear-Service/.github/workflows/service-artifacts.yml@refs/heads/main', run_id: 50, run_attempt: 1 },
    components: { image: f.deployment.selection.components.image,
      lambdas: Object.fromEntries(Object.entries(f.deployment.selection.components.lambdas).map(([key, value]) => [key, strip(value)])),
      runtime_policy: strip(f.deployment.selection.components.runtime_policy), schema: strip(f.deployment.selection.components.schema) },
  };
  if (baseline) {
    manifest.kind = 'deployed-baseline-import';
    manifest.producer.workflow_sha = 'c'.repeat(40);
    for (const [purpose, component] of [
      ['image', manifest.components.image],
      ...Object.entries(manifest.components.lambdas),
      ['runtime_policy', manifest.components.runtime_policy], ['schema', manifest.components.schema],
    ]) {
      if (purpose !== 'image' && purpose !== 'schema') component.service_sha = 'f'.repeat(40);
      component.original_evidence = {
        repository: 'git-malu/AnyWear-Service', source_sha: component.service_sha,
        workflow_ref: 'git-malu/AnyWear-Service/.github/workflows/beta-deploy.yml@refs/heads/main',
        run_id: 60, run_attempt: 1, job_id: 70, run_conclusion: 'failure', job_conclusion: 'failure',
        artifact_phase: { name: 'artifact-build', conclusion: 'success', log_sha256: 'a'.repeat(64), start_line: 1, end_line: 2, log_excerpt: 'Reviewed successful artifact phase; later unrelated job failed.' },
      };
      if (component.code_sha256) component.original_evidence.deployed = {
        repository: 'git-malu/AnyWear-Service', source_sha: 'e'.repeat(40),
        workflow_ref: 'git-malu/AnyWear-Service/.github/workflows/beta-deploy.yml@refs/heads/main', run_id: 61, run_attempt: 1, job_id: 71,
        run_conclusion: 'success', job_conclusion: 'success',
        stack_name: 'AnyWearPlatformStack-beta', template_sha256: 'a'.repeat(64),
        asset_bucket: 'cdk-hnb659fds-assets-650880818323-ap-east-1', asset_key: `${component.sha256}.zip`, code_sha256: component.code_sha256,
      };
    }
    f.deployment.selection.components = {
      image: structuredClone(manifest.components.image),
      lambdas: Object.fromEntries(Object.entries(manifest.components.lambdas).map(([key, value]) => [key, { ...value, asset_id: f.deployment.selection.components.lambdas[key].asset_id }])),
      runtime_policy: { ...manifest.components.runtime_policy, asset_id: 22 }, schema: { ...manifest.components.schema, asset_id: 23 },
    };
  }
  alterManifest?.(manifest);
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  f.compatibility.service_artifacts.manifest_sha256 = byteHash(manifestBytes);
  f.deployment.selection.release.manifest_sha256 = byteHash(manifestBytes);
  f.deployment.selection.publication_acceptance.file = `publications/${byteHash(manifestBytes)}.json`;
  f.deployment.selection.sha256 = payloadDigest({ schema_version: 1, record_type: 'anywear_infra_selection',
    release: f.deployment.selection.release, publication_acceptance: f.deployment.selection.publication_acceptance, ...f.deployment.selection.components });
  const recordBytes = Buffer.from(`${JSON.stringify(f.deployment, null, 2)}\n`);
  f.compatibility.deployment.record_sha256 = byteHash(recordBytes);
  const repository = { full_name: 'git-malu/AnyWear-Infra' };
  const run = { id: 30, run_attempt: 2, repository, path: '.github/workflows/runtime.yml', head_sha: f.compatibility.infra.sha,
    head_branch: 'main', event: 'workflow_dispatch', status: 'completed', conclusion: 'success',
    run_started_at: '2026-10-08T00:00:00Z', updated_at: '2026-10-08T00:10:00Z' };
  alterRun?.(run);
  const artifact = { id: 40, name: 'infra-deployment-30-2', expired: false, expires_at: '2099-01-01T00:00:00Z',
    created_at: '2026-10-08T00:05:00Z', workflow_run: { id: 30, head_sha: f.compatibility.infra.sha } };
  alterArtifact?.(artifact);
  const asset = { id: 11, name: 'service-artifacts.json', state: 'uploaded' };
  const release = { id: 10, immutable: true, draft: false, assets: [asset], tag_name: baseline ? `service-baseline-${byteHash(manifestBytes)}` : `service-artifacts-${f.compatibility.service.sha}` };
  alterRelease?.(release);
  const publisher = { id: 50, run_attempt: 1, repository: { full_name: 'git-malu/AnyWear-Service' },
    path: '.github/workflows/service-artifacts.yml', head_sha: manifest.producer.workflow_sha, head_branch: 'main',
    event: 'workflow_dispatch', status: 'completed', conclusion: 'success' };
  const responses = new Map([
    ['repos/git-malu/AnyWear-Infra/actions/runs/30/attempts/2', run],
    ['repos/git-malu/AnyWear-Infra/actions/artifacts/40', artifact],
    ['repos/git-malu/AnyWear-Service/releases/10', release],
    ['repos/git-malu/AnyWear-Service/releases/assets/11', asset],
    ['repos/git-malu/AnyWear-Service/actions/runs/50/attempts/1', publisher],
    [`repos/git-malu/AnyWear-Service/git/ref/tags/${release.tag_name}`, { object: { type: 'commit', sha: manifest.producer.workflow_sha } }],
  ]);
  const attestations = [];
  return { compatibility: f.compatibility, attestations,
    io: {
      api: async (path, binary) => {
        if (binary && path.endsWith('/zip')) return Buffer.from('archive-fixture');
        if (binary && path.endsWith('/assets/11')) return manifestBytes;
        if (!responses.has(path)) throw new Error(`Unexpected fixture API request: ${path}`);
        return JSON.stringify(responses.get(path));
      },
      extractRecord: async () => corruptRecord ? Buffer.from('{}') : recordBytes,
      verifySelectedPublication: async (compatibility, selector) => {
        assert.equal(selector.release.manifest_sha256, compatibility.service_artifacts.manifest_sha256);
        attestations.push({ digest: byteHash(manifestBytes) });
        return { manifest };
      },
    },
  };
}

async function withDirectory(action) {
  const directory = await mkdtemp(join(tmpdir(), 'anywear-e2e-contract-'));
  try { return await action(directory); }
  finally { await rm(directory, { recursive: true }); }
}

test('retrieves exact trusted attempt/artifact/manifest and requires attestation before accepting inputs', async () => {
  const harness = inputHarness();
  await withDirectory(async (directory) => {
    const result = await loadTrustedInputs(harness.compatibility, directory, harness.io);
    assert.equal(result.manifest.components.image.service_sha, harness.compatibility.service.sha);
    assert.equal(harness.attestations.length, 1);
    assert.equal(harness.attestations[0].digest, harness.compatibility.service_artifacts.manifest_sha256);
    assert.ok((await readFile(join(directory, 'verified-inputs.json'))).length > 0);
  });
});

test('baseline import retains independent component sources and original failure outcomes', async () => {
  const h = inputHarness({ baseline: true });
  await withDirectory(async (directory) => {
    const result = await loadTrustedInputs(h.compatibility, directory, h.io);
    assert.notEqual(result.manifest.producer.workflow_sha, result.manifest.components.image.service_sha);
    assert.notEqual(result.manifest.components.lambdas.pre_sign_up.service_sha, result.manifest.components.image.service_sha);
    assert.equal(result.manifest.components.lambdas.pre_sign_up.original_evidence.run_conclusion, 'failure');
    assert.equal(result.manifest.components.lambdas.pre_sign_up.original_evidence.artifact_phase.conclusion, 'success');
  });
  const invalid = inputHarness({ baseline: true, alterManifest: (m) => { m.components.lambdas.pre_sign_up.original_evidence.artifact_phase.conclusion = 'failure'; } });
  await withDirectory((directory) => assert.rejects(loadTrustedInputs(invalid.compatibility, directory, invalid.io)));
});

test('rejects unavailable, expired, unsuccessful or byte-tampered trusted inputs', async () => {
  for (const options of [
    { alterRun: (r) => { r.status = 'in_progress'; } },
    { alterRun: (r) => { r.run_attempt = 1; } },
    { alterArtifact: (a) => { a.expired = true; } },
    { alterArtifact: (a) => { a.name = 'infra-deployment-30-1'; } },
    { alterRelease: (r) => { r.immutable = false; } },
    { alterRelease: (r) => { r.assets = []; } },
    { corruptRecord: true },
  ]) {
    const h = inputHarness(options);
    await withDirectory((directory) => assert.rejects(loadTrustedInputs(h.compatibility, directory, h.io)));
  }
});

test('attested manifest cannot disagree with selected Lambda, policy, schema or source-build publisher', async () => {
  for (const alterManifest of [
    (m) => { m.components.runtime_policy.content_sha256 = 'b'.repeat(64); },
    (m) => { m.components.schema.minimum_version = 15; },
    (m) => { m.components.lambdas.pre_sign_up.source_lock_sha256 = 'b'.repeat(64); },
    (m) => { m.producer.workflow_sha = 'c'.repeat(40); },
    (m) => { m.components.runtime_policy.extra = true; },
  ]) {
    const h = inputHarness({ alterManifest });
    await withDirectory((directory) => assert.rejects(loadTrustedInputs(h.compatibility, directory, h.io)));
    assert.equal(h.attestations.length, 0);
  }
  const h = inputHarness(); h.io.verifySelectedPublication = async () => { throw new Error('Invalid release attestation'); };
  await withDirectory((directory) => assert.rejects(loadTrustedInputs(h.compatibility, directory, h.io), /attestation/));
});
