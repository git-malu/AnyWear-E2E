import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { byteHash } from './evidence-contract.mjs';
import {
  SERVICE_MANIFEST_NAME, readServiceRelease, runServiceRelease, serviceReleaseArguments, verifyServiceManifest,
} from './service-release.mjs';

const serviceSha = 'b'.repeat(40);
const imageDigest = `sha256:${'c'.repeat(64)}`;
const tag = `service-artifacts-${serviceSha}`;
const manifest = {
  schema_version: 1,
  record_type: 'anywear_service_artifacts',
  kind: 'source-build',
  producer: { repository: 'git-malu/AnyWear-Service' },
  components: { image: { service_sha: serviceSha, digest: imageDigest } },
};
const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
const manifestSha256 = byteHash(manifestBytes);
const release = { id: 10, tag_name: tag, draft: false, immutable: true, assets: [{ id: 11, name: SERVICE_MANIFEST_NAME }] };
const asset = {
  id: 11, name: SERVICE_MANIFEST_NAME, state: 'uploaded', size: manifestBytes.length, digest: `sha256:${manifestSha256}`,
};

// A GitHub API double. Every read the verifier performs is routed through it, so a test
// can fail exactly one call and prove the reader fails closed at that point.
function apiFor({ releaseRecord = release, assetRecord = asset, bytes = manifestBytes, fail = () => false, seen = [] } = {}) {
  return async (path, binary, environment) => {
    seen.push({ path, binary, environment });
    if (fail(path, binary)) throw new Error('gh: Not Found (HTTP 404)');
    if (path === `repos/git-malu/AnyWear-Service/releases/tags/${tag}`) return JSON.stringify(releaseRecord);
    if (path === `repos/git-malu/AnyWear-Service/releases/assets/11`) {
      return binary ? bytes : JSON.stringify(assetRecord);
    }
    throw new Error(`unexpected GitHub API path ${path}`);
  };
}

const READ_TOKEN = 'service-read-fixture';
const read = (overrides = {}) => readServiceRelease({
  serviceSha, imageDigest, api: apiFor(overrides), environment: { SERVICE_ARTIFACT_READ_TOKEN: READ_TOKEN, GH_TOKEN: 'ambient-token', GITHUB_TOKEN: 'workflow-token' },
});

test('resolves the live Service identity to its immutable release and manifest', async () => {
  const seen = [];
  const result = await readServiceRelease({
    serviceSha, imageDigest, api: apiFor({ seen }),
    environment: { SERVICE_ARTIFACT_READ_TOKEN: READ_TOKEN, GH_TOKEN: 'ambient-token', GITHUB_TOKEN: 'workflow-token' },
  });
  assert.deepEqual(result.identity, {
    repository: 'git-malu/AnyWear-Service',
    release_id: 10,
    tag,
    manifest_asset_id: 11,
    manifest_sha256: manifestSha256,
  });
  assert.deepEqual(result.manifest, manifest);
  assert.equal(byteHash(result.bytes), manifestSha256);
  // Every read is scoped to the Service token: the ambient workflow token and the inline
  // Service token are both replaced by the one scoped GH_TOKEN.
  assert.equal(seen.length, 3);
  for (const call of seen) {
    assert.equal(call.environment.GH_TOKEN, READ_TOKEN);
    assert.equal(call.environment.SERVICE_ARTIFACT_READ_TOKEN, undefined);
    assert.equal(call.environment.GITHUB_TOKEN, undefined);
  }
  // A missing scoped token refuses before any API call.
  await assert.rejects(readServiceRelease({ serviceSha, imageDigest, api: apiFor({ seen }), environment: {} }),
    /requires the scoped git-malu\/AnyWear-Service token: SERVICE_ARTIFACT_READ_TOKEN required/);
});

test('fails closed when the release is missing or an API read fails', async () => {
  await assert.rejects(read({ fail: (path) => path.includes('/releases/tags/') }),
    new RegExp(`Immutable Service release ${tag} could not be read from git-malu/AnyWear-Service`));
  await assert.rejects(read({ fail: (path, binary) => path.includes('/releases/assets/') && binary === false }),
    /Not Found/);
  await assert.rejects(read({ fail: (path, binary) => path.includes('/releases/assets/') && binary === true }),
    /Not Found/);
});

test('refuses a draft, non-immutable or mis-tagged release', async () => {
  await assert.rejects(read({ releaseRecord: { ...release, draft: true } }),
    /must be published \(draft true\)/);
  for (const immutable of [false, undefined, 'true']) {
    await assert.rejects(read({ releaseRecord: { ...release, immutable } }),
      /must be immutable/);
  }
  await assert.rejects(read({ releaseRecord: { ...release, tag_name: 'service-artifacts-other' } }),
    new RegExp(`Service release tag mismatch: expected ${tag}, observed "service-artifacts-other"`));
});

test('refuses a release without an uploaded service-artifacts.json manifest asset', async () => {
  await assert.rejects(read({ releaseRecord: { ...release, assets: [] } }),
    /has no service-artifacts\.json manifest asset/);
  await assert.rejects(read({ releaseRecord: { ...release, assets: [{ id: 11, name: 'other.json' }] } }),
    /has no service-artifacts\.json manifest asset/);
  await assert.rejects(read({ assetRecord: { ...asset, state: 'starter' } }),
    /Service manifest asset 11 metadata mismatch/);
  await assert.rejects(read({ assetRecord: { ...asset, name: 'other.json' } }),
    /Service manifest asset 11 metadata mismatch/);
});

test('refuses manifest bytes that do not match the asset digest or size', async () => {
  await assert.rejects(read({ bytes: Buffer.from('{}') }),
    new RegExp(`Service manifest size mismatch: expected ${manifestBytes.length} bytes`));
  await assert.rejects(read({ assetRecord: { ...asset, digest: `sha256:${'e'.repeat(64)}` } }),
    new RegExp(`Service manifest digest mismatch: expected sha256:${'e'.repeat(64)}`));
  // A missing asset digest is not a reason to trust the bytes: the manifest content is
  // still verified against the live identity below.
  await assert.rejects(read({ assetRecord: { ...asset, size: 2, digest: undefined }, bytes: Buffer.from('{}') }),
    /Service manifest is not schema_version 1/);
});

test('refuses a manifest that names another Service commit or image, naming both values', async () => {
  const otherSha = 'e'.repeat(40);
  const otherImage = `sha256:${'f'.repeat(64)}`;
  const wrongSha = Buffer.from(`${JSON.stringify({ ...manifest, components: { image: { service_sha: otherSha, digest: imageDigest } } })}`);
  await assert.rejects(read({ bytes: wrongSha, assetRecord: { ...asset, size: wrongSha.length, digest: `sha256:${byteHash(wrongSha)}` } }),
    new RegExp(`components\\.image\\.service_sha mismatch: expected ${serviceSha} \\(live /health\\), observed "${otherSha}" \\(manifest\\)`));
  const wrongDigest = Buffer.from(`${JSON.stringify({ ...manifest, components: { image: { service_sha: serviceSha, digest: otherImage } } })}`);
  await assert.rejects(read({ bytes: wrongDigest, assetRecord: { ...asset, size: wrongDigest.length, digest: `sha256:${byteHash(wrongDigest)}` } }),
    new RegExp(`components\\.image\\.digest mismatch: expected ${imageDigest} \\(live /health\\), observed "${otherImage}" \\(manifest\\)`));
  const wrongType = Buffer.from(`${JSON.stringify({ ...manifest, record_type: 'other' })}`);
  await assert.rejects(read({ bytes: wrongType, assetRecord: { ...asset, size: wrongType.length, digest: `sha256:${byteHash(wrongType)}` } }),
    /Service manifest is not schema_version 1 \/ record_type anywear_service_artifacts/);
  assert.throws(() => verifyServiceManifest({ ...manifest, schema_version: 2 }, { serviceSha, imageDigest }),
    /Service manifest is not schema_version 1/);
});

test('parses the CLI surface and refuses an unknown or incomplete one', () => {
  assert.deepEqual(serviceReleaseArguments([
    '--operation', 'full', '--client-url', 'https://client.example', '--service-url', 'https://api.example',
    '--expected-service-commit', serviceSha,
  ]), {
    operation: 'full', clientUrl: 'https://client.example', serviceUrl: 'https://api.example', expectedServiceCommit: serviceSha,
  });
  assert.deepEqual(serviceReleaseArguments(['--operation', 'recover']), { operation: 'recover' });
  assert.deepEqual(serviceReleaseArguments(['--help']), { help: true });
  for (const [argv, pattern] of [
    [[], /requires --operation/],
    [['--operation', 'preflight'], /does not know the operation/],
    [['--operation', 'full'], /requires --client-url/],
    [['--operation', 'smoke', '--client-url', 'https://client.example'], /requires --service-url/],
    [['--operation', 'full', '--client-url', 'https://client.example', '--service-url', 'https://api.example', '--unknown', 'x'], /Unknown service-release argument/],
    [['--operation', 'full', '--operation', 'smoke'], /Duplicate service-release argument/],
    [['--operation'], /requires a value/],
  ]) {
    assert.throws(() => serviceReleaseArguments(argv), pattern, argv.join(' '));
  }
});

const liveMetadata = () => ({
  client: {
    component: 'AnyWear-Client', schema_version: 3, source_commit: 'a'.repeat(40), client_version: 0,
    built_at: '2026-10-07T00:00:00.000Z',
  },
  service: { status: 'ok', service_commit: serviceSha, image_digest: imageDigest, minimum_client_version: 0 },
});
const fetcherFor = ({ client, service }) => async (url) => new Response(
  JSON.stringify(url.pathname === '/build-metadata.json' ? client : service), { status: 200 },
);

test('skips the live check for the operations that do not gate on the deployed tuple', async () => {
  let called = false;
  const result = await runServiceRelease({
    argv: ['--operation', 'recover'], api: () => { called = true; }, log: () => {},
  });
  assert.deepEqual(result, { skipped: true });
  assert.equal(called, false);
});

test('writes the verified live identity and release identity for the record', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'anywear-service-release-'));
  try {
    const metadata = liveMetadata();
    const result = await runServiceRelease({
      argv: [
        '--operation', 'full',
        '--client-url', 'https://client123.cloudfront.net',
        '--service-url', 'https://api123.cloudfront.net',
        '--expected-service-commit', serviceSha,
        '--expected-client-commit', 'a'.repeat(40),
      ],
      environment: { GITHUB_RUN_ID: '123', SERVICE_ARTIFACT_READ_TOKEN: READ_TOKEN },
      api: apiFor(),
      fetcher: fetcherFor(metadata),
      inputsDirectory: directory,
      log: () => {},
    });
    assert.equal(result.release.tag, tag);
    assert.deepEqual(JSON.parse(await readFile(join(directory, 'service-artifacts.json'), 'utf8')), result.release);
    assert.deepEqual(JSON.parse(await readFile(join(directory, 'live-identity.json'), 'utf8')), {
      client: {
        url: 'https://client123.cloudfront.net', source_commit: 'a'.repeat(40),
        built_at: '2026-10-07T00:00:00.000Z', client_version: 0,
      },
      service: {
        url: 'https://api123.cloudfront.net', service_commit: serviceSha,
        image_digest: imageDigest, minimum_client_version: 0,
      },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('refuses a wrong expectation or floor before the release read', async () => {
  const metadata = liveMetadata();
  let apiCalled = false;
  const run = (overrides = {}) => runServiceRelease({
    argv: [
      '--operation', 'full', '--client-url', 'https://client123.cloudfront.net', '--service-url', 'https://api123.cloudfront.net',
      ...(overrides.expected ?? ['--expected-service-commit', serviceSha]),
    ],
    environment: { GITHUB_RUN_ID: '123', SERVICE_ARTIFACT_READ_TOKEN: READ_TOKEN },
    api: () => { apiCalled = true; throw new Error('release read must not run'); },
    fetcher: fetcherFor({ ...metadata, ...overrides.metadata }),
    inputsDirectory: join(tmpdir(), 'anywear-service-release-unused'),
    log: () => {},
  });
  await assert.rejects(run({ expected: ['--expected-service-commit', 'f'.repeat(40)] }),
    /Deployed Service service_commit mismatch[^\n]*expected f{40} \(dispatch input\), observed b{40} \(live\)/);
  assert.equal(apiCalled, false);
  await assert.rejects(run({ metadata: { service: { ...metadata.service, minimum_client_version: 1 } } }),
    /sync minimum-supported-client\.json/);
  assert.equal(apiCalled, false);
  await assert.rejects(run(), /release read must not run/);
  assert.equal(apiCalled, true);
});
