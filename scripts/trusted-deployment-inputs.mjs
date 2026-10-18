import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  assertEqual, byteHash, parseStrictJson, repositories, requireCommit, requireHash, requireImageDigest, validateCompatibility,
} from './evidence-contract.mjs';
import * as deploymentContract from './vendor/deployment-contract.mjs';
import { assertVendoredProvenance } from './vendored-contract.mjs';

// The vendored contract is loaded with its exact producer identity asserted first;
// a modified or extra vendored module stops the consumer before any record is read.
await assertVendoredProvenance();

// Compatibility v3 names two producers and two records. The platform record is
// produced by the reviewed Infra observation entry; the workload record is
// produced by the Service release chain that builds, verifies, deploys and
// records the slice in one run. Neither record is the retired cross-repository
// `selection`, and no Service parser is vendored or executed here.
export const PLATFORM_WORKFLOW = '.github/workflows/runtime.yml';
export const DEPLOYMENT_WORKFLOW = '.github/workflows/service-artifacts.yml';
export const PUBLISHER_WORKFLOW = '.github/workflows/service-artifacts.yml';

// The shared contract dispatches on `record_type`, so a reader accepts either
// producer's record but never a mixed one. The Infra record is the v3 seven-member
// core; the Service record is v4 and validates its required bake gate too.
export function validateProducerRecord(record) {
  return deploymentContract.validateDeploymentRecord(record);
}

// Historical v2 records stay readable for the v1 -> v2 audit path and for the
// cleanup diagnostic. The shared contract does not validate the retired v2 shape,
// so this consumer keeps the frozen v2 envelope check for that historical path
// only; v2 is never accepted as a live v3 input.
//
// The pre-gate Service record (schema version 3, no `gate`) is historical as well
// and was never produced: the E2E deployment pin was deferred before the first
// Service release-chain record existed. The Service record is only ever the v4
// shape whose passed 600-second six-signal bake gate is validated with it.
export function validateHistoricalV2Record(record) {
  if (record?.schema_version !== 2 || record?.record_type !== 'anywear_infra_deployment') {
    throw new Error('Historical v2 deployment record is not a live v3 input');
  }
  const keys = ['infra', 'observed', 'record_type', 'schema', 'schema_version', 'selection', 'stacks'];
  if (Object.keys(record).sort().join(',') !== keys.join(',')) throw new Error('Historical v2 deployment record envelope is invalid');
  if (!record.infra || typeof record.infra.sha !== 'string' || !/^[0-9a-f]{40}$/.test(record.infra.sha)) throw new Error('Historical v2 deployment record Infra source is invalid');
  if (!record.selection?.release || !Array.isArray(record.stacks) || record.stacks.length !== 4) throw new Error('Historical v2 deployment record selection/stacks are invalid');
  if (!record.observed?.client_sha || !record.observed?.service_sha) throw new Error('Historical v2 deployment record observed tuple is invalid');
  return record;
}

// Which stacks each producer's record may name come from the vendored contract,
// never from a local restatement: the record's own `stacks` member is validated
// against them.
export const PLATFORM_STACKS = Object.freeze(deploymentContract.DEPLOYMENT_RECORD_SCHEMA.stacks
  .map((stack) => Object.freeze({ name: stack.name, region: stack.region })));
export const WORKLOAD_STACKS = Object.freeze(deploymentContract.SERVICE_DEPLOYMENT_RECORD_SCHEMA.stacks
  .map((stack) => Object.freeze({ name: stack.name, region: stack.region })));

export const recordArtifactName = (producer, runId, runAttempt) => producer === repositories.infra
  ? `infra-deployment-${runId}-${runAttempt}`
  : `service-deployment-${runId}-${runAttempt}`;

export function assertTrustedRun(run, expected) {
  if (run.id !== expected.run_id || run.run_attempt !== expected.run_attempt
    || run.repository?.full_name !== expected.repository
    || run.path !== expected.workflow_path || run.head_sha !== expected.sha
    || run.head_branch !== 'main' || run.event !== 'workflow_dispatch'
    || run.status !== 'completed' || run.conclusion !== 'success') {
    throw new Error('Trusted workflow run/attempt/source/main/completed-success binding mismatch');
  }
  return run;
}

export function assertTrustedArtifact(artifact, expected, run, now = Date.now()) {
  const expires = Date.parse(artifact.expires_at);
  const created = Date.parse(artifact.created_at);
  const started = Date.parse(run.run_started_at);
  const completed = Date.parse(run.updated_at);
  if (artifact.id !== expected.artifact_id || artifact.expired !== false
    || !Number.isFinite(expires) || expires <= now
    || ![created, started, completed].every(Number.isFinite) || started > completed || created < started
    || created > completed
    || artifact.name !== expected.artifact_name
    || artifact.workflow_run?.id !== expected.run_id
    || artifact.workflow_run?.head_sha !== expected.sha) {
    throw new Error('Deployment artifact identity, attempt, lifetime or source mismatch');
  }
  return artifact;
}

function assertInputShape(inputs) {
  if (!Array.isArray(inputs)) throw new Error('Deployment record inputs must be a list');
  const names = new Set();
  let previous;
  for (const input of inputs) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Deployment record input is malformed');
    assertEqual(Object.keys(input).sort(), ['parameter', 'value_sha256', 'version'], 'Deployment record input fields');
    if (typeof input.parameter !== 'string' || !/^\/anywear\/[a-z0-9]+\/[a-z0-9_]+$/.test(input.parameter)) throw new Error(`Deployment record input parameter ${input.parameter} is not a stage parameter path`);
    // The shared contract records an SSM parameter Version as a decimal string.
    if (typeof input.version !== 'string' || !/^[1-9]\d*$/.test(input.version) || !Number.isSafeInteger(Number(input.version))) {
      throw new Error(`Deployment record input ${input.parameter} version is not a positive integer string`);
    }
    requireHash(input.value_sha256, `Deployment record input ${input.parameter} value hash`);
    if (names.has(input.parameter)) throw new Error(`Deployment record input ${input.parameter} is duplicated`);
    if (previous !== undefined && input.parameter <= previous) throw new Error('Deployment record inputs are not sorted by parameter name');
    previous = input.parameter;
    names.add(input.parameter);
  }
  return inputs;
}

// The record identity the pin binds, by producer. The deferred shape is refused on
// every live path: an unpinned producer is not qualification authority.
function recordIdentity(compatibility, producer) {
  if (producer === repositories.infra) {
    return { identity: compatibility.platform.record, producerRepository: compatibility.platform.producer, producerSha: compatibility.platform.producer_sha, stacks: PLATFORM_STACKS };
  }
  if (producer === repositories.service) {
    return { identity: compatibility.deployment, producerRepository: compatibility.workload.producer, producerSha: compatibility.workload.producer_sha, stacks: WORKLOAD_STACKS };
  }
  throw new Error('Deployment record producer is not a reviewed producer');
}

function assertRecordStacks(record, stacks, producer, producerSha) {
  if (!Array.isArray(record.stacks) || record.stacks.length !== stacks.length) {
    throw new Error(`Deployment record must name exactly the ${producer} stacks`);
  }
  for (const expected of stacks) {
    const row = record.stacks.find((candidate) => candidate?.name === expected.name);
    if (!row) throw new Error(`Deployment record is missing ${expected.name}`);
    assertEqual(Object.keys(row).sort(), ['name', 'producer_repository', 'producer_sha', 'region', 'template_sha256'], `Deployment record stack ${expected.name} fields`);
    if (row.region !== expected.region) throw new Error(`Deployment record stack ${expected.name} region differs from the reviewed region`);
    if (row.producer_repository !== producer) throw new Error(`Deployment record stack ${expected.name} producer repository is not ${producer}`);
    requireCommit(row.producer_sha, `Deployment record stack ${expected.name} producer`);
    assertEqual(row.producer_sha, producerSha, `Deployment record stack ${expected.name} producer`);
    requireHash(row.template_sha256, `Deployment record stack ${expected.name} template hash`);
  }
}

// One record, bound to the pin member for its producer. Every failure names the
// member it refused. This is the E2E consumer half of the shared contract: the
// record shape (including the v4 Service bake gate, which must be passed and bound
// to the observed Service and image) is validated by the vendored contract, and
// the pin identity is bound here so a valid record for another tuple cannot
// qualify.
//
// The two producer records are not copies of each other: the Infra record observes
// the Platform tuple (Client, Lambdas, queue configuration and the Client
// endpoint), and the Service record observes the Workload tuple (the deployed
// image and its Service commit). Each record is bound for the identity it owns;
// the authenticated observation is what proves both against the live system.
export function assertDeploymentBinding(record, compatibility) {
  validateCompatibility(compatibility);
  validateProducerRecord(record);
  const producer = record?.producer?.repository;
  const binding = recordIdentity(compatibility, producer);
  if (binding.identity.status === 'deferred') {
    throw new Error(`Deployment evidence deferred for ${producer}: ${binding.identity.reason}`);
  }
  assertEqual(record.producer.repository, binding.producerRepository, 'Deployment record producer repository');
  assertEqual(record.producer.sha, binding.producerSha, 'Deployment record producer');
  assertEqual(record.producer.workflow_path, binding.identity.workflow_path, 'Deployment record producer workflow');
  assertEqual(record.producer.workflow_ref, `${binding.producerRepository}/${binding.identity.workflow_path}@refs/heads/main`, 'Deployment record producer workflow ref');
  assertEqual(record.producer.run_id, binding.identity.run_id, 'Deployment record producer run');
  assertEqual(record.producer.run_attempt, binding.identity.run_attempt, 'Deployment record producer attempt');
  assertRecordStacks(record, binding.stacks, binding.producerRepository, binding.producerSha);
  assertInputShape(record.inputs);
  requireHash(record.schema?.content_sha256, 'Deployment record schema content hash');
  if (producer === repositories.infra) {
    if (record.observed?.client_sha !== compatibility.client.sha) {
      throw new Error(`Deployment record observed Client ${record.observed?.client_sha} differs from compatibility.client.sha ${compatibility.client.sha}`);
    }
  } else {
    if (record.observed?.service_sha !== compatibility.service.sha) {
      throw new Error(`Deployment record observed Service ${record.observed?.service_sha} differs from compatibility.service.sha ${compatibility.service.sha}`);
    }
    requireImageDigest(record.observed?.image_digest);
    // The newest Client is pinned by `client.sha` and observed by the platform record;
    // the oldest Client is pinned by `minimum_supported_client.sha` and built by the second
    // qualification leg. The deployed Service record owns the floor itself, so a pin
    // that names a floor the deployed Service did not enforce is refused here.
    if (compatibility.minimum_supported_client !== undefined
      && record.observed?.minimum_client_version !== compatibility.minimum_supported_client.version) {
      throw new Error(`Deployment record observed minimum_client_version ${record.observed?.minimum_client_version} differs from compatibility.minimum_supported_client.version ${compatibility.minimum_supported_client.version}`);
    }
  }
  return record;
}

// The Service sealed release is evidence only. The release chain verifies it with
// its own publisher identity before deploying; E2E checks the pinned identity and
// exact manifest bytes, and reads only the fields the record comparison needs.
export function assertSealedRelease(release, asset, manifest, compatibility) {
  const expected = compatibility.service_artifacts;
  if (release.id !== expected.release_id || release.draft !== false || release.immutable !== true
    || !Array.isArray(release.assets) || !release.assets.some((entry) => entry.id === expected.manifest_asset_id)) {
    throw new Error('Service release must be sealed immutable and contain the pinned manifest asset');
  }
  if (asset.id !== expected.manifest_asset_id || asset.name !== 'service-artifacts.json'
    || asset.state !== 'uploaded' || !release.assets.some((entry) => entry.id === asset.id && entry.name === asset.name)) {
    throw new Error('Service manifest asset identity mismatch');
  }
  if (manifest.schema_version !== 1 || manifest.record_type !== 'anywear_service_artifacts'
    || !['source-build', 'deployed-baseline-import'].includes(manifest.kind)
    || manifest.producer?.repository !== repositories.service) throw new Error('Unsupported Service manifest');
  const expectedTag = manifest.kind === 'source-build'
    ? `service-artifacts-${manifest.components?.image?.service_sha}`
    : `service-baseline-${expected.manifest_sha256}`;
  if (release.tag_name !== expectedTag) throw new Error('Service immutable release tag binding mismatch');
  if (manifest.components?.image?.service_sha !== compatibility.service.sha) throw new Error('Service manifest image source mismatch');
  if (manifest.components?.image?.digest === undefined) throw new Error('Service manifest image digest is missing');
  return release;
}

export function repositoryReadEnvironment(repository, environment = process.env) {
  const input = new Map([
    [repositories.infra, 'GH_TOKEN'],
    [repositories.service, 'SERVICE_ARTIFACT_READ_TOKEN'],
    [repositories.client, 'CLIENT_CONTENTS_READ_TOKEN'],
  ]).get(repository);
  if (!input) throw new Error('Unexpected repository for scoped evidence access');
  if (!environment[input]?.trim()) throw new Error(`${input} required for ${repository} read access`);
  const scoped = { ...environment, GH_TOKEN: environment[input] };
  for (const key of ['GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN',
    'E2E_EVIDENCE_READ_TOKEN', 'INFRA_EVIDENCE_READ_TOKEN', 'SERVICE_ARTIFACT_READ_TOKEN',
    'CLIENT_CONTENTS_READ_TOKEN']) delete scoped[key];
  return scoped;
}

export function ghApi(path, binary = false, environment = process.env, { execute = execFileSync, binaryAccept } = {}) {
  // Actions artifact ZIP API endpoints accept JSON before redirecting to raw ZIP
  // bytes, while release assets require octet-stream to return the asset itself.
  const accept = binary
    ? binaryAccept ?? (/\/actions\/artifacts\/\d+\/zip$/.test(path) ? 'application/json'
      : /\/releases\/assets\/\d+$/.test(path) ? 'application/octet-stream' : undefined)
    : 'application/vnd.github+json';
  if (!accept || (binary && !['application/json', 'application/octet-stream'].includes(accept))) {
    throw new Error('Unsupported binary GitHub API response type');
  }
  return execute('gh', ['api', path, '-H', `Accept: ${accept}`], {
    encoding: binary ? undefined : 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 60_000,
    stdio: ['ignore', 'pipe', 'pipe'], env: environment,
  });
}

export function extractDeploymentRecord(archivePath, member = 'deployment-record.json') {
  // Read exactly one bounded file into memory. No archive path is ever extracted.
  return execFileSync('python3', ['-c', [
    'import sys, zipfile',
    'with zipfile.ZipFile(sys.argv[1]) as z:',
    ' entries=z.infolist()',
    ` if len(entries)!=1 or entries[0].filename!=sys.argv[2] or entries[0].is_dir() or entries[0].file_size>1048576: raise ValueError("Unexpected deployment artifact contents")`,
    ' sys.stdout.buffer.write(z.read(entries[0]))',
  ].join('\n'), archivePath, member], { timeout: 15_000, maxBuffer: 1048576, stdio: ['ignore', 'pipe', 'pipe'] });
}

async function downloadRecord({ api, extractRecord, directory, identity, producer, environment, member }) {
  const expected = {
    repository: producer,
    workflow_path: identity.workflow_path,
    run_id: identity.run_id,
    run_attempt: identity.run_attempt,
    sha: identity.producer_sha,
    artifact_id: identity.artifact_id,
    artifact_name: recordArtifactName(producer, identity.run_id, identity.run_attempt),
    member,
  };
  const run = parseStrictJson(await api(`repos/${producer}/actions/runs/${expected.run_id}/attempts/${expected.run_attempt}`, false, environment));
  assertTrustedRun(run, expected);
  const artifact = parseStrictJson(await api(`repos/${producer}/actions/artifacts/${expected.artifact_id}`, false, environment));
  assertTrustedArtifact(artifact, expected, run);
  const archive = await api(`repos/${producer}/actions/artifacts/${expected.artifact_id}/zip`, true, environment,
    { binaryAccept: 'application/json' });
  if (artifact.digest && artifact.digest !== `sha256:${byteHash(archive)}`) throw new Error('Deployment artifact archive digest mismatch');
  const archivePath = resolve(directory, `${producer.replace('/', '-')}-deployment.zip`);
  await writeFile(archivePath, archive);
  const bytes = await extractRecord(archivePath, member);
  if (byteHash(bytes) !== identity.record_sha256) {
    throw new Error(`Deployment record exact-byte checksum mismatch for ${producer} (${byteHash(bytes)})`);
  }
  const record = validateProducerRecord(parseStrictJson(bytes));
  assertDeploymentBinding(record, identity.compatibility);
  return { record, bytes };
}

export async function loadTrustedInputs(compatibility, directory, {
  api = ghApi, extractRecord = extractDeploymentRecord, environment = process.env,
} = {}) {
  validateCompatibility(compatibility);
  for (const [label, identity] of [['platform', compatibility.platform.record], ['workload', compatibility.deployment]]) {
    if (identity.status === 'deferred') throw new Error(`Deployment evidence deferred for ${label}: ${identity.reason}`);
  }
  const infraEnvironment = repositoryReadEnvironment(repositories.infra, environment);
  const serviceEnvironment = repositoryReadEnvironment(repositories.service, environment);
  await mkdir(directory, { recursive: true });
  const platformRecord = await downloadRecord({
    api, extractRecord, directory, producer: repositories.infra, environment: infraEnvironment,
    member: 'deployment-record.json',
    identity: { ...compatibility.platform.record, producer_sha: compatibility.platform.producer_sha, compatibility },
  });
  if (platformRecord.record.producer.sha !== compatibility.platform.producer_sha) {
    throw new Error('Platform record producer does not equal compatibility.platform.producer_sha');
  }
  const workloadRecord = await downloadRecord({
    api, extractRecord, directory, producer: repositories.service, environment: serviceEnvironment,
    member: 'service-deployment.json',
    identity: { ...compatibility.deployment, producer_sha: compatibility.workload.producer_sha, compatibility },
  });

  const service = compatibility.service_artifacts;
  const release = parseStrictJson(await api(`repos/${repositories.service}/releases/${service.release_id}`, false, serviceEnvironment));
  const asset = parseStrictJson(await api(`repos/${repositories.service}/releases/assets/${service.manifest_asset_id}`, false, serviceEnvironment));
  const manifestBytes = await api(`repos/${repositories.service}/releases/assets/${service.manifest_asset_id}`, true, serviceEnvironment,
    { binaryAccept: 'application/octet-stream' });
  if (byteHash(manifestBytes) !== service.manifest_sha256) throw new Error('Service manifest exact-byte checksum mismatch');
  const manifest = parseStrictJson(manifestBytes);
  assertSealedRelease(release, asset, manifest, compatibility);
  const workloadObserved = workloadRecord.record.observed;
  assertEqual(manifest.components.image.service_sha, workloadObserved.service_sha, 'Service manifest image source');
  assertEqual(manifest.components.image.digest, workloadObserved.image_digest, 'Service manifest image digest');

  await writeFile(resolve(directory, 'deployment-record.json'), workloadRecord.bytes);
  await writeFile(resolve(directory, 'platform-deployment-record.json'), platformRecord.bytes);
  await writeFile(resolve(directory, 'service-artifacts.json'), manifestBytes);
  await writeFile(resolve(directory, 'verified-inputs.json'), `${JSON.stringify({
    compatibility,
    platform: platformRecord.record,
    workload: workloadRecord.record,
    manifest,
  }, null, 2)}\n`);
  return { compatibility, platform: platformRecord.record, workload: workloadRecord.record, manifest };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const compatibility = parseStrictJson(await readFile(new URL('../compatibility.json', import.meta.url)));
  await loadTrustedInputs(compatibility, resolve(process.env.QUALIFICATION_INPUTS_DIR ?? '.qualification-inputs'));
  console.log('Verified exact trusted platform/workload deployment records and immutable Service release.');
}
