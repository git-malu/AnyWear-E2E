import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertPreviousRecovery, assertRecoveryArtifact, prepareAccountRecovery, prepareRecoveryFiles, validateAccountRecoverySelection } from './account-recovery-inputs.mjs';
import { byteHash } from './evidence-contract.mjs';
import { runCapturedWorkerCleanup } from './cleanup-worker-accounts.mjs';
import { cleanupExecutionArn, createCleanupOperationEnvelope, deterministicCleanupExecutionName } from '../tests/support/service-cleanup-operation.ts';

const base = { E2E_CLEANUP_OPERATION_MODE: 'recovery', E2E_CLEANUP_RECOVERY_ATTEMPT: '1', RECOVERY_SOURCE_RUN_ID: '123', RECOVERY_SOURCE_RUN_ATTEMPT: '1', INFRA_EVIDENCE_READ_TOKEN: 'infra-reader' };
const manifest = { version: 1, runScope: '123-1-0000000000000000', config: { maxActiveAccounts: 2, maxNewAccountsPerRun: 4, maxQuarantinedAccounts: 2 },
  accounts: [0, 1].map(slot => ({ mode: 'worker', status: 'cleanup_pending', email: `e2e-beta-worker-${slot}-chromium@anywear.local`,
    subject: `00000000-0000-0000-0000-00000000000${slot + 1}`, leaseId: `lease-${slot}`, leaseGeneration: 'owner', createdAt: 'created', updatedAt: 'created' })) };
const request = JSON.stringify({ runScope: manifest.runScope, users: manifest.accounts.map(account => ({ sub: account.subject, email: account.email })) });
const tuple = { E2E_CLEANUP_SERVICE_SHA: 'a'.repeat(40), E2E_CLEANUP_SERVICE_IMAGE_DIGEST: `sha256:${'b'.repeat(64)}`,
  BETA_CLEANUP_STATE_MACHINE_VERSION_ARN: 'arn:aws:states:ap-east-1:650880818323:stateMachine:beta-anywear-tester-cleanup:7' };
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64');
function operation(input) {
  const name = deterministicCleanupExecutionName(input);
  return { schema_version: 3, record_type: 'anywear_e2e_service_cleanup_operation', operation: {
    ...(input.operation_mode ? { operation_mode: input.operation_mode } : {}), ...(input.recovery_attempt ? { recovery_attempt: input.recovery_attempt } : {}),
    input, input_sha256: byteHash(JSON.stringify(input)), execution_name: name,
    execution_arn: cleanupExecutionArn(tuple.BETA_CLEANUP_STATE_MACHINE_VERSION_ARN, name), state_machine_version_arn: tuple.BETA_CLEANUP_STATE_MACHINE_VERSION_ARN,
    status: 'FAILED', proof_status: 'refused',
  } };
}
const normal = createCleanupOperationEnvelope({ action: 'cleanup', emails: '[]', cleanup_json: request }, tuple);
const legacy = Object.fromEntries(Object.entries(normal).filter(([key]) => key !== 'operation_mode'));
const recovery = createCleanupOperationEnvelope({ action: 'cleanup', emails: '[]', cleanup_json: request }, tuple, 'recovery', 1);
const run = { id: 123, run_attempt: 1, head_sha: 'c'.repeat(40), repository: { full_name: 'git-malu/AnyWear-E2E' }, head_branch: 'main', event: 'workflow_dispatch',
  path: '.github/workflows/beta-qualification.yml', status: 'completed', conclusion: 'failure', run_started_at: '2026-10-08T00:00:00Z', updated_at: '2026-10-08T00:20:00Z' };
const priorRun = { ...run, id: 456, path: '.github/workflows/account-recovery.yml' };
const priorSelection = { mode: 'recovery', sourceRunId: 123, sourceAttempt: 1, recoveryAttempt: 1 };
const originalFiles = { 'original-account-budget.json': encode(manifest), 'original-service-cleanup-operation.json': encode(operation(legacy)), 'original-owner.json': encode({ run }) };
const priorFiles = { ...originalFiles, 'account-budget.json': encode(manifest), 'service-cleanup-operation.json': encode(operation(recovery)), 'recovery-selection.json': encode(priorSelection) };
const selection = { ...priorSelection, recoveryAttempt: 2, previousRunId: 456, previousRunAttempt: 1 };
const diagnostic = { record: { schema_version: 1, record_type: 'anywear_beta_cleanup_diagnostic', service: { source_sha: 'a'.repeat(40), image_digest: `sha256:${'b'.repeat(64)}` }, capability: { state_machine_version_arn: 'arn:aws:states:ap-east-1:650880818323:stateMachine:beta-anywear-tester-cleanup:3' } } };

test('formal recovery selection rejects invalid combinations before credentials', () => {
  assert.equal(validateAccountRecoverySelection(base).recoveryAttempt, 1);
  assert.equal(validateAccountRecoverySelection({ ...base, E2E_CLEANUP_OPERATION_MODE: 'normal', E2E_CLEANUP_RECOVERY_ATTEMPT: '' }).mode, 'normal');
  for (const patch of [{ E2E_CLEANUP_OPERATION_MODE: undefined }, { E2E_CLEANUP_RECOVERY_ATTEMPT: '0' }, { E2E_CLEANUP_RECOVERY_ATTEMPT: '01' },
    { E2E_CLEANUP_RECOVERY_ATTEMPT: '1000000' }, { E2E_CLEANUP_OPERATION_MODE: 'normal' }, { E2E_CLEANUP_RETRY_FAILED: 'true' },
    { RECOVERY_SOURCE_RUN_ID: '1e2' }, { RECOVERY_PREVIOUS_RUN_ID: '456' }, { E2E_CLEANUP_RECOVERY_ATTEMPT: '2' }]) assert.throws(() => validateAccountRecoverySelection({ ...base, ...patch }));
});

test('recovery captures this run scope\u2019s scoped worker addresses and refuses a foreign scope', () => {
  const scoped = (scope, slot, suffix) => ({ mode: 'worker', status: 'in_use',
    email: `e2e-beta-${scope}-${slot}-${suffix}@anywear.local`, subject: `00000000-0000-0000-0000-00000000000${slot + 1}`,
    leaseId: `lease-${slot}`, leaseGeneration: 'owner', createdAt: 'created', updatedAt: 'created' });
  const forScope = (emailScope) => ({ ...structuredClone(manifest),
    accounts: [scoped(emailScope, 0, 'a1b2c3d4'), scoped(emailScope, 1, 'b1c2d3e4')] });

  // The scoped family for the manifest's own scope is a captured identity.
  const own = prepareAccountRecovery(forScope(manifest.runScope), run, 123, 1);
  assert.deepEqual(own.accounts.map(account => account.status), ['cleanup_pending', 'cleanup_pending']);
  // The same shape carrying another run's scope is not: a captured identity is
  // never re-scoped to a request that is not its own.
  const foreign = prepareAccountRecovery(forScope('456-1-0000000000000000'), run, 123, 1);
  assert.deepEqual(foreign.accounts.map(account => account.status), ['in_use', 'in_use']);
  // The retained stable rows a pre-#129 artifact captured stay recoverable.
  assert.deepEqual(prepareAccountRecovery(structuredClone(manifest), run, 123, 1).accounts.map(account => account.status),
    ['cleanup_pending', 'cleanup_pending']);
});

test('previous recovery provenance binds source run/attempt and exact canonical original owner files', () => {
  assert.equal(assertPreviousRecovery(priorRun, selection, priorFiles, originalFiles).evidence.operation.input.recovery_attempt, 1);
  for (const patch of [{ status: 'in_progress' }, { run_attempt: 2 }, { head_branch: 'feature' }, { event: 'pull_request' },
    { path: '.github/workflows/integration.yml' }, { repository: { full_name: 'fork/AnyWear-E2E' } }]) assert.throws(() => assertPreviousRecovery({ ...priorRun, ...patch }, selection, priorFiles, originalFiles));
  for (const name of Object.keys(originalFiles)) assert.throws(() => assertPreviousRecovery(priorRun, selection, { ...priorFiles, [name]: encode({ changed: true }) }, originalFiles));
  const changed = structuredClone(manifest); changed.accounts.pop();
  assert.throws(() => assertPreviousRecovery(priorRun, selection, { ...priorFiles, 'account-budget.json': encode(changed) }, originalFiles));
  const drifted = operation(recovery); drifted.operation.input_sha256 = 'f'.repeat(64);
  assert.throws(() => assertPreviousRecovery(priorRun, selection, { ...priorFiles, 'service-cleanup-operation.json': encode(drifted) }, originalFiles));
  const wrongName = operation(recovery); wrongName.operation.execution_name += '-changed';
  assert.throws(() => assertPreviousRecovery(priorRun, selection, { ...priorFiles, 'service-cleanup-operation.json': encode(wrongName) }, originalFiles));
  assert.throws(() => assertPreviousRecovery(priorRun, { ...selection, recoveryAttempt: 3 }, priorFiles, originalFiles));
});

test('recovery artifact uses its own trusted run/attempt and downloaded digest', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'account-recovery-origin-'));
  const archive = Buffer.from('authenticated archive bytes');
  const artifact = { id: 55, name: 'beta-account-lifecycle-123-1', digest: `sha256:${byteHash(archive)}`, expired: false,
    created_at: '2026-10-08T00:10:00Z', expires_at: '2099-01-01T00:00:00Z', workflow_run: { id: run.id, head_sha: run.head_sha } };
  const priorArtifact = { ...artifact, id: 66, name: 'beta-account-recovery-456-1', workflow_run: { id: 456, head_sha: priorRun.head_sha } };
  assert.equal(assertRecoveryArtifact(priorArtifact, priorRun, true), priorArtifact);
  assert.throws(() => assertRecoveryArtifact({ ...priorArtifact, name: 'beta-account-recovery-123-1' }, priorRun, true));
  let extracted = 0;
  const files = { 'account-budget.json': encode(manifest), 'service-cleanup-operation.json': encode(operation(legacy)) };
  const api = path => {
    if (path.endsWith('/attempts/1')) return JSON.stringify(run);
    if (path.includes('/artifacts?')) return JSON.stringify({ total_count: 1, artifacts: [artifact] });
    if (path.endsWith('/zip')) return archive;
    throw new Error('Unexpected API read');
  };
  const env = { ...base, E2E_ACCOUNT_BUDGET_PATH: join(directory, 'account-budget.json'), GITHUB_OUTPUT: join(directory, 'outputs') };
  try {
    await prepareRecoveryFiles(env, { api, extract: () => { extracted++; return files; }, loadDiagnostic: async () => diagnostic });
    assert.equal(extracted, 1);
    assert.equal(JSON.parse(await readFile(join(directory, 'original-service-cleanup-operation.json'), 'utf8')).operation.input.operation_mode, undefined);
    assert.equal(JSON.parse(await readFile(env.E2E_ACCOUNT_BUDGET_PATH, 'utf8')).accounts.length, 2);
    assert.equal(JSON.parse(await readFile(join(directory, 'beta-cleanup-diagnostic.json'), 'utf8')).record_type, 'anywear_beta_cleanup_diagnostic');
    const output = await readFile(env.GITHUB_OUTPUT, 'utf8');
    assert.match(output, /diagnostic_path=.*beta-cleanup-diagnostic\.json/);
    assert.match(output, /diagnostic_sha256=[a-f0-9]{64}/);
    assert.match(output, new RegExp(`diagnostic_service_source_sha=${tuple.E2E_CLEANUP_SERVICE_SHA}`));
    assert.match(output, new RegExp(`diagnostic_service_image_digest=${tuple.E2E_CLEANUP_SERVICE_IMAGE_DIGEST}`));
    assert.match(output, /diagnostic_state_machine_version_arn=arn:aws:states:ap-east-1:650880818323:stateMachine:beta-anywear-tester-cleanup:3/);
    const persistedOriginal = { ...priorFiles };
    for (const name of Object.keys(originalFiles)) persistedOriginal[name] = (await readFile(join(directory, name))).toString('base64');
    const priorApi = path => {
      if (path.includes('/runs/456/attempts/')) return JSON.stringify(priorRun);
      if (path.includes('/runs/456/artifacts?')) return JSON.stringify({ total_count: 1, artifacts: [priorArtifact] });
      return api(path);
    };
    const envNext = { ...env, E2E_CLEANUP_RECOVERY_ATTEMPT: '2', RECOVERY_PREVIOUS_RUN_ID: '456', RECOVERY_PREVIOUS_RUN_ATTEMPT: '1' };
    await prepareRecoveryFiles(envNext, { api: priorApi, extract: path => path.endsWith('previous-recovery-artifact.zip') ? persistedOriginal : files, loadDiagnostic: async () => diagnostic });
    assert.equal(JSON.parse(await readFile(join(directory, 'previous-recovery-operation.json'), 'utf8')).operation.input.recovery_attempt, 1);
    await assert.rejects(prepareRecoveryFiles(envNext, { api: path => path.includes('/artifacts/66/zip') ? Buffer.from('wrong previous bytes') : priorApi(path),
      extract: path => path.endsWith('previous-recovery-artifact.zip') ? persistedOriginal : files, loadDiagnostic: async () => diagnostic }), /digest mismatch/);
    const badApi = path => path.endsWith('/zip') ? Buffer.from('tampered') : api(path);
    await assert.rejects(prepareRecoveryFiles(env, { api: badApi, extract: () => { throw new Error('Digest must fail before extraction'); }, loadDiagnostic: async () => diagnostic }), /digest mismatch/);
    const legacyWrongHash = operation(legacy); legacyWrongHash.operation.input_sha256 = 'f'.repeat(64);
    await assert.rejects(prepareRecoveryFiles(env, { api, extract: () => ({ ...files, 'service-cleanup-operation.json': encode(legacyWrongHash) }), loadDiagnostic: async () => diagnostic }), /binding/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('recovery workflow binds cleanup execution to validated diagnostic outputs', async () => {
  const workflow = await readFile(new URL('../.github/workflows/account-recovery.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(workflow, /node scripts\/execution-guard\.mjs --source-only/);
  assert.doesNotMatch(workflow, /vars\.E2E_CLEANUP_SERVICE_(?:SHA|SOURCE_SHA|IMAGE_DIGEST)/);
  for (const [name, output] of [
    ['E2E_CLEANUP_SERVICE_SHA', 'diagnostic_service_source_sha'],
    ['E2E_CLEANUP_SERVICE_SOURCE_SHA', 'diagnostic_service_source_sha'],
    ['E2E_CLEANUP_SERVICE_IMAGE_DIGEST', 'diagnostic_service_image_digest'],
    ['BETA_CLEANUP_STATE_MACHINE_VERSION_ARN', 'diagnostic_state_machine_version_arn'],
  ]) assert.ok(workflow.includes(name + ': ${{ steps.recovery-scope.outputs.' + output + ' }}'));
  const scopeOutput = workflow.indexOf('id: recovery-scope');
  const cleanupStep = workflow.indexOf('name: Recover exact worker data and identities');
  assert.ok(scopeOutput >= 0 && cleanupStep > scopeOutput);
  assert.ok(workflow.indexOf('node scripts/execution-guard.mjs', cleanupStep) > cleanupStep);
});

test('diagnostic preparation requires the dedicated Infra reader and never falls back to ambient GH_TOKEN', async () => {
  const environment = { ...base, GH_TOKEN: 'ambient-workflow-token', INFRA_EVIDENCE_READ_TOKEN: '' };
  await assert.rejects(prepareRecoveryFiles(environment, { api: () => { throw new Error('must refuse before API access'); } }), /INFRA_EVIDENCE_READ_TOKEN/);
});

test('diagnostic preparation routes the dedicated Infra reader explicitly', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'account-recovery-token-scope-'));
  const archive = Buffer.from('authenticated archive bytes');
  const artifact = { id: 55, name: 'beta-account-lifecycle-123-1', digest: `sha256:${byteHash(archive)}`, expired: false,
    created_at: '2026-10-08T00:10:00Z', expires_at: '2099-01-01T00:00:00Z', workflow_run: { id: run.id, head_sha: run.head_sha } };
  const files = { 'account-budget.json': encode(manifest), 'service-cleanup-operation.json': encode(operation(legacy)) };
  let diagnosticEnvironment;
  const api = path => {
    if (path.endsWith('/attempts/1')) return JSON.stringify(run);
    if (path.includes('/artifacts?')) return JSON.stringify({ total_count: 1, artifacts: [artifact] });
    if (path.endsWith('/zip')) return archive;
    throw new Error('Unexpected API read');
  };
  try {
    await prepareRecoveryFiles({ ...base, GH_TOKEN: 'ambient-workflow-token', E2E_EVIDENCE_READ_TOKEN: 'e2e-reader', SERVICE_ARTIFACT_READ_TOKEN: 'service-reader',
      E2E_ACCOUNT_BUDGET_PATH: join(directory, 'account-budget.json'), GITHUB_OUTPUT: join(directory, 'outputs') }, {
      api, extract: () => files, loadDiagnostic: async ({ environment }) => { diagnosticEnvironment = environment; return diagnostic; },
    });
    assert.equal(diagnosticEnvironment.GH_TOKEN, 'infra-reader');
    assert.equal(diagnosticEnvironment.INFRA_EVIDENCE_READ_TOKEN, 'infra-reader');
    assert.equal(diagnosticEnvironment.E2E_EVIDENCE_READ_TOKEN, 'e2e-reader');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('formal cleanup caller reaches recovery mode and never shrinks request after partial Cognito reconciliation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'account-recovery-caller-'));
  const original = join(directory, 'original.json');
  await writeFile(original, JSON.stringify(operation(legacy)));
  const env = { ...base, E2E_CLEANUP_ORIGINAL_EVIDENCE_PATH: original };
  const calls = [];
  const io = { getUser: async username => { calls.push('get'); return { Username: manifest.accounts.find(account => account.email === username).subject, UserAttributes: [{ Name: 'sub', Value: manifest.accounts.find(account => account.email === username).subject }, { Name: 'email', Value: username }] }; },
    deleteUser: async () => { calls.push('delete'); } };
  const partial = structuredClone(manifest); partial.accounts[0].status = 'deleted';
  let proved = false;
  let bound;
  try {
    const count = await runCapturedWorkerCleanup(partial, env, io, {
      normal: () => { throw new Error('Wrong caller mode'); },
      recovery: async (inputs, operationEnvironment) => { assert.equal(inputs.cleanup_json, request); bound = operationEnvironment; calls.push('service-proof'); proved = true; return { operation: { proof_status: 'verified' } }; },
    }, async () => ({ service: { source_sha: 'a'.repeat(40), image_digest: `sha256:${'b'.repeat(64)}` }, capability: { state_machine_version_arn: 'arn:aws:states:ap-east-1:650880818323:stateMachine:beta-anywear-tester-cleanup:3' } }));
    assert.equal(count, 2); assert.equal(proved, true); assert.equal(calls[0], 'service-proof');
    assert.equal(bound.E2E_CLEANUP_SERVICE_SOURCE_SHA, 'a'.repeat(40));
    assert.equal(bound.E2E_CLEANUP_SERVICE_IMAGE_DIGEST, `sha256:${'b'.repeat(64)}`);
    assert.equal(bound.BETA_CLEANUP_STATE_MACHINE_VERSION_ARN.endsWith(':3'), true);
    assert.equal(calls.filter(call => call === 'delete').length, 2);
    calls.length = 0;
    await assert.rejects(runCapturedWorkerCleanup(partial, env, io, { recovery: async () => { throw new Error('Marker proof unavailable'); } }, async () => ({ service: { source_sha: 'a'.repeat(40), image_digest: `sha256:${'b'.repeat(64)}` }, capability: { state_machine_version_arn: 'arn:aws:states:ap-east-1:650880818323:stateMachine:beta-anywear-tester-cleanup:3' } })), /Marker/);
    assert.equal(calls.length, 0);
    await assert.rejects(runCapturedWorkerCleanup(partial, env, io, { recovery: async () => ({ operation: { proof_status: 'pending' } }) }, async () => ({ service: { source_sha: 'a'.repeat(40), image_digest: `sha256:${'b'.repeat(64)}` }, capability: { state_machine_version_arn: 'arn:aws:states:ap-east-1:650880818323:stateMachine:beta-anywear-tester-cleanup:3' } })), /committed result/);
    assert.equal(calls.length, 0);
    const unknown = structuredClone(partial); unknown.accounts[0].subject = 'foreign';
    await assert.rejects(runCapturedWorkerCleanup(unknown, env, io, { recovery: () => { throw new Error('Must reject before Service'); } }, async () => ({ service: { source_sha: 'a'.repeat(40), image_digest: `sha256:${'b'.repeat(64)}` }, capability: { state_machine_version_arn: 'arn:aws:states:ap-east-1:650880818323:stateMachine:beta-anywear-tester-cleanup:3' } })), /captured worker/);
    assert.equal(calls.length, 0);
    await assert.rejects(runCapturedWorkerCleanup(partial, { ...env, E2E_BETA_CLEANUP_DIAGNOSTIC_PATH: 'missing.json' }, io, { recovery: async () => { throw new Error('must not start'); } }), /ENOENT|diagnostic/);
    assert.equal(calls.length, 0);
    const mismatched = join(directory, 'mismatched-diagnostic.json');
    await writeFile(mismatched, '{}');
    await assert.rejects(runCapturedWorkerCleanup(partial, { ...env, E2E_BETA_CLEANUP_DIAGNOSTIC_PATH: mismatched, E2E_BETA_CLEANUP_DIAGNOSTIC_SHA256: '0'.repeat(64) }, io, { recovery: async () => { throw new Error('must not start'); } }), /binding/);
    assert.equal(calls.length, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
