import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { byteHash, payloadDigest, parseStrictJson, canonicalJson } from './evidence-contract.mjs';
import { qualificationFixture } from './fixtures/infra-qualification.mjs';
import { loadTrustedInputs, repositoryReadEnvironment } from './trusted-deployment-inputs.mjs';
import { assertNativeReleaseAttestation, RELEASE_PREDICATE_TYPE } from './vendor/vendor/service-release-attestation.mjs';
import { verifySelection, validateSelection } from './vendor/artifact-consumer.mjs';

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
  f.deployment.selection.sha256 = payloadDigest({ schema_version: 2, record_type: 'anywear_infra_selection',
    release: f.deployment.selection.release, ...f.deployment.selection.components });
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
  const attestations = []; const requests = [];
  const selector = { schema_version: 2, record_type: 'anywear_infra_selection',
    release: f.deployment.selection.release, ...f.deployment.selection.components };
  return { compatibility: f.compatibility, manifest, manifestBytes, selector, release, publisher, attestations, requests,
    io: {
      environment: { GH_TOKEN: 'infra-read-fixture', SERVICE_ARTIFACT_READ_TOKEN: 'service-read-fixture',
        GITHUB_TOKEN: 'unrelated-write-fixture', CLIENT_CONTENTS_READ_TOKEN: 'client-read-fixture' },
      api: async (path, binary, environment) => {
        requests.push({ path, environment });
        if (binary && path.endsWith('/zip')) return Buffer.from('archive-fixture');
        if (binary && path.endsWith('/assets/11')) return manifestBytes;
        if (!responses.has(path)) throw new Error(`Unexpected fixture API request: ${path}`);
        return JSON.stringify(responses.get(path));
      },
      extractRecord: async () => corruptRecord ? Buffer.from('{}') : recordBytes,
      verifySelectedInputs: async (compatibility, selection) => {
        assert.equal(selection.file, f.deployment.selection.file);
        assert.equal(selection.sha256, payloadDigest(selector));
        assert.equal(selection.release.manifest_sha256, compatibility.service_artifacts.manifest_sha256);
        attestations.push({ digest: byteHash(manifestBytes) });
        return { selector, manifest };
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

test('mixed trusted inputs route each API to its own reader without forwarding other credentials', async () => {
  const h = inputHarness();
  await withDirectory((directory) => loadTrustedInputs(h.compatibility, directory, h.io));
  assert.ok(h.requests.some(request => request.path.includes('/AnyWear-Infra/')));
  assert.ok(h.requests.some(request => request.path.includes('/AnyWear-Service/')));
  for (const { path, environment } of h.requests) {
    assert.equal(environment.GH_TOKEN, path.includes('/AnyWear-Infra/') ? 'infra-read-fixture' : 'service-read-fixture');
    for (const key of ['GITHUB_TOKEN', 'SERVICE_ARTIFACT_READ_TOKEN', 'CLIENT_CONTENTS_READ_TOKEN']) {
      assert.equal(environment[key], undefined);
    }
  }
  assert.equal(h.io.environment.GH_TOKEN, 'infra-read-fixture');
  assert.equal(h.io.environment.GITHUB_TOKEN, 'unrelated-write-fixture');
});

test('missing explicit readers fail before API requests and cannot fall back to ambient authentication', async () => {
  for (const key of ['GH_TOKEN', 'SERVICE_ARTIFACT_READ_TOKEN']) {
    const h = inputHarness(); delete h.io.environment[key];
    await withDirectory((directory) => assert.rejects(loadTrustedInputs(h.compatibility, directory, h.io), new RegExp(key)));
    assert.equal(h.requests.length, 0);
    assert.equal(h.attestations.length, 0);
  }
  const environment = { GH_TOKEN: 'infra-read-fixture', SERVICE_ARTIFACT_READ_TOKEN: 'service-read-fixture',
    CLIENT_CONTENTS_READ_TOKEN: 'client-read-fixture', GITHUB_TOKEN: 'unrelated-write-fixture' };
  assert.equal(repositoryReadEnvironment('git-malu/AnyWear-Client', environment).GH_TOKEN, 'client-read-fixture');
  assert.equal(repositoryReadEnvironment('git-malu/AnyWear-Service', environment).GH_TOKEN, 'service-read-fixture');
  assert.equal(repositoryReadEnvironment('git-malu/AnyWear-Infra', environment).GH_TOKEN, 'infra-read-fixture');
  assert.throws(() => repositoryReadEnvironment('git-malu/AnyWear-E2E', environment), /Unexpected repository/);
  delete environment.CLIENT_CONTENTS_READ_TOKEN;
  assert.throws(() => repositoryReadEnvironment('git-malu/AnyWear-Client', environment), /CLIENT_CONTENTS_READ_TOKEN/);
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
  const h = inputHarness(); h.io.verifySelectedInputs = async () => { throw new Error('Invalid release attestation'); };
  await withDirectory((directory) => assert.rejects(loadTrustedInputs(h.compatibility, directory, h.io), /attestation/));
});

// These fixtures inject post-gh policy results and public API records.
// They do not prove native signatures or deployed qualification.
function nativeResult(statement) {
  return { verificationResult: { statement, signature: { certificate: { subjectAlternativeName: 'https://dotcom.releases.github.com' } } },
    attestation: { bundle: { dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement)).toString('base64'),
      payloadType: 'application/vnd.in-toto+json', signatures: [{ sig: 'synthetic-policy-only' }] } } } };
}

function nativeHarness(version, { completeAssets = false } = {}) {
  const h = inputHarness(); const assetBytes = {};
  if (completeAssets) {
    const entry = { queueVisibilitySeconds: 30, receiveVisibilitySeconds: 20, dbLeaseMs: 30_000, sqsHeartbeatMs: 10_000,
      retryDelayBaseMs: 100, retryDelayMaxMs: 1_000, outboxRetryDelayMs: 100, outboxMaxAttempts: 3, maxAttempts: 3, maxReceives: 9, terminalRedriveSeconds: 10 };
    const policy = { vto: entry, 'auto-tagging': entry };
    const schema = { schema_version: 1, record_type: 'anywear_service_schema', current_version: 16, minimum_version: 16, minimum_migration_count: 1,
      journal: { version: '7', dialect: 'postgresql', entries: [{ idx: 0, version: '7', when: 1_000, tag: '0000_initial', breakpoints: true }] },
      migrations: [{ id: '0000_initial', idx: 0, created_at: 1_000, sha256: byteHash('offline SQL') }] };
    for (const [name, component] of Object.entries(h.manifest.components.lambdas)) {
      const bytes = Buffer.from(`offline ${name} ZIP bytes`); assetBytes[component.file] = bytes;
      component.sha256 = byteHash(bytes); component.code_sha256 = Buffer.from(component.sha256, 'hex').toString('base64');
    }
    assetBytes[h.manifest.components.runtime_policy.file] = Buffer.from(canonicalJson(policy));
    Object.assign(h.manifest.components.runtime_policy, { sha256: byteHash(assetBytes[h.manifest.components.runtime_policy.file]), content_sha256: payloadDigest(policy) });
    assetBytes[h.manifest.components.schema.file] = Buffer.from(canonicalJson(schema));
    Object.assign(h.manifest.components.schema, { sha256: byteHash(assetBytes[h.manifest.components.schema.file]), journal_sha256: payloadDigest(schema.journal) });
    for (const [name, component] of Object.entries(h.manifest.components.lambdas)) Object.assign(h.selector.lambdas[name], component);
    Object.assign(h.selector.runtime_policy, h.manifest.components.runtime_policy); Object.assign(h.selector.schema, h.manifest.components.schema);
    h.manifestBytes = Buffer.from(`${JSON.stringify(h.manifest, null, 2)}\n`);
    h.selector.release.manifest_sha256 = byteHash(h.manifestBytes);
  }
  const selected = [...Object.values(h.selector.lambdas), h.selector.runtime_policy, h.selector.schema];
  const assets = [{ id: 11, name: 'service-artifacts.json', size: h.manifestBytes.length, sha256: h.selector.release.manifest_sha256 },
    ...selected.map((component, index) => ({ id: component.asset_id, name: component.file, sha256: component.sha256, size: completeAssets ? assetBytes[component.file].length : index + 1 }))];
  const release = { ...h.release, target_commitish: h.manifest.producer.workflow_sha,
    assets: assets.map((asset) => ({ ...asset, state: 'uploaded', digest: 'sha256:' + asset.sha256 })) };
  const expected = { releaseId: release.id, tag: release.tag_name, target: h.manifest.producer.workflow_sha,
    assetHashes: Object.fromEntries(assets.map((asset) => [asset.name, asset.sha256])) };
  const purl = 'pkg:github/git-malu/AnyWear-Service@' + expected.tag;
  const identity = { ownerId: '11473072', repositoryId: '1158460323', repository: 'git-malu/AnyWear-Service', purl, tag: expected.tag };
  const statement = { _type: 'https://in-toto.io/Statement/v1',
    predicateType: version === 'v0.1' ? RELEASE_PREDICATE_TYPE : 'https://in-toto.io/attestation/release/v0.2',
    predicate: version === 'v0.1' ? { ...identity, releaseId: String(release.id) }
      : { ...identity, databaseId: String(release.id), packageId: identity.repositoryId },
    subject: [{ uri: purl, digest: { sha1: expected.target } }, ...assets.map((asset) => ({ name: asset.name, digest: { sha256: asset.sha256 } }))] };
  const repository = { full_name: identity.repository, id: 1158460323, owner: { id: 11473072, login: 'git-malu' } };
  const publisher = { ...h.publisher, repository, head_repository: repository };
  const requests = []; let nativeCalls = 0;
  const nativeVerification = nativeResult(statement);
  const io = {
    api: async endpoint => {
      requests.push(endpoint);
      if (endpoint.includes('/releases/')) return release;
      if (endpoint.includes('/git/ref/tags/')) return { object: { type: 'commit', sha: expected.target } };
      if (endpoint.includes('/actions/runs/')) return publisher;
      throw new Error('Unexpected direct consumer endpoint: ' + endpoint);
    },
    asset: async (repository, id) => {
      assert.equal(repository, 'git-malu/AnyWear-Service');
      return id === 11 ? h.manifestBytes : assetBytes[assets.find(asset => asset.id === id)?.name] ?? h.manifestBytes;
    },
    attestation: async () => { nativeCalls++; return nativeVerification; },
  };
  return { h, expected, statement, nativeVerification, release, publisher, requests, io, nativeCalls: () => nativeCalls };
}

async function withCommittedSelector(selector, action) {
  await withDirectory(async directory => {
    const git = args => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).trim();
    git(['init', '--quiet']); git(['config', 'user.email', 'fixture@anywear.local']); git(['config', 'user.name', 'Offline fixture']);
    git(['config', 'core.autocrlf', 'false']); git(['remote', 'add', 'origin', 'https://github.com/git-malu/AnyWear-Infra.git']);
    await mkdir(join(directory, 'selections')); await writeFile(join(directory, 'selections/test.json'), canonicalJson(selector));
    git(['add', 'selections']); git(['commit', '--quiet', '-m', 'Offline committed selection']);
    const output = await mkdtemp(join(tmpdir(), 'anywear-direct-output-'));
    try { await action({ trustedInfraRoot: directory, expectedInfraSha: git(['rev-parse', 'HEAD']),
      selectionFile: 'selections/test.json', selectionSha256: payloadDigest(selector) }, output); }
    finally { await rm(output, { recursive: true, force: true }); }
  });
}

for (const version of ['v0.1', 'v0.2']) {
  test(`synthetic ${version} parser preserves complete signed statement bytes`, () => {
    const current = nativeHarness(version); const payload = current.nativeVerification.attestation.bundle.dsseEnvelope.payload;
    assert.strictEqual(assertNativeReleaseAttestation(current.nativeVerification, current.expected), current.statement);
    assert.equal(current.statement.subject.length, 6);
    assert.deepEqual(parseStrictJson(Buffer.from(payload, 'base64')), current.statement);
    assert.equal(current.nativeVerification.attestation.bundle.dsseEnvelope.payload, payload);
  });

  test(`synthetic ${version} public parser rejects foreign, mixed, numeric and unknown identities`, () => {
    const current = nativeHarness(version); const idField = version === 'v0.1' ? 'releaseId' : 'databaseId';
    for (const mutate of [
      (s) => { s._type = 'https://in-toto.io/Statement/v0'; },
      (s) => { s.predicateType = 'https://in-toto.io/attestation/release/v0.3'; },
      (s) => { s.extra = true; },
      (s) => { s.predicate.ownerId = '1'; }, (s) => { s.predicate.ownerId = 11473072; },
      (s) => { s.predicate.repositoryId = '1'; }, (s) => { s.predicate.repositoryId = 1158460323; },
      (s) => { s.predicate.repository = 'foreign/AnyWear-Service'; },
      (s) => { s.predicate[idField] = '11'; }, (s) => { s.predicate[idField] = 10; },
      (s) => { delete s.predicate[idField]; },
      (s) => { s.predicate.purl = 'pkg:github/foreign/AnyWear-Service@tag'; },
      (s) => { s.predicate.tag = 'another-tag'; },
      (s) => { s.predicate.workflow_sha = current.expected.target; },
      (s) => { s.predicate[version === 'v0.1' ? 'databaseId' : 'releaseId'] = '10'; },
      ...(version === 'v0.2' ? [
        (s) => { s.predicate.packageId = '1'; }, (s) => { s.predicate.packageId = 1158460323; },
        (s) => { delete s.predicate.packageId; },
      ] : [(s) => { s.predicate.packageId = '1158460323'; }]),
    ]) {
      const statement = structuredClone(current.statement); mutate(statement);
      assert.throws(() => assertNativeReleaseAttestation(nativeResult(statement), current.expected));
    }
  });

  test(`synthetic ${version} public parser rejects SAN, DSSE and full-subject binding failures`, () => {
    const current = nativeHarness(version);
    for (const mutate of [
      (n) => { n.verificationResult.signature.certificate.subjectAlternativeName = 'https://github.com'; },
      (n) => { n.attestation.bundle.dsseEnvelope.payloadType = 'application/json'; },
      (n) => { n.attestation.bundle.dsseEnvelope.signatures = []; },
      (n) => { n.attestation.bundle.dsseEnvelope.payload = Buffer.from('{}').toString('base64'); },
      (n) => { n.attestation.bundle.dsseEnvelope.payload = Buffer.from(JSON.stringify(current.statement).replace('"_type":', '"_type":"duplicate","_type":')).toString('base64'); },
    ]) {
      const native = structuredClone(current.nativeVerification); mutate(native);
      assert.throws(() => assertNativeReleaseAttestation(native, current.expected));
    }
    for (const mutate of [
      (s) => { s.subject[0].digest.sha1 = 'c'.repeat(40); },
      (s) => { s.subject[0].uri += '-different'; },
      (s) => { s.subject[1].name = 'foreign.json'; },
      (s) => { s.subject[1].digest.sha256 = '0'.repeat(64); },
      (s) => { s.subject[1].extra = true; },
      (s) => { s.subject.pop(); },
      (s) => { s.subject.push(structuredClone(s.subject[1])); },
      (s) => { s.subject[2] = structuredClone(s.subject[1]); },
    ]) {
      const statement = structuredClone(current.statement); mutate(statement);
      assert.throws(() => assertNativeReleaseAttestation(nativeResult(statement), current.expected));
    }
  });

  test(`synthetic ${version} direct consumer rejects another individually valid native statement`, async () => {
    const current = nativeHarness(version); const reordered = structuredClone(current.statement); reordered.subject.reverse();
    const otherVersion = nativeHarness(version === 'v0.1' ? 'v0.2' : 'v0.1').nativeVerification;
    for (const different of [nativeResult(reordered), otherVersion]) {
      assertNativeReleaseAttestation(different, current.expected);
      let calls = 0;
      await withCommittedSelector(current.h.selector, (binding, directory) => assert.rejects(verifySelection(binding, directory,
        { ...current.io, attestation: async () => ++calls === 1 ? current.nativeVerification : different }), /different native statement/));
      assert.equal(calls, 2);
    }
  });

  test(`synthetic ${version} complete direct consumer verifies all six native results and rechecks producer/release/source`, async () => {
    const current = nativeHarness(version, { completeAssets: true });
    const payload = current.nativeVerification.attestation.bundle.dsseEnvelope.payload;
    await withCommittedSelector(current.h.selector, async (binding, directory) => {
      const result = await verifySelection(binding, directory, current.io);
      assert.deepEqual(result.selector, current.h.selector); assert.deepEqual(result.manifest, current.h.manifest);
      assert.equal(current.nativeCalls(), 6);
      assert.equal(current.requests.filter(endpoint => endpoint.includes('/actions/runs/')).length, 2);
      assert.equal(current.requests.filter(endpoint => endpoint.includes('/releases/')).length, 2);
      assert.equal(current.nativeVerification.attestation.bundle.dsseEnvelope.payload, payload);
      assert.ok((await readFile(join(directory, 'selection.json'))).equals(Buffer.from(canonicalJson(current.h.selector))));
      assert.ok((await readFile(join(directory, 'service-artifacts.json'))).equals(current.h.manifestBytes));
      assert.ok(current.requests.every(endpoint => !endpoint.includes('/actions/artifacts')));
    });
  });
}

test('complete direct consumer withholds verified selection when publisher/release/source changes after native verification', async () => {
  for (const change of ['publisher', 'release', 'source']) {
    const current = nativeHarness('v0.2', { completeAssets: true });
    await withCommittedSelector(current.h.selector, async (binding, directory) => {
      let calls = 0;
      const io = { ...current.io,
        api: async endpoint => {
          const result = await current.io.api(endpoint);
          if (calls === 6 && change === 'publisher' && endpoint.includes('/actions/runs/')) return { ...result, conclusion: 'failure' };
          if (calls === 6 && change === 'release' && endpoint.includes('/releases/')) return { ...result, target_commitish: 'f'.repeat(40) };
          return result;
        },
        attestation: async () => {
          calls++;
          if (calls === 6 && change === 'source') await writeFile(join(binding.trustedInfraRoot, binding.selectionFile), '{}');
          return current.nativeVerification;
        },
      };
      await assert.rejects(verifySelection(binding, directory, io), change === 'publisher' ? /publisher run/ : change === 'release' ? /identity changed/ : /clean/);
      assert.equal(calls, 6);
      await assert.rejects(readFile(join(directory, 'selection.json')), { code: 'ENOENT' });
      await assert.rejects(readFile(join(directory, 'verified-inputs.json')), { code: 'ENOENT' });
    });
  }
});

test('direct consumer fails closed on missing/foreign/failed producer and partial or changed release metadata', async () => {
  for (const mutate of [
    current => { current.publisher.conclusion = 'failure'; },
    current => { delete current.publisher.head_repository; },
    current => { current.publisher.repository.owner.login = 'foreign'; },
    current => { current.release.assets.pop(); },
    current => { current.release.assets[0].digest = 'sha256:' + '0'.repeat(64); },
    current => { current.release.assets[0].size++; },
    current => { current.release.target_commitish = 'a'.repeat(40); },
  ]) {
    const current = nativeHarness('v0.2'); mutate(current);
    await withCommittedSelector(current.h.selector, (binding, directory) => assert.rejects(verifySelection(binding, directory, current.io)));
    assert.equal(current.nativeCalls(), 0);
    assert.ok(current.requests.every(endpoint => !endpoint.includes('/actions/artifacts')));
  }
});

test('trusted input acceptance rejects missing or changed committed selection results without verified output', async () => {
  for (const mutate of [
    selector => { selector.release.id++; }, selector => { selector.schema_version = 1; },
    selector => { selector.runtime_policy.content_sha256 = 'b'.repeat(64); }, selector => { selector.publication_acceptance = {}; },
  ]) {
    const h = inputHarness(); const selector = structuredClone(h.selector); mutate(selector);
    h.io.verifySelectedInputs = async () => ({ selector, manifest: h.manifest });
    await withDirectory(async directory => {
      await assert.rejects(loadTrustedInputs(h.compatibility, directory, h.io));
      await assert.rejects(readFile(join(directory, 'verified-inputs.json')), { code: 'ENOENT' });
    });
  }
  const historical = inputHarness().selector; historical.schema_version = 1;
  assert.throws(() => validateSelection(historical), /historical v1/);
});

test('genuine failed release 406660922 remains parser-only evidence with unchanged original v0.2 statement/envelope', async () => {
  const file = new URL('./fixtures/github-native-release-verification-v0.2.json', import.meta.url);
  const raw = await readFile(file);
  assert.equal(raw.length, 5681);
  assert.equal(byteHash(raw), 'cf0bf9a5550ec9b475cb9b1fea68b793a39a2e640431deb69f075254d23ab0e2');
  const native = parseStrictJson(raw); const payload = native.attestation.bundle.dsseEnvelope.payload;
  const signedBytes = Buffer.from(payload, 'base64');
  assert.equal(byteHash(signedBytes), 'a146004b9e828e3395fdb6739b4cea1c1da7deff1508aed5d8ef967914369e2f');
  assert.deepEqual(parseStrictJson(signedBytes), native.verificationResult.statement);
  const expected = { releaseId: 406660922,
    tag: 'service-baseline-b5bb8ec69ec68a99a0a9c87ec8a84dc2b1ae8a29bb88e46f6808dc8d71c84332',
    target: '9e322b45ec7e5720b7d21776ac4f056b4fa2176d', assetHashes: {
      'post-confirmation.zip': 'd022c5472106e7d496e40532d8743526ebe3242874c22d9411d5641045b7a8c8',
      'pre-sign-up.zip': '075416781b949d8c936a8abfc1e5e062c4e5447acc056a04db18b45cc754ddc4',
      'runtime-policy.json': 'e53316ce3a694f68df1e49204f46b79f793134b045b8341d5aeb78d0ce8da083',
      'service-artifacts.json': 'b5bb8ec69ec68a99a0a9c87ec8a84dc2b1ae8a29bb88e46f6808dc8d71c84332',
      'service-schema.json': '3191e07204a127e73656028290f833eb38d38f955822390f8b8a803b27deb5fb',
    } };
  assert.strictEqual(assertNativeReleaseAttestation(native, expected), native.verificationResult.statement);
  assert.equal(payloadDigest(native.verificationResult.statement), '88c900b54c66a042490f91ec9a1443bb441f34102e6512b9b9b26040f46baa63');
  assert.equal(native.attestation.bundle.dsseEnvelope.payload, payload);
  assert.ok((await readFile(file)).equals(raw));
  // No successful publisher or runtime tuple is
  // fabricated from this authentic but unselectable failed-publication fixture.
});
