import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  assertEqual, byteHash, parseStrictJson, repositories, validateCompatibility,
} from './evidence-contract.mjs';
import {
  assertDeploymentBinding, assertTrustedRun, ghApi, loadTrustedInputs, recordArtifactName,
  repositoryReadEnvironment, validateHistoricalV2Record, validateProducerRecord,
} from './trusted-deployment-inputs.mjs';

export const MIGRATION_OPTIONS = Object.freeze(['--platform-record', '--deployment-record', '--output']);

function runArguments(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    if (!MIGRATION_OPTIONS.includes(name)) {
      throw new Error(`Unsupported argument ${name}; migration reads both producer records and writes one candidate`);
    }
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
    if (options.has(name)) throw new Error(`${name} may be supplied only once`);
    options.set(name, value);
  }
  for (const name of MIGRATION_OPTIONS) {
    if (!options.has(name)) throw new Error(`${name} is required`);
  }
  return {
    platformRecord: resolve(options.get('--platform-record')),
    deploymentRecord: resolve(options.get('--deployment-record')),
    outputPath: resolve(options.get('--output')),
  };
}

export function migrationArguments(argv) {
  return runArguments(argv);
}

// Historical v1 -> v2 migration. Kept readable and tested so the historical
// transition can be re-verified, but the CLI never accepts a v1 committed pin:
// v1 is not a live input and is never converted into a v3 pin.
export function buildV2Compatibility(v1, deployment, deploymentBytes, artifactId, { validate = validateHistoricalV2Record } = {}) {
  if (v1.version !== 1) throw new Error('Migration input must be compatibility version 1');
  validateCompatibility(v1, { allowLegacy: true });
  if (!Buffer.isBuffer(deploymentBytes) || deploymentBytes.length === 0) throw new Error('Exact authenticated deployment record bytes are required');
  if (deployment.observed?.client_sha !== v1.client.sha) throw new Error('Deployment Client source does not match the current v1 Client pin');
  if (deployment.observed?.service_sha !== v1.service.sha) throw new Error('Deployment Service source does not match the current v1 Service pin');
  validate(deployment);
  assertEqual(parseStrictJson(deploymentBytes), deployment, 'Deployment record byte payload');
  if (!Number.isSafeInteger(artifactId) || artifactId < 1) throw new Error('Authenticated Infra deployment artifact ID is required');
  const infra = deployment.infra;
  const release = deployment.selection.release;
  if (release.repository !== repositories.service) throw new Error('Deployment Service release repository is unexpected');
  const candidate = {
    version: 2,
    client: structuredClone(v1.client),
    service: structuredClone(v1.service),
    infra: { repository: repositories.infra, sha: infra.sha },
    service_artifacts: {
      repository: repositories.service,
      release_id: release.id,
      manifest_asset_id: release.manifest_asset_id,
      manifest_sha256: release.manifest_sha256,
    },
    deployment: {
      repository: repositories.infra,
      workflow_path: infra.workflow_path,
      run_id: infra.run_id,
      run_attempt: infra.run_attempt,
      artifact_id: artifactId,
      record_sha256: byteHash(deploymentBytes),
    },
  };
  validateCompatibility(candidate, { allowLegacy: true });
  return candidate;
}

export function selectDeploymentArtifact(artifacts, run, name = `infra-deployment-${run.id}-${run.run_attempt}`) {
  if (!Array.isArray(artifacts)) throw new Error('Producer run artifacts response is invalid');
  const matches = artifacts.filter((artifact) => artifact.name === name
    && artifact.expired === false && artifact.workflow_run?.id === run.id
    && artifact.workflow_run?.head_sha === run.head_sha);
  if (matches.length !== 1) throw new Error(`Expected exactly one current ${name} artifact for the selected run attempt`);
  return matches[0];
}

export async function listRunArtifacts(run, environment, api = ghApi, producer = repositories.infra) {
  const found = [];
  let expectedCount;
  for (let page = 1; page <= 100; page++) {
    const response = parseStrictJson(await api(
      `repos/${producer}/actions/runs/${run.id}/artifacts?per_page=100&page=${page}`,
      false, environment,
    ));
    if (!Array.isArray(response.artifacts) || !Number.isSafeInteger(response.total_count) || response.total_count < 0) {
      throw new Error('Producer run artifacts response is invalid');
    }
    if (response.artifacts.length > 100) throw new Error('Producer run artifacts page exceeds the requested page size');
    if (expectedCount !== undefined && response.total_count !== expectedCount) throw new Error('Producer run artifact list changed while reading pages');
    expectedCount = response.total_count;
    found.push(...response.artifacts);
    if (found.length > expectedCount) throw new Error('Producer run artifact list exceeds its reported total_count');
    if (found.length === expectedCount) return found;
    if (response.artifacts.length !== 100) throw new Error('Producer run artifact list pagination is incomplete');
  }
  throw new Error('Producer run artifact list exceeds the bounded pagination limit');
}

async function assertProducerRun({ api = ghApi, producer, record, environment }) {
  const expected = {
    repository: producer, workflow_path: record.producer.workflow_path,
    run_id: record.producer.run_id, run_attempt: record.producer.run_attempt, sha: record.producer.sha,
  };
  const actual = parseStrictJson(await api(`repos/${producer}/actions/runs/${expected.run_id}/attempts/${expected.run_attempt}`, false, environment));
  assertTrustedRun(actual, expected);
  const name = recordArtifactName(producer, expected.run_id, expected.run_attempt);
  const artifacts = await listRunArtifacts(actual, environment, api, producer);
  const artifact = selectDeploymentArtifact(artifacts, actual, name);
  return { run_id: expected.run_id, run_attempt: expected.run_attempt, artifact_id: artifact.id };
}

// Strict v2 -> v3 migration and v3 deferred-record fill. The v2 pin supplies the
// application pins and the immutable release identity; the Infra v3 platform
// record and the Service v4 workload record supply the producer identities and
// every deployment identity member. A record from the wrong producer, a record
// covering another producer's stack, a Service record without its passed bake gate,
// or an observed application tuple that disagrees with the pin is refused.
export function buildV3Compatibility(previous, {
  platformRecord, platformBytes, platformRun, workloadRecord, workloadBytes, workloadRun,
}) {
  if (previous?.version === 1) throw new Error('v1 is historical only; v1 -> v2 is not a v3 migration input');
  validateCompatibility(previous, { allowLegacy: true });
  if (!Buffer.isBuffer(platformBytes) || !Buffer.isBuffer(workloadBytes)) throw new Error('Exact authenticated deployment record bytes are required');
  validateProducerRecord(platformRecord);
  validateProducerRecord(workloadRecord);
  assertEqual(parseStrictJson(platformBytes), platformRecord, 'Platform deployment record byte payload');
  assertEqual(parseStrictJson(workloadBytes), workloadRecord, 'Workload deployment record byte payload');
  const platformProducer = platformRecord.producer.repository;
  const workloadProducer = workloadRecord.producer.repository;
  if (platformProducer !== repositories.infra) throw new Error('Platform deployment record producer is not the reviewed Infra repository');
  if (workloadProducer !== repositories.service) throw new Error('Workload deployment record producer is not the Service release chain');
  for (const [label, record, run] of [['platform', platformRecord, platformRun], ['workload', workloadRecord, workloadRun]]) {
    if (!run || run.run_id !== record.producer.run_id || run.run_attempt !== record.producer.run_attempt
      || !Number.isSafeInteger(run.artifact_id) || run.artifact_id < 1) throw new Error(`${label} producer run identity differs from the record`);
  }
  const identity = (record, run, bytes) => ({
    producer: record.producer.repository,
    workflow_path: record.producer.workflow_path,
    status: 'recorded',
    run_id: run.run_id,
    run_attempt: run.run_attempt,
    artifact_id: run.artifact_id,
    record_sha256: byteHash(bytes),
  });
  const candidate = {
    version: 3,
    client: structuredClone(previous.client),
    service: structuredClone(previous.service),
    infra: structuredClone(previous.infra),
    platform: {
      producer: platformProducer,
      producer_sha: platformRecord.producer.sha,
      record: identity(platformRecord, platformRun, platformBytes),
    },
    workload: { producer: workloadProducer, producer_sha: workloadRecord.producer.sha },
    deployment: identity(workloadRecord, workloadRun, workloadBytes),
    service_artifacts: structuredClone(previous.service_artifacts),
  };
  validateCompatibility(candidate);
  assertDeploymentBinding(platformRecord, candidate);
  assertDeploymentBinding(workloadRecord, candidate);
  return candidate;
}

async function main() {
  const { platformRecord, deploymentRecord, outputPath } = runArguments(process.argv.slice(2));
  const currentCompatibilityPath = resolve(fileURLToPath(new URL('../compatibility.json', import.meta.url)));
  if (outputPath === currentCompatibilityPath) throw new Error('Migration output must be separate; compatibility.json is never modified');
  const previous = parseStrictJson(await readFile(currentCompatibilityPath));
  if (previous.version === 1) throw new Error('Committed compatibility.json is version 1; v1 -> v2 is historical only and cannot become a v3 pin');
  validateCompatibility(previous, { allowLegacy: true });
  const platformBytes = await readFile(platformRecord);
  const workloadBytes = await readFile(deploymentRecord);
  const platform = validateProducerRecord(parseStrictJson(platformBytes));
  const workload = validateProducerRecord(parseStrictJson(workloadBytes));
  const infraEnvironment = repositoryReadEnvironment(repositories.infra);
  const serviceEnvironment = repositoryReadEnvironment(repositories.service);
  for (const [component, entry, environment] of [
    ['client', previous.client, repositoryReadEnvironment(repositories.client)],
    ['service', previous.service, repositoryReadEnvironment(repositories.service)],
    ['infra', previous.infra, infraEnvironment],
    ['platform producer', { repository: platform.producer.repository, sha: platform.producer.sha }, infraEnvironment],
    ['workload producer', { repository: workload.producer.repository, sha: workload.producer.sha }, serviceEnvironment],
  ]) {
    const commit = parseStrictJson(await ghApi(`repos/${entry.repository}/commits/${entry.sha}`, false, environment));
    if (commit.sha !== entry.sha) throw new Error(`${component} commit does not exist on its remote`);
  }
  const platformIdentity = await assertProducerRun({ producer: repositories.infra, record: platform, environment: infraEnvironment });
  const workloadIdentity = await assertProducerRun({ producer: repositories.service, record: workload, environment: serviceEnvironment });
  const candidate = buildV3Compatibility(previous, {
    platformRecord: platform, platformBytes, platformRun: platformIdentity,
    workloadRecord: workload, workloadBytes, workloadRun: workloadIdentity,
  });
  const verificationDirectory = await mkdtemp(join(tmpdir(), 'anywear-v3-compatibility-'));
  try {
    await loadTrustedInputs(candidate, verificationDirectory);
    await writeFile(outputPath, `${JSON.stringify(candidate, null, 2)}\n`, { flag: 'wx' });
  } finally {
    await rm(verificationDirectory, { recursive: true, force: true });
  }
  console.log(`Wrote authenticated v3 candidate to ${outputPath}; compatibility.json remains unchanged.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
