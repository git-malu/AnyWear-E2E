import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  assertEqual, byteHash, parseStrictJson, repositories, validateCompatibility,
} from './evidence-contract.mjs';
import { validateManifest } from './vendor/vendor/service-artifact-contract.mjs';
import { assertSelectionManifest } from './vendor/artifact-consumer.mjs';
import { validateDeploymentRecord } from './vendor/deployment-contract.mjs';
import { reviewedInfraSource } from './infra-source.mjs';

export const DEPLOYMENT_WORKFLOW = '.github/workflows/runtime.yml';
export const PUBLISHER_WORKFLOW = '.github/workflows/service-artifacts.yml';

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

export function assertTrustedArtifact(artifact, compatibility, run, now = Date.now()) {
  const expected = compatibility.deployment;
  const expires = Date.parse(artifact.expires_at);
  const created = Date.parse(artifact.created_at);
  const started = Date.parse(run.run_started_at);
  const completed = Date.parse(run.updated_at);
  if (artifact.id !== expected.artifact_id || artifact.expired !== false
    || !Number.isFinite(expires) || expires <= now
    || ![created, started, completed].every(Number.isFinite) || started > completed || created < started
    || created > completed
    || artifact.name !== `infra-deployment-${expected.run_id}-${expected.run_attempt}`
    || artifact.workflow_run?.id !== expected.run_id
    || artifact.workflow_run?.head_sha !== compatibility.infra.sha) {
    throw new Error('Deployment artifact identity, attempt, lifetime or source mismatch');
  }
  return artifact;
}

export function assertDeploymentBinding(record, compatibility) {
  validateCompatibility(compatibility);
  if (record.schema_version !== 2 || record.record_type !== 'anywear_infra_deployment') throw new Error('Unsupported Infra deployment record; historical v1 is not a direct-verification input');
  const expected = compatibility.deployment;
  if (expected.workflow_path !== DEPLOYMENT_WORKFLOW) throw new Error('Deployment workflow is not the reviewed protected Infra producer');
  for (const [key, value] of Object.entries({
    repository: repositories.infra, sha: compatibility.infra.sha,
    workflow_path: expected.workflow_path,
    workflow_ref: `${repositories.infra}/${expected.workflow_path}@refs/heads/main`,
    run_id: expected.run_id, run_attempt: expected.run_attempt,
  })) {
    if (record.infra?.[key] !== value) throw new Error(`Infra deployment ${key} binding mismatch`);
  }
  assertEqual(record.selection?.release, {
    repository: repositories.service, id: compatibility.service_artifacts.release_id,
    manifest_asset_id: compatibility.service_artifacts.manifest_asset_id,
    manifest_sha256: compatibility.service_artifacts.manifest_sha256,
  }, 'Selected Service release');
  if (record.observed?.service_sha !== compatibility.service.sha || record.observed?.client_sha !== compatibility.client.sha) throw new Error('Deployment application sources differ from compatibility');
  return record;
}

export function assertSealedRelease(release, asset, manifest, compatibility) {
  validateManifest(manifest);
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
  if (manifest.kind === 'source-build' && manifest.producer.workflow_sha !== manifest.components.image.service_sha) throw new Error('Source-build publisher must execute the selected source');
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
    'SERVICE_ARTIFACT_READ_TOKEN', 'CLIENT_CONTENTS_READ_TOKEN']) delete scoped[key];
  return scoped;
}

export function ghApi(path, binary = false, environment = process.env) {
  return execFileSync('gh', ['api', path, '-H', binary ? 'Accept: application/octet-stream' : 'Accept: application/vnd.github+json'], {
    encoding: binary ? undefined : 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 60_000,
    stdio: ['ignore', 'pipe', 'pipe'], env: environment,
  });
}

export function extractDeploymentRecord(archivePath) {
  // Read exactly one bounded file into memory. No archive path is ever extracted.
  return execFileSync('python3', ['-c', [
    'import sys, zipfile',
    'with zipfile.ZipFile(sys.argv[1]) as z:',
    ' entries=z.infolist()',
    ' if len(entries)!=1 or entries[0].filename!="deployment-record.json" or entries[0].is_dir() or entries[0].file_size>1048576: raise ValueError("Unexpected deployment artifact contents")',
    ' sys.stdout.buffer.write(z.read(entries[0]))',
  ].join('\n'), archivePath], { timeout: 15_000, maxBuffer: 1048576, stdio: ['ignore', 'pipe', 'pipe'] });
}

function assertCommittedSelection(selector, selection) {
  assertEqual(selector, { schema_version: 2, record_type: 'anywear_infra_selection',
    release: selection.release, ...selection.components }, 'Committed Infra selection and deployment');
}

export async function verifyPinnedSelection(compatibility, selection, directory, environment = process.env) {
  const serviceEnvironment = repositoryReadEnvironment(repositories.service, environment);
  const trustedInfraRoot = reviewedInfraSource(compatibility, environment);
  const binding = { trustedInfraRoot, expectedInfraSha: compatibility.infra.sha,
    selectionFile: selection.file, selectionSha256: selection.sha256 };
  // The actual regular tracked selection in the reviewed Infra commit supplies
  // authority. Deployment components are comparison values, never a replacement
  // selector written to an external directory. Native/asset requests receive
  // only the Service reader in the exact pinned Infra subprocess.
  const consumer = await import(pathToFileURL(resolve(trustedInfraRoot, 'scripts/artifact-consumer.mjs')).href);
  const selector = await consumer.loadCommittedSelection(binding);
  assertCommittedSelection(selector, selection);
  await mkdir(directory, { recursive: true });
  const assetsDirectory = resolve(directory, 'service-assets');
  execFileSync(process.execPath, [resolve(trustedInfraRoot, 'scripts/artifact-consumer.mjs'),
    '--selection', binding.selectionFile, '--selection-sha256', binding.selectionSha256, '--output-dir', assetsDirectory,
    '--trusted-infra-root', trustedInfraRoot, '--infra-sha', compatibility.infra.sha,
  ], { env: serviceEnvironment, timeout: 15 * 60_000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  reviewedInfraSource(compatibility, environment);
  assertCommittedSelection(await consumer.loadCommittedSelection(binding), selection);
  return { selector, manifest: parseStrictJson(await readFile(resolve(assetsDirectory, 'service-artifacts.json'))) };
}

export async function loadTrustedInputs(compatibility, directory, { api = ghApi, verifySelectedInputs = verifyPinnedSelection, extractRecord = extractDeploymentRecord, environment = process.env } = {}) {
  validateCompatibility(compatibility);
  if (compatibility.deployment.workflow_path !== DEPLOYMENT_WORKFLOW) throw new Error('Unreviewed deployment workflow');
  const infraEnvironment = repositoryReadEnvironment(repositories.infra, environment);
  const serviceEnvironment = repositoryReadEnvironment(repositories.service, environment);
  const expected = compatibility.deployment;
  const run = parseStrictJson(await api(`repos/${repositories.infra}/actions/runs/${expected.run_id}/attempts/${expected.run_attempt}`, false, infraEnvironment));
  assertTrustedRun(run, { ...expected, sha: compatibility.infra.sha });
  const artifact = parseStrictJson(await api(`repos/${repositories.infra}/actions/artifacts/${expected.artifact_id}`, false, infraEnvironment));
  assertTrustedArtifact(artifact, compatibility, run);
  await mkdir(directory, { recursive: true });
  const archive = await api(`repos/${repositories.infra}/actions/artifacts/${expected.artifact_id}/zip`, true, infraEnvironment);
  if (artifact.digest && artifact.digest !== `sha256:${byteHash(archive)}`) throw new Error('Deployment artifact archive digest mismatch');
  const archivePath = resolve(directory, 'deployment.zip');
  await writeFile(archivePath, archive);
  const bytes = await extractRecord(archivePath);
  if (byteHash(bytes) !== expected.record_sha256) throw new Error('Deployment record exact-byte checksum mismatch');
  await writeFile(resolve(directory, 'deployment-record.json'), bytes);
  const record = assertDeploymentBinding(parseStrictJson(bytes), compatibility);
  validateDeploymentRecord(record);
  const service = compatibility.service_artifacts;
  const release = parseStrictJson(await api(`repos/${repositories.service}/releases/${service.release_id}`, false, serviceEnvironment));
  const asset = parseStrictJson(await api(`repos/${repositories.service}/releases/assets/${service.manifest_asset_id}`, false, serviceEnvironment));
  const manifestBytes = await api(`repos/${repositories.service}/releases/assets/${service.manifest_asset_id}`, true, serviceEnvironment);
  if (byteHash(manifestBytes) !== service.manifest_sha256) throw new Error('Service manifest exact-byte checksum mismatch');
  const manifest = parseStrictJson(manifestBytes);
  assertSealedRelease(release, asset, manifest, compatibility);
  // This reconstructed object checks component agreement only; the pinned Infra
  // loader below must independently load the committed selection bytes/hash.
  assertSelectionManifest({ schema_version: 2, record_type: 'anywear_infra_selection',
    release: record.selection.release, ...record.selection.components }, manifest);
  const manifestPath = resolve(directory, asset.name);
  await writeFile(manifestPath, manifestBytes);
  const producer = manifest.producer;
  const publisher = parseStrictJson(await api(`repos/${repositories.service}/actions/runs/${producer.run_id}/attempts/${producer.run_attempt}`, false, serviceEnvironment));
  assertTrustedRun(publisher, {
    repository: repositories.service, workflow_path: PUBLISHER_WORKFLOW,
    run_id: producer.run_id, run_attempt: producer.run_attempt, sha: producer.workflow_sha,
  });
  if (producer.workflow_ref !== `${repositories.service}/${PUBLISHER_WORKFLOW}@refs/heads/main`) throw new Error('Service publisher workflow ref mismatch');
  const tag = parseStrictJson(await api(`repos/${repositories.service}/git/ref/tags/${release.tag_name}`, false, serviceEnvironment));
  const taggedCommit = tag.object.type === 'tag'
    ? parseStrictJson(await api(`repos/${repositories.service}/git/tags/${tag.object.sha}`, false, serviceEnvironment)).object
    : tag.object;
  if (taggedCommit.type !== 'commit' || taggedCommit.sha !== producer.workflow_sha) throw new Error('Immutable Service tag source mismatch');
  const selected = await verifySelectedInputs(compatibility, record.selection, directory, environment);
  assertCommittedSelection(selected.selector, record.selection);
  assertSelectionManifest(selected.selector, selected.manifest);
  assertEqual(selected.manifest, manifest, 'Pinned Infra direct consumer manifest');
  await writeFile(resolve(directory, 'verified-inputs.json'), `${JSON.stringify({ compatibility, deployment: record, manifest }, null, 2)}\n`);
  return { compatibility, deployment: record, manifest };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const compatibility = parseStrictJson(await readFile(new URL('../compatibility.json', import.meta.url)));
  await loadTrustedInputs(compatibility, resolve(process.env.QUALIFICATION_INPUTS_DIR ?? '.qualification-inputs'));
  console.log('Verified exact trusted Infra artifact and immutable Service manifest.');
}
