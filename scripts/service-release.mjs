import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { byteHash, parseStrictJson, requireCommit, requireId, requireImageDigest, repositories } from './evidence-contract.mjs';
import { ghApi, repositoryReadEnvironment } from './github-read.mjs';
import { collectDeploymentEvidence, serviceArtifactsTag } from './qualification-record.mjs';

// #180: the live Service identity must resolve to one immutable release, and this is
// the credential-free reader that proves it. It performs no AWS call and no mutation:
// one GitHub API read of `service-artifacts-<sha>`, one asset metadata read, one asset
// bytes read. The release must be published (not draft), immutable, tagged with the
// exact live Service commit, and its `service-artifacts.json` manifest must name the
// same Service commit and image digest the live `/health` states.
//
// This replaces the pinned release identity the compatibility file used to carry: the
// expected values now come from the live deployment, and the reader discovers the
// release by the tag the Service release chain publishes. A missing release, a
// non-immutable release, a missing or mismatched manifest, an HTTP failure and a floor
// mismatch all fail closed before any AWS credential is requested.
export const SERVICE_MANIFEST_NAME = 'service-artifacts.json';
export const SERVICE_MANIFEST_RECORD_TYPE = 'anywear_service_artifacts';
export const SERVICE_MANIFEST_SCHEMA_VERSION = 1;
// The operations whose gate depends on the live deployed tuple. `recover` deliberately
// does not consult it: recovery must stay available when the live environment is unhealthy.
export const LIVE_OPERATIONS = Object.freeze(['full', 'smoke']);

const describe = (value) => {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

export function verifyServiceManifest(manifest, { serviceSha, imageDigest }) {
  if (manifest?.schema_version !== SERVICE_MANIFEST_SCHEMA_VERSION
    || manifest?.record_type !== SERVICE_MANIFEST_RECORD_TYPE) {
    throw new Error(`Service manifest is not schema_version ${SERVICE_MANIFEST_SCHEMA_VERSION} / record_type ${SERVICE_MANIFEST_RECORD_TYPE} (observed schema_version ${describe(manifest?.schema_version)}, record_type ${describe(manifest?.record_type)})`);
  }
  const image = manifest.components?.image;
  if (image?.service_sha !== serviceSha) {
    throw new Error(`Service manifest components.image.service_sha mismatch: expected ${serviceSha} (live /health), observed ${describe(image?.service_sha)} (manifest)`);
  }
  if (image?.digest !== imageDigest) {
    throw new Error(`Service manifest components.image.digest mismatch: expected ${imageDigest} (live /health), observed ${describe(image?.digest)} (manifest)`);
  }
  return manifest;
}

export async function readServiceRelease({ serviceSha, imageDigest, repository = repositories.service, api = ghApi, environment = process.env } = {}) {
  requireCommit(serviceSha, 'Live Service commit');
  requireImageDigest(imageDigest);
  // The read is scoped to exactly one repository: the Service App token is renamed to
  // GH_TOKEN for the child command and every other reader token is removed. Resolving it
  // here (not only in the workflow's step env) keeps a local CLI run working and means the
  // caller cannot accidentally read another repository with this token.
  let scopedEnvironment;
  try {
    scopedEnvironment = repositoryReadEnvironment(repository, environment);
  } catch (error) {
    throw new Error(`Service release read requires the scoped ${repository} token: ${error.message}`, { cause: error });
  }
  const tag = serviceArtifactsTag(serviceSha);
  let release;
  try {
    release = parseStrictJson(await api(`repos/${repository}/releases/tags/${tag}`, false, scopedEnvironment));
  } catch (error) {
    throw new Error(`Immutable Service release ${tag} could not be read from ${repository}: no published release names the live Service commit (${String(error.message ?? error).split('\n')[0]})`, { cause: error });
  }
  if (release?.tag_name !== tag) {
    throw new Error(`Service release tag mismatch: expected ${tag}, observed ${describe(release?.tag_name)}`);
  }
  if (release.draft !== false) {
    throw new Error(`Service release ${tag} must be published (draft ${describe(release.draft)}); qualification requires a non-draft release`);
  }
  if (release.immutable !== true) {
    throw new Error(`Service release ${tag} must be immutable (immutable ${describe(release.immutable)}); qualification requires an immutable release`);
  }
  requireId(release.id, 'Service release ID');
  const asset = Array.isArray(release.assets)
    ? release.assets.find((entry) => entry?.name === SERVICE_MANIFEST_NAME)
    : undefined;
  if (!asset) {
    throw new Error(`Service release ${tag} has no ${SERVICE_MANIFEST_NAME} manifest asset (assets ${describe((release.assets ?? []).map((entry) => entry?.name))})`);
  }
  const metadata = parseStrictJson(await api(`repos/${repository}/releases/assets/${asset.id}`, false, scopedEnvironment));
  requireId(metadata.id, 'Service manifest asset ID');
  if (metadata.id !== asset.id || metadata.name !== SERVICE_MANIFEST_NAME || metadata.state !== 'uploaded') {
    throw new Error(`Service manifest asset ${asset.id} metadata mismatch: expected ${SERVICE_MANIFEST_NAME} uploaded, observed ${describe({ id: metadata.id, name: metadata.name, state: metadata.state })}`);
  }
  const bytes = await api(`repos/${repository}/releases/assets/${asset.id}`, true, scopedEnvironment, { binaryAccept: 'application/octet-stream' });
  if (!Buffer.isBuffer(bytes)) throw new Error('Service manifest bytes are unavailable');
  if (Number.isSafeInteger(metadata.size) && bytes.length !== metadata.size) {
    throw new Error(`Service manifest size mismatch: expected ${metadata.size} bytes (asset metadata), observed ${bytes.length} (downloaded bytes)`);
  }
  const manifestSha256 = byteHash(bytes);
  if (typeof metadata.digest === 'string' && metadata.digest !== `sha256:${manifestSha256}`) {
    throw new Error(`Service manifest digest mismatch: expected ${metadata.digest} (asset metadata), observed sha256:${manifestSha256} (downloaded bytes)`);
  }
  const manifest = parseStrictJson(bytes);
  verifyServiceManifest(manifest, { serviceSha, imageDigest });
  return {
    identity: {
      repository,
      release_id: release.id,
      tag,
      manifest_asset_id: asset.id,
      manifest_sha256: manifestSha256,
    },
    manifest,
    bytes,
    release,
    asset: metadata,
  };
}

const USAGE = `Usage: node scripts/service-release.mjs --operation <full|smoke|recover> --client-url <url> --service-url <url> [--expected-service-commit <sha>] [--expected-client-commit <sha>] [--inputs-dir <dir>]

Reads the live Client build metadata and Service health, compares them with the
dispatch expectation, enforces the committed supported-Client floor, and verifies
that the live Service commit resolves to an immutable Service release whose
manifest names the same source and image digest. Writes live-identity.json and
service-artifacts.json under the inputs directory. It never reads a committed
compatibility file and never requests an AWS credential.
`;

const ARGUMENTS = Object.freeze({
  '--operation': 'operation',
  '--client-url': 'clientUrl',
  '--service-url': 'serviceUrl',
  '--expected-service-commit': 'expectedServiceCommit',
  '--expected-client-commit': 'expectedClientCommit',
  '--inputs-dir': 'inputsDir',
});

export function serviceReleaseArguments(argv = []) {
  if (argv.includes('--help')) return { help: true };
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const key = ARGUMENTS[flag];
    if (!key) throw new Error(`Unknown service-release argument ${flag}`);
    const value = argv[index + 1];
    if (typeof value !== 'string' || value.length === 0) throw new Error(`Service-release argument ${flag} requires a value`);
    if (Object.hasOwn(options, key)) throw new Error(`Duplicate service-release argument ${flag}`);
    options[key] = value;
  }
  if (!options.operation) throw new Error('service-release requires --operation');
  if (!['full', 'smoke', 'recover'].includes(options.operation)) {
    throw new Error(`service-release does not know the operation ${describe(options.operation)}`);
  }
  if (LIVE_OPERATIONS.includes(options.operation)) {
    for (const key of ['clientUrl', 'serviceUrl']) {
      if (!options[key]) throw new Error(`service-release requires --${key === 'clientUrl' ? 'client-url' : 'service-url'} for operation ${options.operation}`);
    }
  }
  return options;
}

// The credential-free CLI the preflight and `full` run. It writes the two inputs the
// record is built from, so the record states the exact release identity the gate
// verified rather than a copy of a committed file.
export async function runServiceRelease({
  argv = process.argv.slice(2), environment = process.env, api = ghApi, fetcher = fetch,
  inputsDirectory, log = console.log,
} = {}) {
  const options = serviceReleaseArguments(argv);
  if (options.help) {
    process.stdout.write(USAGE);
    return { help: true };
  }
  if (!LIVE_OPERATIONS.includes(options.operation)) {
    log(`Operation ${options.operation} does not gate on the live deployed tuple; the credential-free live identity check is skipped.`);
    return { skipped: true };
  }
  const expected = {
    service_commit: options.expectedServiceCommit ?? null,
    client_commit: options.expectedClientCommit ?? null,
  };
  const identity = await collectDeploymentEvidence({
    clientUrl: options.clientUrl,
    serviceUrl: options.serviceUrl,
    runId: environment.GITHUB_RUN_ID,
  }, expected, fetcher);
  const release = await readServiceRelease({
    serviceSha: identity.service.service_commit,
    imageDigest: identity.service.image_digest,
    api,
    environment,
  });
  const directory = resolve(inputsDirectory ?? options.inputsDir ?? environment.QUALIFICATION_INPUTS_DIR ?? '.qualification-inputs');
  await mkdir(directory, { recursive: true });
  const live = {
    client: { ...identity.client, client_version: identity.client_version },
    service: { ...identity.service, minimum_client_version: identity.minimum_client_version },
  };
  await writeFile(resolve(directory, 'live-identity.json'), `${JSON.stringify(live, null, 2)}\n`);
  await writeFile(resolve(directory, 'service-artifacts.json'), `${JSON.stringify(release.identity, null, 2)}\n`);
  log(`Live tuple: Client ${identity.client.source_commit} version ${identity.client_version}; Service ${identity.service.service_commit} ${identity.service.image_digest}; minimum Client ${identity.minimum_client_version}`);
  log(`Immutable Service release ${release.identity.tag}: release ${release.identity.release_id}, manifest asset ${release.identity.manifest_asset_id}, manifest ${release.identity.manifest_sha256}`);
  return { identity, release: release.identity, live };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runServiceRelease({ argv: process.argv.slice(2) });
}
