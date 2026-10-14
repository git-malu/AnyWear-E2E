import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertEqual, byteHash, parseStrictJson, repositories, repositoryIds, requireOwnedRepository } from './evidence-contract.mjs';
import { assertOrigin } from './cleanup-acceptance-contract.mjs';
import { ghApi } from './trusted-deployment-inputs.mjs';

export function assertAcceptanceArtifact(origin, run, artifact, name, { inProgress = false, now = Date.now() } = {}) {
  assertOrigin(origin, origin.repository);
  const repositoryId = repositoryIds[origin.repository];
  for (const repository of [run.repository, run.head_repository]) requireOwnedRepository(repository, origin.repository, 'Acceptance run repository');
  if (![repositories.e2e, repositories.infra].includes(origin.repository) || run.id !== origin.run_id || run.run_attempt !== origin.run_attempt
    || run.repository?.full_name !== origin.repository || run.path !== origin.workflow_path || run.head_sha !== origin.source_sha
    || run.head_branch !== 'main' || run.event !== 'workflow_dispatch'
    || (!inProgress && (run.status !== 'completed' || run.conclusion !== 'success'))
    || (inProgress && (run.status !== 'in_progress' || run.conclusion !== null))
    || artifact.id !== origin.artifact_id || artifact.name !== name || artifact.digest !== `sha256:${origin.artifact_sha256}`
    || artifact.expired !== false || !(Date.parse(artifact.expires_at) > now)
    || !Number.isSafeInteger(artifact.size_in_bytes) || artifact.size_in_bytes < 1 || artifact.size_in_bytes > 16 * 1024 * 1024
    || artifact.workflow_run?.id !== run.id || artifact.workflow_run?.head_sha !== run.head_sha
    || artifact.workflow_run.head_branch !== 'main'
    || artifact.workflow_run.repository_id !== repositoryId || artifact.workflow_run.head_repository_id !== repositoryId) throw new Error('Exact protected acceptance artifact origin mismatch');
  const started = Date.parse(run.run_started_at), created = Date.parse(artifact.created_at), updated = Date.parse(run.updated_at), runCreated = Date.parse(run.created_at);
  if (![started, created, updated, runCreated].every(Number.isFinite) || runCreated > started || created < started || (!inProgress && created > updated)) throw new Error('Acceptance artifact does not bind the attempt time');
}

export function readAcceptanceArchive(path, required, optional = [], execute = execFileSync) {
  const output = execute('python3', ['-c', [
    'import sys,zipfile,json,base64,stat',
    'required=json.loads(sys.argv[2]); allowed=required+json.loads(sys.argv[3])',
    'with zipfile.ZipFile(sys.argv[1]) as z:',
    ' entries=z.infolist(); names=[e.filename for e in entries]',
    ' if len(names)!=len(set(names)) or any(n not in allowed for n in names) or any(n not in names for n in required): raise ValueError("Unexpected acceptance artifact files")',
    ' if any(e.is_dir() or e.file_size>1048576 or stat.S_IFMT(e.external_attr>>16) not in (0,stat.S_IFREG) for e in entries): raise ValueError("Unsafe or unbounded acceptance file")',
    ' print(json.dumps({e.filename:base64.b64encode(z.read(e)).decode("ascii") for e in entries}))',
  ].join('\n'), path, JSON.stringify(required), JSON.stringify(optional)], { timeout: 15_000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const files = parseStrictJson(output);
  return Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, Buffer.from(bytes, 'base64')]));
}

export async function loadAcceptanceOrigin(origin, { name, file, required = [file], optional = [], directory = 'acceptance-inputs', inProgress = false,
  environment = process.env, api = ghApi, extract = readAcceptanceArchive } = {}) {
  assertOrigin(origin, origin.repository);
  if (inProgress) {
    const own = { repository: environment.GITHUB_REPOSITORY, source_sha: environment.GITHUB_SHA,
      run_id: Number(environment.GITHUB_RUN_ID), run_attempt: Number(environment.GITHUB_RUN_ATTEMPT) };
    if (origin.repository !== repositories.e2e || Object.entries(own).some(([key, value]) => origin[key] !== value)
      || !['creation-intent.json', 'retry-intent.json'].includes(file)
      || name !== `beta-cleanup-acceptance-${file === 'creation-intent.json' ? 'intent' : 'retry-intent'}-${origin.run_id}-${origin.run_attempt}`) throw new Error('In-progress acceptance is limited to the exact current owned intent');
  }
  const token = origin.repository === repositories.e2e ? environment.E2E_EVIDENCE_READ_TOKEN : environment.INFRA_EVIDENCE_READ_TOKEN;
  if (!token) throw new Error('Dedicated read-only acceptance evidence token required');
  const scoped = { ...environment, GH_TOKEN: token };
  for (const key of ['GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'E2E_EVIDENCE_READ_TOKEN', 'INFRA_EVIDENCE_READ_TOKEN']) delete scoped[key];
  const run = parseStrictJson(api(`repos/${origin.repository}/actions/runs/${origin.run_id}/attempts/${origin.run_attempt}`, false, scoped));
  const artifact = parseStrictJson(api(`repos/${origin.repository}/actions/artifacts/${origin.artifact_id}`, false, scoped));
  assertAcceptanceArtifact(origin, run, artifact, name, { inProgress });
  const archive = api(`repos/${origin.repository}/actions/artifacts/${origin.artifact_id}/zip`, true, scoped);
  if (byteHash(archive) !== origin.artifact_sha256) throw new Error('Acceptance ZIP digest mismatch');
  await mkdir(directory, { recursive: true });
  const archivePath = join(directory, `${origin.artifact_id}.zip`);
  await writeFile(archivePath, archive, { mode: 0o600 });
  const files = extract(archivePath, required, optional);
  if (byteHash(files[file]) !== origin.manifest_sha256) throw new Error('Acceptance raw manifest checksum mismatch');
  const finalRun = parseStrictJson(api(`repos/${origin.repository}/actions/runs/${origin.run_id}/attempts/${origin.run_attempt}`, false, scoped));
  const finalArtifact = parseStrictJson(api(`repos/${origin.repository}/actions/artifacts/${origin.artifact_id}`, false, scoped));
  assertAcceptanceArtifact(origin, finalRun, finalArtifact, name, { inProgress });
  assertEqual(finalArtifact, artifact, 'Acceptance artifact before/after read-back');
  const runFields = ['id', 'run_attempt', 'repository', 'head_repository', 'path', 'head_sha', 'head_branch', 'event', 'status', 'conclusion', 'run_started_at'];
  assertEqual(Object.fromEntries(runFields.map(key => [key, finalRun[key]])), Object.fromEntries(runFields.map(key => [key, run[key]])), 'Acceptance run before/after read-back');
  return { record: parseStrictJson(files[file]), files, artifact, run };
}

export async function localFileHash(path) { return byteHash(await readFile(path)); }
