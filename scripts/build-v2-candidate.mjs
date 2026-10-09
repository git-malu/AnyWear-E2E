import { execFileSync } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  assertTrustedArtifact, assertTrustedRun, extractDeploymentRecord, ghApi,
  repositoryReadEnvironment,
} from './trusted-deployment-inputs.mjs';
import { listRunArtifacts, selectDeploymentArtifact } from './migrate-compatibility.mjs';
import { byteHash, parseStrictJson, repositories, validateCompatibility } from './evidence-contract.mjs';

export const candidateBuilderTarget = Object.freeze({
  infraSha: 'bafc3072ea6aee2d5193009c014cb1cf04b43848',
  infraRunId: 37887802281,
  infraRunAttempt: 1,
  infraArtifactId: 11598145428,
  workflowPath: '.github/workflows/build-v2-candidate.yml',
  e2eRepositoryId: '1317091305',
});

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const candidateWorkflowRef = `${repositories.e2e}/${candidateBuilderTarget.workflowPath}@refs/heads/main`;

export function assertCandidateBuilderContext(environment = process.env, { requireTokens = true } = {}) {
  const expected = {
    GITHUB_REPOSITORY: repositories.e2e,
    GITHUB_REPOSITORY_ID: candidateBuilderTarget.e2eRepositoryId,
    GITHUB_REF: 'refs/heads/main',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_WORKFLOW_REF: candidateWorkflowRef,
  };
  for (const [name, value] of Object.entries(expected)) {
    if (environment[name] !== value) throw new Error(`Candidate builder requires ${name}=${value}`);
  }
  if (!/^[a-f0-9]{40}$/.test(environment.GITHUB_SHA ?? '')
    || environment.GITHUB_WORKFLOW_SHA !== environment.GITHUB_SHA) {
    throw new Error('Candidate builder workflow and source must be the same exact main commit');
  }
  for (const name of ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT']) {
    if (!/^[1-9]\d*$/.test(environment[name] ?? '') || !Number.isSafeInteger(Number(environment[name]))) {
      throw new Error(`Invalid ${name}`);
    }
  }
  if (requireTokens) {
    for (const name of ['GH_TOKEN', 'SERVICE_ARTIFACT_READ_TOKEN', 'CLIENT_CONTENTS_READ_TOKEN']) {
      if (!environment[name]?.trim()) throw new Error(`${name} is required`);
    }
  }
  return true;
}

function writeWorkflowOutput(name, value, environment = process.env) {
  if (!environment.GITHUB_OUTPUT) return;
  if (!/^[a-z_]+$/.test(name) || /[\r\n]/.test(value)) throw new Error('Invalid workflow output');
  return appendFile(environment.GITHUB_OUTPUT, `${name}=${value}\n`, { encoding: 'utf8', flag: 'a' });
}

export async function buildCandidate({ environment = process.env, api = ghApi,
  outputRoot = resolve(sourceRoot, '.qualification-inputs'),
  suppressMigrationErrors = true,
  extractRecord = extractDeploymentRecord,
  runMigration = ({ recordPath, candidatePath, sourceRoot: cwd, env }) => {
    try {
      execFileSync(process.execPath, [resolve(cwd, 'scripts/migrate-compatibility.mjs'),
        '--deployment-record', recordPath, '--output', candidatePath], {
        cwd, env, timeout: 15 * 60_000, maxBuffer: 4 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      // Remote CLI failures may include response bodies or authorization details.
      // Keep the workflow log generic and prevent a cause from leaking them.
      throw new Error('Trusted v2 migration failed; remote response details are suppressed');
    }
  },
} = {}) {
  assertCandidateBuilderContext(environment);
  const infraEnvironment = repositoryReadEnvironment(repositories.infra, environment);
  const run = parseStrictJson(await api(
    `repos/${repositories.infra}/actions/runs/${candidateBuilderTarget.infraRunId}/attempts/${candidateBuilderTarget.infraRunAttempt}`,
    false, infraEnvironment,
  ));
  assertTrustedRun(run, {
    repository: repositories.infra,
    workflow_path: '.github/workflows/runtime.yml',
    run_id: candidateBuilderTarget.infraRunId,
    run_attempt: candidateBuilderTarget.infraRunAttempt,
    sha: candidateBuilderTarget.infraSha,
  });
  const artifacts = await listRunArtifacts(run, infraEnvironment, api);
  const artifact = selectDeploymentArtifact(artifacts, run);
  if (artifact.id !== candidateBuilderTarget.infraArtifactId) {
    throw new Error('Infra deployment artifact differs from the fixed candidate target');
  }
  assertTrustedArtifact(artifact, {
    deployment: {
      artifact_id: candidateBuilderTarget.infraArtifactId,
      run_id: candidateBuilderTarget.infraRunId,
      run_attempt: candidateBuilderTarget.infraRunAttempt,
    },
    infra: { sha: candidateBuilderTarget.infraSha },
  }, run);

  const archive = await api(
    `repos/${repositories.infra}/actions/artifacts/${candidateBuilderTarget.infraArtifactId}/zip`,
    true, infraEnvironment,
  );
  if (artifact.digest && artifact.digest !== `sha256:${byteHash(archive)}`) {
    throw new Error('Infra deployment artifact archive digest mismatch');
  }
  const outputDirectory = resolve(outputRoot,
    `untrusted-for-main-v2-candidate-${environment.GITHUB_RUN_ID}-${environment.GITHUB_RUN_ATTEMPT}`);
  await mkdir(outputRoot, { recursive: true });
  await mkdir(outputDirectory, { recursive: false });
  const temporaryDirectory = await mkdtemp(resolve(tmpdir(), 'anywear-v2-candidate-'));
  const archivePath = resolve(temporaryDirectory, 'deployment.zip');
  const recordPath = resolve(temporaryDirectory, 'deployment-record.json');
  const candidatePath = resolve(outputDirectory, 'v2-candidate.json');
  const notePath = resolve(outputDirectory, 'UNTRUSTED-FOR-MAIN-PR-ARTIFACT.txt');
  const provenancePath = resolve(outputDirectory, 'candidate-provenance.json');
  try {
    await writeFile(archivePath, archive, { flag: 'wx' });
    await writeFile(recordPath, await extractRecord(archivePath), { flag: 'wx' });
    await runMigration({ recordPath, candidatePath, sourceRoot, env: environment });
  } catch (error) {
    // Migration and extraction errors can include remote response details.
    // Keep the workflow log generic and prevent those details from leaking.
    if (!suppressMigrationErrors) throw error;
    // eslint-disable-next-line preserve-caught-error -- Remote error details may include authenticated response bodies.
    throw new Error('Trusted v2 migration failed; remote response details are suppressed');
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
  const candidate = validateCompatibility(parseStrictJson(await readFile(candidatePath)));
  const v1 = validateCompatibility(parseStrictJson(await readFile(resolve(sourceRoot, 'compatibility.json'))), { allowLegacy: true });
  if (v1.version !== 1 || candidate.client.sha !== v1.client.sha || candidate.service.sha !== v1.service.sha
    || candidate.infra.sha !== candidateBuilderTarget.infraSha
    || candidate.deployment.workflow_path !== '.github/workflows/runtime.yml'
    || candidate.deployment.run_id !== candidateBuilderTarget.infraRunId
    || candidate.deployment.run_attempt !== candidateBuilderTarget.infraRunAttempt
    || candidate.deployment.artifact_id !== candidateBuilderTarget.infraArtifactId) {
    throw new Error('Generated candidate differs from the fixed deployment target or committed v1 pins');
  }
  await writeFile(notePath, [
    'UNTRUSTED-FOR-MAIN REVIEW ARTIFACT — DO NOT USE DIRECTLY FOR QUALIFICATION.',
    'This candidate was generated by the read-only E2E candidate-builder workflow after authenticated input verification.',
    'It has not been independently reviewed or committed as the main compatibility set.',
    'A separate reviewed source change must add any accepted candidate to compatibility.json.',
  ].join('\n') + '\n', { flag: 'wx' });
  await writeFile(provenancePath, `${JSON.stringify({
    classification: 'untrusted-for-main-pr-review',
    workflow: { repository: repositories.e2e, path: candidateBuilderTarget.workflowPath,
      sha: environment.GITHUB_SHA, run_id: Number(environment.GITHUB_RUN_ID),
      run_attempt: Number(environment.GITHUB_RUN_ATTEMPT) },
    target: { repository: repositories.infra, sha: candidateBuilderTarget.infraSha,
      run_id: candidateBuilderTarget.infraRunId, run_attempt: candidateBuilderTarget.infraRunAttempt,
      artifact_id: candidateBuilderTarget.infraArtifactId },
    deployment_record_sha256: candidate.deployment.record_sha256,
    candidate_sha256: byteHash(await readFile(candidatePath)),
  }, null, 2)}\n`, { flag: 'wx' });
  await writeWorkflowOutput('candidate_dir', outputDirectory, environment);
  return { outputDirectory, candidatePath, notePath, provenancePath, candidate };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const preflight = process.argv.length === 3 && process.argv[2] === '--preflight';
  if (process.argv.length > 3 || (process.argv.length === 3 && !preflight)) throw new Error('Unknown candidate builder option');
  assertCandidateBuilderContext(process.env, { requireTokens: !preflight });
  if (!preflight) {
    const result = await buildCandidate();
    console.log(`Validated authenticated deployment inputs and wrote an untrusted-for-main candidate artifact to ${result.outputDirectory}.`);
  } else {
    console.log('Verified exact main-only candidate builder dispatch context.');
  }
}
