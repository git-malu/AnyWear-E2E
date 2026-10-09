import { writeFile, appendFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ghApi } from './trusted-deployment-inputs.mjs';
import { byteHash, exactKeys, parseStrictJson, requireCommit, requireId, repositories } from './evidence-contract.mjs';

const CAPTURED_SUBJECT = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const WORKER_EMAIL = /^e2e-beta-worker-[0-7]-chromium@anywear\.local$/;
const RECOVERABLE_STATUSES = new Set(['reserved', 'provisioning', 'in_use', 'cleanup_pending']);

export function assertRecoveryArtifact(artifact, run) {
  const started = Date.parse(run.run_started_at);
  const completed = Date.parse(run.updated_at);
  const created = Date.parse(artifact.created_at);
  if (!Number.isSafeInteger(artifact.id) || artifact.id < 1
    || artifact.name !== `beta-account-lifecycle-${run.id}-${run.run_attempt}`
    || !/^sha256:[a-f0-9]{64}$/.test(artifact.digest ?? '')
    || artifact.expired !== false || !(Date.parse(artifact.expires_at) > Date.now())
    || artifact.workflow_run?.id !== run.id || artifact.workflow_run?.head_sha !== run.head_sha
    || ![started, completed, created].every(Number.isFinite)
    || started > completed || created < started || created > completed) {
    throw new Error('Original account artifact does not bind the exact trusted run/attempt/source');
  }
  return artifact;
}

function readAccountArchive(archivePath) {
  // Read only bounded known files; never extract paths from the archive.
  return parseStrictJson(execFileSync('python3', ['-c', [
    'import sys, zipfile, json, base64',
    'with zipfile.ZipFile(sys.argv[1]) as z:',
    ' entries=z.infolist()',
    ' names=[e.filename for e in entries]',
    ' if len(names)!=len(set(names)) or "account-budget.json" not in names or any(n not in ("account-budget.json","service-cleanup-run.json","service-cleanup-operation.json") for n in names): raise ValueError("Unexpected account artifact contents")',
    ' if any(e.is_dir() or e.file_size>1048576 for e in entries): raise ValueError("Unbounded account artifact file")',
    ' print(json.dumps({e.filename:base64.b64encode(z.read(e)).decode("ascii") for e in entries}))',
  ].join('\n'), archivePath], { timeout: 15_000, maxBuffer: 3 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }));
}

export function prepareAccountRecovery(manifest, run, sourceRunId, sourceAttempt) {
  requireId(sourceRunId, 'Original E2E run'); requireId(sourceAttempt, 'Original E2E attempt');
  requireCommit(run.head_sha, 'Original trusted E2E source');
  if (run.id !== sourceRunId || run.run_attempt !== sourceAttempt
    || run.repository?.full_name !== repositories.e2e || run.head_branch !== 'main' || run.event !== 'workflow_dispatch'
    || !['.github/workflows/integration.yml', '.github/workflows/beta-qualification.yml'].includes(run.path)
    || run.status !== 'completed' || !['success', 'failure', 'cancelled', 'timed_out'].includes(run.conclusion)) throw new Error('Original E2E run is not a completed trusted account owner');
  if (manifest.version !== 1 || !new RegExp(`^${sourceRunId}-${sourceAttempt}-[a-f0-9]{16}$`).test(manifest.runScope)
    || !Array.isArray(manifest.accounts) || manifest.accounts.length > 50) throw new Error('Account manifest does not belong to the exact original run/attempt');
  for (const account of manifest.accounts) {
    if (!['worker', 'ephemeral'].includes(account.mode) || !['reserved', 'provisioning', 'in_use', 'cleanup_pending', 'deleted', 'quarantined'].includes(account.status)) throw new Error('Unknown account recovery state');
    if (account.mode === 'worker' && RECOVERABLE_STATUSES.has(account.status)
      && typeof account.subject === 'string' && CAPTURED_SUBJECT.test(account.subject)
      && typeof account.email === 'string' && WORKER_EMAIL.test(account.email)) account.status = 'cleanup_pending';
  }
  const budgetFields = ['maxActiveAccounts', 'maxNewAccountsPerRun', 'maxQuarantinedAccounts'];
  exactKeys(manifest.config, budgetFields, 'Original account budget');
  for (const field of budgetFields) requireId(manifest.config[field], `Original account budget ${field}`);
  if (manifest.config.maxActiveAccounts > 8) throw new Error('Original account pool exceeds the supported worker slots');
  if (manifest.config.maxNewAccountsPerRun < manifest.config.maxActiveAccounts) throw new Error('Original new-account budget is smaller than the active-account budget');
  // account-budget.ts writes/checks this producer order. Preserve all values
  // while normalizing key order before any later cloud cleanup can occur.
  manifest.config = Object.fromEntries(budgetFields.map(field => [field, manifest.config[field]]));
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const id = Number(process.env.RECOVERY_SOURCE_RUN_ID);
  const attempt = Number(process.env.RECOVERY_SOURCE_RUN_ATTEMPT);
  requireId(id, 'Original run'); requireId(attempt, 'Original attempt');
  const path = process.env.E2E_ACCOUNT_BUDGET_PATH;
  const run = parseStrictJson(ghApi(`repos/${repositories.e2e}/actions/runs/${id}/attempts/${attempt}`));
  const name = `beta-account-lifecycle-${id}-${attempt}`;
  const response = parseStrictJson(ghApi(`repos/${repositories.e2e}/actions/runs/${id}/artifacts?name=${name}&per_page=100`));
  if (response.total_count !== 1 || response.artifacts?.length !== 1) throw new Error('Exact original account artifact must exist uniquely');
  const artifact = assertRecoveryArtifact(response.artifacts[0], run);
  const archive = ghApi(`repos/${repositories.e2e}/actions/artifacts/${artifact.id}/zip`, true);
  if (artifact.digest !== `sha256:${byteHash(archive)}`) throw new Error('Original account artifact digest mismatch');
  await mkdir(dirname(path), { recursive: true });
  const archivePath = resolve(dirname(path), 'original-account-artifact.zip');
  await writeFile(archivePath, archive);
  const files = readAccountArchive(archivePath);
  const bytes = Buffer.from(files['account-budget.json'], 'base64');
  const manifest = parseStrictJson(bytes);
  // Validate before preserving or rewriting any account state.
  prepareAccountRecovery(manifest, run, id, attempt);
  await writeFile(resolve(dirname(path), 'original-account-budget.json'), bytes, { mode: 0o600 });
  if (files['service-cleanup-run.json']) await writeFile(resolve(dirname(path), 'original-service-cleanup-run.json'), Buffer.from(files['service-cleanup-run.json'], 'base64'), { mode: 0o600 });
  if (files['service-cleanup-operation.json']) await writeFile(resolve(dirname(path), 'original-service-cleanup-operation.json'), Buffer.from(files['service-cleanup-operation.json'], 'base64'), { mode: 0o600 });
  await writeFile(resolve(dirname(path), 'original-owner.json'), `${JSON.stringify({
    schema_version: 1, record_type: 'anywear_e2e_recovery_origin', run, artifact,
    archive_sha256: byteHash(archive), manifest_sha256: byteHash(bytes),
  }, null, 2)}\n`, { mode: 0o600 });
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await appendFile(process.env.GITHUB_OUTPUT, [
    `run_scope=${manifest.runScope}`, `max_active=${manifest.config.maxActiveAccounts}`,
    `max_new=${manifest.config.maxNewAccountsPerRun}`, `max_quarantined=${manifest.config.maxQuarantinedAccounts}`, '',
  ].join('\n'));
  console.log('Prepared only captured original worker identities for subject-bound Service cleanup.');
}
