import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  assertEqual, byteHash, parseStrictJson, repositories, validateCompatibility,
} from './evidence-contract.mjs';
import {
  assertDeploymentBinding, assertTrustedRun, ghApi, loadTrustedInputs, repositoryReadEnvironment,
} from './trusted-deployment-inputs.mjs';
import { validateDeploymentRecord } from './vendor/deployment-contract.mjs';

export function migrationArguments(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    if (!['--deployment-record', '--output'].includes(name)) {
      throw new Error(`Unsupported argument ${name}; migration always uses committed compatibility.json`);
    }
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a path`);
    if (options.has(name)) throw new Error(`${name} may be supplied only once`);
    options.set(name, value);
  }
  for (const name of ['--deployment-record', '--output']) {
    if (!options.has(name)) throw new Error(`${name} is required`);
  }
  return { inputPath: resolve(options.get('--deployment-record')), outputPath: resolve(options.get('--output')) };
}

export function buildV2Compatibility(v1, deployment, deploymentBytes, artifactId) {
  if (v1.version !== 1) throw new Error('Migration input must be compatibility version 1');
  validateCompatibility(v1, { allowLegacy: true });
  if (!Buffer.isBuffer(deploymentBytes) || deploymentBytes.length === 0) throw new Error('Exact authenticated deployment record bytes are required');
  if (deployment.observed?.client_sha !== v1.client.sha) throw new Error('Deployment Client source does not match the current v1 Client pin');
  if (deployment.observed?.service_sha !== v1.service.sha) throw new Error('Deployment Service source does not match the current v1 Service pin');
  validateDeploymentRecord(deployment);
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
  validateCompatibility(candidate);
  return candidate;
}

export function selectDeploymentArtifact(artifacts, run) {
  if (!Array.isArray(artifacts)) throw new Error('Infra run artifacts response is invalid');
  const matches = artifacts.filter((artifact) => artifact.name === `infra-deployment-${run.id}-${run.run_attempt}`
    && artifact.expired === false && artifact.workflow_run?.id === run.id
    && artifact.workflow_run?.head_sha === run.head_sha);
  if (matches.length !== 1) throw new Error('Expected exactly one current Infra deployment artifact for the selected run attempt');
  return matches[0];
}

export async function listRunArtifacts(run, environment, api = ghApi) {
  const found = [];
  let expectedCount;
  for (let page = 1; page <= 100; page++) {
    const response = parseStrictJson(await api(
      `repos/${repositories.infra}/actions/runs/${run.id}/artifacts?per_page=100&page=${page}`,
      false, environment,
    ));
    if (!Array.isArray(response.artifacts) || !Number.isSafeInteger(response.total_count) || response.total_count < 0) {
      throw new Error('Infra run artifacts response is invalid');
    }
    if (response.artifacts.length > 100) throw new Error('Infra run artifacts page exceeds the requested page size');
    if (expectedCount !== undefined && response.total_count !== expectedCount) throw new Error('Infra run artifact list changed while reading pages');
    expectedCount = response.total_count;
    found.push(...response.artifacts);
    if (found.length > expectedCount) throw new Error('Infra run artifact list exceeds its reported total_count');
    if (found.length === expectedCount) return found;
    if (response.artifacts.length !== 100) throw new Error('Infra run artifact list pagination is incomplete');
  }
  throw new Error('Infra run artifact list exceeds the bounded pagination limit');
}

async function main() {
  const { inputPath, outputPath } = migrationArguments(process.argv.slice(2));
  const currentCompatibilityPath = resolve(fileURLToPath(new URL('../compatibility.json', import.meta.url)));
  if (inputPath === outputPath || outputPath === currentCompatibilityPath) {
    throw new Error('Migration output must be separate; compatibility.json is never modified');
  }
  const v1 = parseStrictJson(await readFile(currentCompatibilityPath));
  validateCompatibility(v1, { allowLegacy: true });
  if (v1.version !== 1) throw new Error('Committed compatibility.json must remain version 1 until migration');
  const bytes = await readFile(inputPath);
  const deployment = parseStrictJson(bytes);
  if (deployment.schema_version !== 2 || deployment.record_type !== 'anywear_infra_deployment') {
    throw new Error('Only an exact Infra schema v2 deployment record is accepted');
  }
  validateDeploymentRecord(deployment);
  if (deployment.observed.client_sha !== v1.client.sha || deployment.observed.service_sha !== v1.service.sha) {
    throw new Error('Deployment application sources do not match the current v1 Client/Service pins');
  }

  const infraEnvironment = repositoryReadEnvironment(repositories.infra);
  const clientEnvironment = repositoryReadEnvironment(repositories.client);
  for (const [component, entry, environment] of [
    ['client', v1.client, clientEnvironment], ['service', v1.service, repositoryReadEnvironment(repositories.service)],
    ['infra', { repository: repositories.infra, sha: deployment.infra?.sha }, infraEnvironment],
  ]) {
    const commit = parseStrictJson(await ghApi(`repos/${entry.repository}/commits/${entry.sha}`, false, environment));
    if (commit.sha !== entry.sha) throw new Error(`Deployment ${component} commit does not exist on its remote`);
  }

  // The genuine artifact identity is discoverable only from the completed run.
  const run = parseStrictJson(await ghApi(`repos/${repositories.infra}/actions/runs/${deployment.infra.run_id}/attempts/${deployment.infra.run_attempt}`, false, infraEnvironment));
  assertTrustedRun(run, { repository: repositories.infra, workflow_path: deployment.infra.workflow_path,
    run_id: deployment.infra.run_id, run_attempt: deployment.infra.run_attempt, sha: deployment.infra.sha });
  const artifacts = await listRunArtifacts(run, infraEnvironment);
  const artifact = selectDeploymentArtifact(artifacts, run);
  const candidate = buildV2Compatibility(v1, deployment, bytes, artifact.id);
  assertDeploymentBinding(deployment, candidate);
  const verificationDirectory = await mkdtemp(join(tmpdir(), 'anywear-v2-compatibility-'));
  try {
    await loadTrustedInputs(candidate, verificationDirectory);
    await writeFile(outputPath, `${JSON.stringify(candidate, null, 2)}\n`, { flag: 'wx' });
  } finally {
    await rm(verificationDirectory, { recursive: true, force: true });
  }
  console.log(`Wrote authenticated v2 candidate to ${outputPath}; compatibility.json remains unchanged.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
