import { writeFile, appendFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ghApi } from './github-read.mjs';
import { byteHash, exactKeys, parseStrictJson, requireCommit, requireId, requireImageDigest, requireMatch, repositories } from './evidence-contract.mjs';
import { createServiceCleanupInputs } from '../tests/support/worker-cleanup.ts';
import { assertCleanupOwnerEvidence } from '../tests/support/service-cleanup-operation.ts';
import { isBetaWorkerEmailForScope } from '../tests/support/beta-address.ts';
import { loadDiagnosticEvidence } from './beta-cleanup-diagnostic.mjs';

const CAPTURED_SUBJECT = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
// `quarantined` is recoverable only when the ownership the status withheld can
// still be proven: the loop below normalizes it to `cleanup_pending` only for a
// worker with a captured subject and an address in this manifest's own scope.
// An unproven quarantined record stays terminal and is never offered to cleanup.
const RECOVERABLE_STATUSES = new Set(['reserved', 'provisioning', 'in_use', 'cleanup_pending', 'quarantined']);

// #163 transition allow-list. Recover now runs as an operation of the single `qualify` entry,
// so a new recovery run (and a new original smoke/full run) names `beta-qualification.yml`.
// Historical `integration.yml` originals remain readable so an in-flight recovery can still
// consume the evidence it was captured under.
export const ORIGINAL_OWNER_WORKFLOWS = Object.freeze(['.github/workflows/beta-qualification.yml', '.github/workflows/integration.yml']);

// The replay inputs this issue removed from dispatch. A stale workflow or
// operator that still supplies one of them is refused before any artifact
// download, diagnostic read or AWS credential.
const REMOVED_REPLAY_INPUT = /^(?:E2E_CLEANUP_(?:OPERATION_MODE|RECOVERY_ATTEMPT|RETRY_FAILED)|RECOVERY_PREVIOUS_RUN_(?:ID|ATTEMPT))$/;

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

export function validateAccountRecoverySelection(environment = process.env) {
  const integer = (value, label) => {
    if (!/^[1-9][0-9]*$/.test(value ?? '')) throw new Error(`${label} must be a canonical positive integer`);
    return requireId(Number(value), label);
  };
  for (const key of Object.keys(environment)) {
    if (REMOVED_REPLAY_INPUT.test(key)) throw new Error('Recovery selection accepts the captured identities only');
  }
  const sourceRunId = integer(environment.RECOVERY_SOURCE_RUN_ID, 'Original run');
  const sourceAttempt = integer(environment.RECOVERY_SOURCE_RUN_ATTEMPT, 'Original attempt');
  return { sourceRunId, sourceAttempt };
}

function readAccountArchive(archivePath) {
  // Read only bounded known files; never extract paths from the archive.
  return parseStrictJson(execFileSync('python3', ['-c', [
    'import sys, zipfile, json, base64',
    'with zipfile.ZipFile(sys.argv[1]) as z:',
    ' entries=z.infolist()',
    ' names=[e.filename for e in entries]',
    ' allowed=("account-budget.json","service-cleanup-run.json","service-cleanup-operation.json","original-account-budget.json","original-service-cleanup-run.json","original-service-cleanup-operation.json","original-owner.json","account-recovery-failure.json")',
    ' if len(names)!=len(set(names)) or "account-budget.json" not in names or any(n not in allowed for n in names): raise ValueError("Unexpected account artifact contents")',
    ' if len(entries)>12 or any(e.is_dir() or e.file_size>1048576 or (e.external_attr>>16)&0o170000==0o120000 for e in entries): raise ValueError("Unbounded or unsafe account artifact file")',
    ' print(json.dumps({e.filename:base64.b64encode(z.read(e)).decode("ascii") for e in entries}))',
  ].join('\n'), archivePath], { timeout: 15_000, maxBuffer: 3 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }));
}

export function prepareAccountRecovery(manifest, run, sourceRunId, sourceAttempt) {
  requireId(sourceRunId, 'Original E2E run'); requireId(sourceAttempt, 'Original E2E attempt');
  requireCommit(run.head_sha, 'Original trusted E2E source');
  if (run.id !== sourceRunId || run.run_attempt !== sourceAttempt
    || run.repository?.full_name !== repositories.e2e || run.head_branch !== 'main' || run.event !== 'workflow_dispatch'
    || !ORIGINAL_OWNER_WORKFLOWS.includes(run.path)
    || run.status !== 'completed' || !['success', 'failure', 'cancelled', 'timed_out'].includes(run.conclusion)) throw new Error('Original E2E run is not a completed trusted account owner');
  if (manifest.version !== 1 || !new RegExp(`^${sourceRunId}-${sourceAttempt}-[a-f0-9]{16}$`).test(manifest.runScope)
    || !Array.isArray(manifest.accounts) || manifest.accounts.length > 50) throw new Error('Account manifest does not belong to the exact original run/attempt');
  // Only this manifest's own run scope: the scoped worker family for the scope
  // the original run/attempt proves, or a stable allowlist row that a pre-#129
  // artifact captured. A captured identity is never re-scoped to another run.
  for (const account of manifest.accounts) {
    if (!['worker', 'ephemeral'].includes(account.mode) || !['reserved', 'provisioning', 'in_use', 'cleanup_pending', 'deleted', 'quarantined'].includes(account.status)) throw new Error('Unknown account recovery state');
    if (account.mode === 'worker' && RECOVERABLE_STATUSES.has(account.status)
      && typeof account.subject === 'string' && CAPTURED_SUBJECT.test(account.subject)
      && typeof account.email === 'string' && isBetaWorkerEmailForScope(account.email, manifest.runScope)) account.status = 'cleanup_pending';
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

export async function prepareRecoveryFiles(environment = process.env, {
  api = ghApi,
  extract = readAccountArchive,
  loadDiagnostic = loadDiagnosticEvidence,
} = {}) {
  if (!environment.INFRA_EVIDENCE_READ_TOKEN?.trim()) throw new Error('INFRA_EVIDENCE_READ_TOKEN required for diagnostic evidence');
  const selection = validateAccountRecoverySelection(environment);
  const { sourceRunId: id, sourceAttempt: attempt } = selection;
  const path = environment.E2E_ACCOUNT_BUDGET_PATH;
  const run = parseStrictJson(api(`repos/${repositories.e2e}/actions/runs/${id}/attempts/${attempt}`));
  const name = `beta-account-lifecycle-${id}-${attempt}`;
  const response = parseStrictJson(api(`repos/${repositories.e2e}/actions/runs/${id}/artifacts?name=${name}&per_page=100`));
  if (response.total_count !== 1 || response.artifacts?.length !== 1) throw new Error('Exact original account artifact must exist uniquely');
  const artifact = assertRecoveryArtifact(response.artifacts[0], run);
  const archive = api(`repos/${repositories.e2e}/actions/artifacts/${artifact.id}/zip`, true);
  if (archive.length > 8 * 1024 * 1024 || artifact.digest !== `sha256:${byteHash(archive)}`) throw new Error('Original account artifact digest mismatch or bound exceeded');
  await mkdir(dirname(path), { recursive: true });
  const archivePath = resolve(dirname(path), 'original-account-artifact.zip');
  await writeFile(archivePath, archive);
  const files = extract(archivePath);
  const bytes = Buffer.from(files['account-budget.json'], 'base64');
  const manifest = parseStrictJson(bytes);
  // Validate before preserving or rewriting any account state.
  prepareAccountRecovery(manifest, run, id, attempt);
  const inputs = createServiceCleanupInputs(manifest);
  if (!inputs) throw new Error('Original owner has no captured pending worker request');
  // A retained artifact may predate the account-level cleanup operation: the
  // teardown never attempted it, so there is nothing to replay. The canonical
  // request above already originated from the captured identities; only when the
  // artifact carries evidence does the replay have to match it.
  const originalOperationBytes = files['service-cleanup-operation.json'];
  if (originalOperationBytes) {
    const originalOperation = parseStrictJson(Buffer.from(originalOperationBytes, 'base64'));
    assertCleanupOwnerEvidence(originalOperation, inputs.cleanup_json);
  }
  const diagnosticPath = environment.E2E_BETA_CLEANUP_DIAGNOSTIC_PATH
    ? resolve(environment.E2E_BETA_CLEANUP_DIAGNOSTIC_PATH)
    : resolve(dirname(path), 'beta-cleanup-diagnostic.json');
  const diagnostic = await loadDiagnostic({
    directory: resolve(dirname(diagnosticPath), '.diagnostic-cache'),
    api,
    environment: { ...environment, GH_TOKEN: environment.INFRA_EVIDENCE_READ_TOKEN },
  });
  const diagnosticRecord = diagnostic?.record ?? diagnostic;
  if (!diagnosticRecord || typeof diagnosticRecord !== 'object' || Array.isArray(diagnosticRecord)) throw new Error('Validated Beta cleanup diagnostic record is unavailable');
  const diagnosticServiceSourceSha = requireCommit(diagnosticRecord.service?.source_sha, 'Validated diagnostic Service source');
  const diagnosticServiceImageDigest = requireImageDigest(diagnosticRecord.service?.image_digest);
  const diagnosticStateMachineVersionArn = requireMatch(diagnosticRecord.capability?.state_machine_version_arn,
    /^arn:aws:states:ap-east-1:650880818323:stateMachine:beta-anywear-tester-cleanup:([1-9][0-9]*)$/, 'Validated diagnostic cleanup state machine version');
  const diagnosticBytes = Buffer.from(`${JSON.stringify(diagnosticRecord, null, 2)}\n`);
  await mkdir(dirname(diagnosticPath), { recursive: true });
  await writeFile(resolve(dirname(path), 'original-account-budget.json'), bytes, { mode: 0o600 });
  if (files['service-cleanup-run.json']) await writeFile(resolve(dirname(path), 'original-service-cleanup-run.json'), Buffer.from(files['service-cleanup-run.json'], 'base64'), { mode: 0o600 });
  if (files['service-cleanup-operation.json']) await writeFile(resolve(dirname(path), 'original-service-cleanup-operation.json'), Buffer.from(files['service-cleanup-operation.json'], 'base64'), { mode: 0o600 });
  const ownerBytes = Buffer.from(`${JSON.stringify({
    schema_version: 1, record_type: 'anywear_e2e_recovery_origin', run, artifact,
    archive_sha256: byteHash(archive), manifest_sha256: byteHash(bytes),
  }, null, 2)}\n`);
  await writeFile(resolve(dirname(path), 'original-owner.json'), ownerBytes, { mode: 0o600 });
  await writeFile(diagnosticPath, diagnosticBytes, { mode: 0o600 });
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await appendFile(environment.GITHUB_OUTPUT, [
    `run_scope=${manifest.runScope}`, `max_active=${manifest.config.maxActiveAccounts}`,
    `max_new=${manifest.config.maxNewAccountsPerRun}`, `max_quarantined=${manifest.config.maxQuarantinedAccounts}`, '',
    `original_operation_path=${files['service-cleanup-operation.json'] ? resolve(dirname(path), 'original-service-cleanup-operation.json') : ''}`, '',
    `diagnostic_path=${diagnosticPath}`, `diagnostic_sha256=${byteHash(diagnosticBytes)}`, '',
    `diagnostic_service_source_sha=${diagnosticServiceSourceSha}`, `diagnostic_service_image_digest=${diagnosticServiceImageDigest}`,
    `diagnostic_state_machine_version_arn=${diagnosticStateMachineVersionArn}`, '',
  ].join('\n'));
  console.log('Prepared only captured original worker identities for subject-bound Service cleanup.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv[2] === '--record-failure' && process.argv.length === 3) throw new Error('Recovery workflow failed before completion');
    else if (process.argv[2] === '--validate-inputs' && process.argv.length === 3) validateAccountRecoverySelection();
    else if (process.argv.length === 2) await prepareRecoveryFiles();
    else throw new Error('Unknown account recovery option');
  } catch {
    const directory = dirname(process.env.E2E_ACCOUNT_BUDGET_PATH ?? 'recovery/account-budget.json');
    await mkdir(directory, { recursive: true });
    await writeFile(resolve(directory, 'account-recovery-failure.json'), `${JSON.stringify({ schema_version: 1,
      record_type: 'anywear_e2e_account_recovery_failure', phase: 'owner_preflight', proof_status: 'refused', identities_retained: true })}\n`);
    process.exitCode = 1;
    console.error('Account recovery input/owner/artifact proof unavailable; identities retained');
  }
}
