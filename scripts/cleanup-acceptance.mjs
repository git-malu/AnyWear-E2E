import { AdminCreateUserCommand, AdminDeleteUserCommand, AdminGetUserCommand, CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { accountRunScope, markAccountCleanupPending, markAccountDeleted, quarantineAccount, recordAccountSubject, reserveAccount } from '../tests/support/account-budget.ts';
import { createCleanupOperationEnvelope, cleanupExecutionArn, deterministicCleanupExecutionName, observeFailedCleanupOperation,
  observeSubmittedCleanupOperation, prepareCleanupRetryIntent, runCleanupOperation, submitCleanupRetryIntent } from '../tests/support/service-cleanup-operation.ts';
import { assertEqual, byteHash, parseStrictJson, repositories } from './evidence-contract.mjs';
import { assertE2EExecution } from './execution-guard.mjs';
import { ACCEPTANCE_WORKFLOW, BUDGET, EMAILS, acceptanceRequests, assertAcceptanceOperation, assertBootstrap, assertBudget, assertBudgetLeaseChain, assertFixturePending,
  assertFixtureRecord, assertIntent, assertOrigin, assertPhaseState, assertPreserved, assertReleased, assertRetryIntent, parsePhaseInputs } from './cleanup-acceptance-contract.mjs';
import { loadAcceptanceOrigin, localFileHash } from './cleanup-acceptance-origin.mjs';

const directory = 'cleanup-acceptance';
const statePath = join(directory, 'acceptance-state.json');
const budgetPath = join(directory, 'account-budget.json');
const operationPath = join(directory, 'service-cleanup-operation.json');
const phaseFiles = ['acceptance-state.json', 'account-budget.json'];
const operationFiles = ['service-cleanup-operation.json', 'service-cleanup-repeat.json', 'retry-intent.json', 'sentinel-cleanup-operation.json'];
let capturedBudget;
const producer = () => ({ repository: repositories.e2e, workflow_path: ACCEPTANCE_WORKFLOW, source_sha: process.env.GITHUB_SHA,
  run_id: Number(process.env.GITHUB_RUN_ID), run_attempt: Number(process.env.GITHUB_RUN_ATTEMPT) });
const artifactName = (kind, origin) => `beta-cleanup-acceptance-${kind}-${origin.run_id}-${origin.run_attempt}`;
const cloudInputs = json => ({ action: 'cleanup', emails: '[]', cleanup_json: json });
const now = () => new Date().toISOString();

async function save(file, value) {
  await mkdir(directory, { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}
const read = async file => parseStrictJson(await readFile(file));
async function checkpoint(state, name) { state.checkpoint = name; await save(statePath, state); }

function configure(bootstrap) {
  Object.assign(process.env, { E2E_ACCOUNT_RUN_SCOPE: bootstrap.run_scope, E2E_ACCOUNT_BUDGET_PATH: budgetPath,
    E2E_WORKERS: '2', E2E_WORKER_SLOT_OFFSET: '2', E2E_MAX_ACTIVE_ACCOUNTS: '2', E2E_MAX_NEW_ACCOUNTS_PER_RUN: '2', E2E_MAX_QUARANTINED_ACCOUNTS: '2',
    E2E_SERVICE_CLEANUP_EVIDENCE_PATH: operationPath, E2E_CLEANUP_SERVICE_SOURCE_SHA: bootstrap.frozen_tuple.service_source_sha,
    E2E_CLEANUP_SERVICE_IMAGE_DIGEST: bootstrap.frozen_tuple.service_image_digest,
    BETA_CLEANUP_STATE_MACHINE_VERSION_ARN: bootstrap.frozen_tuple.state_machine_version_arn });
}

export function assertAcceptanceExecution(environment = process.env, options = {}) {
  assertE2EExecution(environment, options);
  if (environment.GITHUB_WORKFLOW_REF !== `${repositories.e2e}/${ACCEPTANCE_WORKFLOW}@refs/heads/main`
    || environment.E2E_WORKERS !== '2' || environment.E2E_WORKER_SLOT_OFFSET !== '2'
    || ['E2E_MAX_ACTIVE_ACCOUNTS', 'E2E_MAX_NEW_ACCOUNTS_PER_RUN', 'E2E_MAX_QUARANTINED_ACCOUNTS'].some(key => environment[key] !== '2')) throw new Error('Cleanup acceptance requires its exact protected workflow and fixed slot budget');
}

export function cognitoCreationInput(email, userPoolId) {
  if (!EMAILS.includes(email) || !userPoolId) throw new Error('Only allocated cleanup acceptance identities may be created');
  return { UserPoolId: userPoolId, Username: email, MessageAction: 'SUPPRESS', UserAttributes: [
    { Name: 'email', Value: email }, { Name: 'email_verified', Value: 'true' }, { Name: 'custom:e2e_bootstrap', Value: 'true' },
  ] };
}

export function capturedIdentity(user, expected) {
  const attributes = user.UserAttributes;
  if (!Array.isArray(attributes) || new Set(attributes.map(row => row.Name)).size !== attributes.length) throw new Error('Cognito attributes are incomplete or duplicated');
  const values = Object.fromEntries(attributes.map(row => [row.Name, row.Value]));
  if (values.email !== expected.email || values['custom:e2e_bootstrap'] !== 'true' || values.email_verified !== 'true'
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(values.sub)
    || !user.Username || user.Username.includes('@') || user.UserStatus !== 'FORCE_CHANGE_PASSWORD') throw new Error('Unconfirmed bootstrap identity capture mismatch');
  return { ...expected, sub: values.sub, username: user.Username };
}

export async function requireFreshIdentity(email, io) {
  try { await io.get(email); }
  catch (error) { if (error?.name === 'UserNotFoundException') return; throw error; }
  throw new Error('Acceptance bootstrap refuses a preexisting stable identity');
}

function cognitoIo() {
  const userPoolId = process.env.USER_POOL_ID;
  if (!userPoolId) throw new Error('Missing protected Beta user pool');
  const client = new CognitoIdentityProviderClient({ region: 'ap-east-1', maxAttempts: 1 });
  return { get: username => client.send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: username })),
    create: email => { assertAcceptanceExecution(); return client.send(new AdminCreateUserCommand(cognitoCreationInput(email, userPoolId))); },
    delete: username => { assertAcceptanceExecution(); return client.send(new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: username })); },
    destroy: () => client.destroy() };
}

export async function createCapturedIdentities(intent, io, callbacks) {
  const captured = [];
  for (const identity of intent.identities) {
    await requireFreshIdentity(identity.email, io);
    const started = now();
    await callbacks.before(identity, started);
    await io.create(identity.email);
    const result = capturedIdentity(await io.get(identity.email), { slot: identity.slot, email: identity.email,
      lease_generation: identity.lease_generation, create_started_at: started, captured_at: now() });
    captured.push(result);
    await callbacks.captured(result);
  }
  return captured;
}

async function uploadedOrigin(kind, file) {
  const origin = { ...producer(), artifact_id: Number(process.env.ACCEPTANCE_UPLOAD_ID),
    artifact_sha256: process.env.ACCEPTANCE_UPLOAD_DIGEST, manifest_sha256: await localFileHash(file) };
  assertOrigin(origin);
  const required = kind === 'intent' ? ['creation-intent.json', 'account-budget.json'] : ['retry-intent.json', 'account-budget.json'];
  const loaded = await loadAcceptanceOrigin(origin, { name: artifactName(kind, origin), file: required[0], required, inProgress: true });
  assertEqual(loaded.record, await read(file), 'Immutable intent upload/read-back');
  return { origin, loaded };
}

async function importBootstrap(origin) {
  const loaded = await loadAcceptanceOrigin(origin, { name: artifactName('bootstrap', origin), file: 'bootstrap-manifest.json',
    required: ['bootstrap-manifest.json', 'account-budget.json', 'creation-intent.json'] });
  const bootstrap = loaded.record;
  const intent = await loadAcceptanceOrigin(bootstrap.intent_origin, { name: artifactName('intent', bootstrap.intent_origin), file: 'creation-intent.json',
    required: ['creation-intent.json', 'account-budget.json'] });
  if (byteHash(loaded.files['creation-intent.json']) !== bootstrap.intent_origin.manifest_sha256) throw new Error('Bootstrap changed the immutable creation intent bytes');
  assertBootstrap(bootstrap, origin, intent.record, intent.artifact.created_at, loaded.artifact.created_at);
  const intentBudget = assertBudget(parseStrictJson(intent.files['account-budget.json']), intent.record, { intent: true });
  capturedBudget = assertBudget(parseStrictJson(loaded.files['account-budget.json']), bootstrap);
  assertBudgetLeaseChain(intentBudget, capturedBudget);
  if (bootstrap.producer.source_sha !== process.env.GITHUB_SHA) throw new Error('Acceptance source changed since bootstrap');
  configure(bootstrap);
  await writeFile(budgetPath, loaded.files['account-budget.json'], { mode: 0o600 });
  return bootstrap;
}

async function importPhase(origin, phase, bootstrap, bootstrapOrigin, options) {
  const loaded = await loadAcceptanceOrigin(origin, { name: artifactName(phase, origin), file: 'acceptance-state.json', required: phaseFiles, optional: operationFiles });
  assertPhaseState(loaded.record, origin, bootstrap, bootstrapOrigin, phase, options);
  const importedBudget = assertBudget(parseStrictJson(loaded.files['account-budget.json']), bootstrap);
  assertBudgetLeaseChain(capturedBudget, importedBudget);
  return loaded;
}

async function importFixtures(inputs, bootstrap) {
  const results = [], runs = [];
  for (const { action, origin } of inputs.fixtures) {
    const loaded = await loadAcceptanceOrigin(origin, { name: `beta-cleanup-acceptance-${origin.run_id}-${origin.run_attempt}`,
      file: 'cleanup-acceptance-operation.json' });
    results.push(assertFixtureRecord(loaded.record, origin, bootstrap, inputs.bootstrapOrigin, action));
    runs.push(loaded.run);
  }
  return { results, runs };
}

export function assertFixtureAfter(fixtureRun, priorRun) {
  const started = Date.parse(fixtureRun.run_started_at), completed = Date.parse(priorRun.updated_at);
  if (!Number.isFinite(started) || !Number.isFinite(completed) || started <= completed) throw new Error('Manager fixture action is not after the preceding completed operation');
}

export function assertOperationBinding(evidence, json, bootstrap, { pending = false, retry = false } = {}) {
  const env = { E2E_CLEANUP_SERVICE_SOURCE_SHA: bootstrap.frozen_tuple.service_source_sha, E2E_CLEANUP_SERVICE_IMAGE_DIGEST: bootstrap.frozen_tuple.service_image_digest };
  const input = createCleanupOperationEnvelope(cloudInputs(json), env);
  const base = deterministicCleanupExecutionName(input);
  const name = retry ? `${base.slice(0, 72)}-retry1` : base;
  if (evidence?.schema_version !== 3 || evidence.record_type !== 'anywear_e2e_service_cleanup_operation'
    || evidence.operation.state_machine_version_arn !== bootstrap.frozen_tuple.state_machine_version_arn
    || evidence.operation.execution_name !== name || evidence.operation.execution_arn !== cleanupExecutionArn(bootstrap.frozen_tuple.state_machine_version_arn, name)
    || evidence.operation.input_sha256 !== byteHash(JSON.stringify(input))) throw new Error('Cleanup evidence binds a different operation');
  assertEqual(evidence.operation.input, input, 'Original exact cleanup envelope');
  if (!pending && (evidence.operation.status !== 'SUCCEEDED' || evidence.operation.proof_status !== 'verified'
    || !evidence.operation.committed_result || evidence.operation.tasks?.length !== 2)) throw new Error('Complete application cleanup proof required');
  return evidence;
}

export function assertSameCompletedOperation(first, second) {
  assertEqual(Object.fromEntries(['execution_arn', 'execution_name', 'started_at', 'stopped_at', 'input_sha256', 'output', 'tasks', 'committed_result'].map(key => [key, first.operation[key]])),
    Object.fromEntries(['execution_arn', 'execution_name', 'started_at', 'stopped_at', 'input_sha256', 'output', 'tasks', 'committed_result'].map(key => [key, second.operation[key]])), 'Recovery/replay did not launch a new execution/task');
}

export function assertTeardownApplicationProof(primary, sentinel, bootstrap) {
  assertAcceptanceOperation(primary, bootstrap, 'primary', 'verified', true);
  assertAcceptanceOperation(sentinel, bootstrap, 'sentinel', 'verified');
}

export async function deleteAcceptanceIdentities(identities, io, beforeDelete, afterDelete) {
  for (const identity of identities) {
    if (typeof identity.username !== 'string' || !identity.username || identity.username.includes('@')
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(identity.sub)
      || !EMAILS.includes(identity.email)) throw new Error('Exact captured immutable Cognito identity required for deletion');
    let user;
    try { user = await io.get(identity.username); }
    catch (error) { if (error?.name !== 'UserNotFoundException') throw error; }
    if (user) {
      const actual = capturedIdentity(user, identity);
      if (actual.sub !== identity.sub || actual.username !== identity.username) throw new Error('Captured username/subject changed; deletion refused');
      await beforeDelete(identity);
      await io.delete(identity.username);
    }
    try { await io.get(identity.username); throw new Error('Captured immutable identity remains after deletion'); }
    catch (error) { if (error?.name !== 'UserNotFoundException') throw error; }
    await afterDelete(identity);
  }
}

async function prepare() {
  assertAcceptanceExecution();
  const inputs = parsePhaseInputs(process.env);
  await mkdir(directory, { recursive: true });
  const state = { schema_version: 1, record_type: 'anywear_e2e_cleanup_acceptance_phase', issue: 86, phase: inputs.phase,
    producer: producer(), bootstrap_origin: inputs.bootstrapOrigin, previous_origin: inputs.previousOrigin,
    fixture_origins: inputs.fixtures, result: 'in-progress', operations: {}, cognito: [], checkpoint: 'initialized' };
  await save(statePath, state);
  if (inputs.phase === 'bootstrap') {
    const runScope = `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}-${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    configure({ run_scope: runScope, frozen_tuple: inputs.tuple });
    const io = cognitoIo();
    try { for (const email of EMAILS) await requireFreshIdentity(email, io); } finally { io.destroy(); }
    const identities = [];
    for (let index = 0; index < 2; index += 1) {
      const lease = randomUUID();
      await reserveAccount(EMAILS[index], 'worker', lease);
      identities.push({ slot: index + 2, email: EMAILS[index], lease_generation: lease, preflight_absent: true });
    }
    const intent = { schema_version: 1, record_type: 'anywear_e2e_cleanup_acceptance_creation_intent', issue: 86, producer: producer(),
      run_scope: accountRunScope(), account_budget_config: BUDGET, identities, created_at: now(), frozen_tuple: inputs.tuple };
    assertIntent(intent, { ...producer() });
    assertBudget(await read(budgetPath), intent, { intent: true });
    await save(join(directory, 'creation-intent.json'), intent);
    await checkpoint(state, 'immutable-precreate-intent-required');
    return;
  }
  const bootstrap = await importBootstrap(inputs.bootstrapOrigin);
  const { results: fixtures, runs: fixtureRuns } = await importFixtures(inputs, bootstrap);
  if (inputs.phase === 'refusals') {
    const key = inputs.previousOrigin ? 'mismatch' : 'active';
    if (key === 'active') {
      assertFixtureAfter(fixtureRuns[1], fixtureRuns[0]);
      assertFixturePending(fixtures[0].after); assertPreserved(fixtures[0].after, fixtures[1].after);
      state.operations = { refusal_stage: 'active', fixture_baseline: fixtures[1].after,
        inspections: { before_active: { origin: inputs.fixtures[1].origin, snapshot: fixtures[1].after } } };
    } else {
      const previous = await importPhase(inputs.previousOrigin, 'refusals', bootstrap, inputs.bootstrapOrigin, { refusalStage: 'active' });
      assertFixtureAfter(fixtureRuns[0], previous.run);
      assertPreserved(previous.record.operations.fixture_baseline, fixtures[0].after);
      state.operations = { ...previous.record.operations, refusal_stage: 'combined', inspections: { ...previous.record.operations.inspections,
        after_active: { origin: inputs.fixtures[0].origin, snapshot: fixtures[0].after } } };
    }
    const request = bootstrap.cleanup_requests[key === 'active' ? 'primary' : 'mismatch'];
    await checkpoint(state, `before-${key}-cleanup`);
    process.env.E2E_CLEANUP_RETRY_FAILED = 'false';
    let refused = false;
    try { await runCleanupOperation(cloudInputs(request.json)); } catch { refused = true; }
    if (!refused) throw new Error('Expected exact cleanup refusal did not occur');
    const evidence = await read(operationPath);
    assertOperationBinding(evidence, request.json, bootstrap, { pending: true });
    const proof = await observeFailedCleanupOperation(cloudInputs(request.json));
    state.operations[key] = { producer: producer(), evidence, failure_proof: proof };
    state.result = key === 'active' ? 'active-refusal-observed-identities-retained' : 'exact-refusals-observed-identities-retained';
  } else if (inputs.phase === 'qualification') {
    const previousRun = await importPhase(inputs.previousOrigin, 'refusals', bootstrap, inputs.bootstrapOrigin);
    const previous = previousRun.record;
    const activeRun = await importPhase(previous.previous_origin, 'refusals', bootstrap, inputs.bootstrapOrigin, { refusalStage: 'active' });
    assertEqual(previous.operations.active, activeRun.record.operations.active, 'Ordered immutable active refusal proof');
    assertEqual(previous.operations.inspections.before_active, activeRun.record.operations.inspections.before_active, 'Original manager fixture baseline');
    assertFixtureAfter(fixtureRuns[0], previousRun.run);
    assertFixtureAfter(fixtureRuns[1], fixtureRuns[0]);
    assertPreserved(previous.operations.fixture_baseline, fixtures[0].after);
    assertPreserved(fixtures[0].after, fixtures[1].before); assertReleased(fixtures[1].before, fixtures[1].after);
    assertOperationBinding(previous.operations.active.evidence, bootstrap.cleanup_requests.primary.json, bootstrap, { pending: true });
    const evidence = await prepareCleanupRetryIntent(cloudInputs(bootstrap.cleanup_requests.primary.json), previous.operations.active.evidence);
    state.operations = { fixture_baseline: previous.operations.fixture_baseline, fixture_released: fixtures[1].after,
      retry_intent_origin: null, retry_intent: evidence, submission: null };
    const intent = { schema_version: 1, record_type: 'anywear_e2e_cleanup_acceptance_retry_intent', issue: 86, producer: producer(),
      bootstrap_origin: inputs.bootstrapOrigin, previous_origin: inputs.previousOrigin, fixture_origins: inputs.fixtures, operation: evidence };
    await save(join(directory, 'retry-intent.json'), intent);
    await save(operationPath, evidence);
    await checkpoint(state, 'immutable-prestart-retry-intent-required');
    return;
  } else if (inputs.phase === 'recovery') {
    const previous = await importPhase(inputs.previousOrigin, 'qualification', bootstrap, inputs.bootstrapOrigin);
    const planned = previous.record.operations;
    assertOrigin(planned.retry_intent_origin);
    const intent = await loadAcceptanceOrigin(planned.retry_intent_origin, { name: artifactName('retry-intent', planned.retry_intent_origin),
      file: 'retry-intent.json', required: ['retry-intent.json', 'account-budget.json'] });
    assertRetryIntent(intent.record, planned.retry_intent_origin, bootstrap, inputs.bootstrapOrigin, previous.record.previous_origin, previous.record.fixture_origins);
    assertEqual(intent.record.operation, planned.retry_intent, 'Recovery immutable retry intent');
    assertEqual(intent.record.bootstrap_origin, inputs.bootstrapOrigin, 'Recovery retry origin');
    assertBudget(parseStrictJson(intent.files['account-budget.json']), bootstrap);
    if (!previous.files['retry-intent.json'] || byteHash(previous.files['retry-intent.json']) !== planned.retry_intent_origin.manifest_sha256
      || Date.parse(intent.artifact.created_at) > Date.parse(planned.submission.started_at)) throw new Error('Original immutable retry intent was not persisted before submit');
    if (!previous.files['service-cleanup-operation.json']) throw new Error('Qualification pending operation artifact missing');
    const pending = parseStrictJson(previous.files['service-cleanup-operation.json']);
    assertOperationBinding(pending, bootstrap.cleanup_requests.primary.json, bootstrap, { pending: true, retry: true });
    if (pending.operation.status !== 'RUNNING' || pending.operation.proof_status !== 'pending'
      || planned.submission?.execution_arn !== pending.operation.execution_arn || planned.submission.started_at !== pending.operation.started_at) throw new Error('Deliberate interruption lacks authenticated original submission');
    const initial = await observeSubmittedCleanupOperation(pending);
    await writeFile(join(directory, 'original-operation.json'), previous.files['service-cleanup-operation.json'], { mode: 0o600 });
    Object.assign(process.env, { E2E_CLEANUP_ORIGINAL_EVIDENCE_PATH: join(directory, 'original-operation.json'), E2E_CLEANUP_RETRY_FAILED: 'true' });
    await checkpoint(state, 'before-original-operation-recovery');
    const recovered = await runCleanupOperation(cloudInputs(bootstrap.cleanup_requests.primary.json));
    assertOperationBinding(recovered, bootstrap.cleanup_requests.primary.json, bootstrap, { retry: true });
    assertAcceptanceOperation(recovered, bootstrap, 'primary', 'verified', true);
    if (recovered.operation.execution_arn !== planned.submission.execution_arn || recovered.operation.started_at !== planned.submission.started_at) throw new Error('Recovery launched or observed a different execution');
    if (initial.task_arns.some(arn => !recovered.operation.tasks.some(task => task.task_arn === arn))) throw new Error('Recovery replaced an originally observed task');
    await save(join(directory, 'recovered-operation.json'), recovered);
    process.env.E2E_CLEANUP_ORIGINAL_EVIDENCE_PATH = join(directory, 'recovered-operation.json');
    process.env.E2E_SERVICE_CLEANUP_EVIDENCE_PATH = join(directory, 'service-cleanup-repeat.json');
    await checkpoint(state, 'before-same-completed-operation-replay');
    const replayed = await runCleanupOperation(cloudInputs(bootstrap.cleanup_requests.primary.json));
    assertOperationBinding(replayed, bootstrap.cleanup_requests.primary.json, bootstrap, { retry: true });
    assertSameCompletedOperation(recovered, replayed);
    state.operations = { ...planned, recovery_initial: initial, recovered, replayed };
    state.result = 'same-operation-recovered-and-replayed-identities-retained';
  } else {
    const previousRun = await importPhase(inputs.previousOrigin, 'recovery', bootstrap, inputs.bootstrapOrigin);
    const previous = previousRun.record;
    assertFixtureAfter(fixtureRuns[0], previousRun.run);
    assertOperationBinding(previous.operations.recovered, bootstrap.cleanup_requests.primary.json, bootstrap, { retry: true });
    assertSameCompletedOperation(previous.operations.recovered, previous.operations.replayed);
    const snapshot = fixtures[0].after;
    if (!snapshot[0].absent || snapshot[1].absent) throw new Error('Post-recovery manager inspection requires absent primary and retained sentinel');
    assertPreserved(previous.operations.fixture_released[1], snapshot[1]);
    process.env.E2E_CLEANUP_RETRY_FAILED = 'false';
    process.env.E2E_SERVICE_CLEANUP_EVIDENCE_PATH = join(directory, 'sentinel-cleanup-operation.json');
    await checkpoint(state, 'before-real-sentinel-cleanup');
    const sentinel = await runCleanupOperation(cloudInputs(bootstrap.cleanup_requests.sentinel.json));
    assertOperationBinding(sentinel, bootstrap.cleanup_requests.sentinel.json, bootstrap);
    assertTeardownApplicationProof(previous.operations.recovered, sentinel, bootstrap);
    state.operations = { primary: previous.operations.recovered, sentinel, final_snapshot_required: true };
    const io = cognitoIo();
    try {
      await deleteAcceptanceIdentities(bootstrap.identities, io, async identity => checkpoint(state, `before-captured-slot-${identity.slot}-delete`), async identity => {
        await markAccountDeleted(identity.email);
        state.cognito.push({ slot: identity.slot, email: identity.email, sub: identity.sub, username: identity.username, status: 'deleted-absence-observed' });
        await checkpoint(state, `captured-slot-${identity.slot}-absence-observed`);
      });
    } finally { io.destroy(); }
    assertBudget(await read(budgetPath), bootstrap, { deleted: true });
    state.result = 'application-cleanup-and-captured-identities-deleted';
  }
  await checkpoint(state, 'complete');
}

async function afterIntentUpload(command) {
  assertAcceptanceExecution();
  const inputs = parsePhaseInputs(process.env);
  const state = await read(statePath);
  if (command === 'bootstrap-create') {
    if (inputs.phase !== 'bootstrap' || state.checkpoint !== 'immutable-precreate-intent-required') throw new Error('Bootstrap intent checkpoint missing');
    const { origin, loaded } = await uploadedOrigin('intent', join(directory, 'creation-intent.json'));
    const intent = assertIntent(loaded.record, origin);
    assertBudget(parseStrictJson(loaded.files['account-budget.json']), intent, { intent: true });
    configure(intent);
    const io = cognitoIo();
    try {
      const identities = await createCapturedIdentities(intent, io, {
        before: async (identity, started) => { state.cognito.push({ slot: identity.slot, status: 'creation-attempted', create_started_at: started }); await checkpoint(state, `before-slot-${identity.slot}-create`); },
        captured: async identity => { await recordAccountSubject(identity.email, identity.sub); await markAccountCleanupPending(identity.email); state.cognito.push(identity); await checkpoint(state, `slot-${identity.slot}-captured`); },
      });
      const bootstrap = { schema_version: 1, record_type: 'anywear_e2e_cleanup_acceptance_bootstrap', issue: 86, phase: 'bootstrap',
        result: 'captured-identities-retained', producer: producer(), run_scope: intent.run_scope, account_budget_config: BUDGET,
        intent_origin: origin, identities, ...acceptanceRequests(intent.run_scope, identities), frozen_tuple: intent.frozen_tuple };
      assertBootstrap(bootstrap, origin, intent, loaded.artifact.created_at);
      assertBudget(await read(budgetPath), bootstrap);
      assertBudgetLeaseChain(parseStrictJson(loaded.files['account-budget.json']), await read(budgetPath));
      await save(join(directory, 'bootstrap-manifest.json'), bootstrap);
      await checkpoint(state, 'complete');
    } catch (error) {
      for (const identity of intent.identities) await quarantineAccount(identity.email, 'Bootstrap incomplete; exact manager recovery required');
      state.result = 'incomplete-identities-retained'; await checkpoint(state, 'failed'); throw error;
    } finally { io.destroy(); }
  } else {
    if (inputs.phase !== 'qualification' || state.checkpoint !== 'immutable-prestart-retry-intent-required') throw new Error('Retry intent checkpoint missing');
    const { origin, loaded } = await uploadedOrigin('retry-intent', join(directory, 'retry-intent.json'));
    assertEqual(loaded.record.operation, state.operations.retry_intent, 'Uploaded exact retry intent');
    const bootstrap = await importBootstrap(inputs.bootstrapOrigin);
    assertRetryIntent(loaded.record, origin, bootstrap, inputs.bootstrapOrigin, inputs.previousOrigin, inputs.fixtures);
    assertBudget(parseStrictJson(loaded.files['account-budget.json']), bootstrap);
    assertOperationBinding(state.operations.retry_intent, bootstrap.cleanup_requests.primary.json, bootstrap, { pending: true, retry: true });
    const liveFailure = await observeFailedCleanupOperation(cloudInputs(bootstrap.cleanup_requests.primary.json));
    assertEqual(liveFailure.tasks, state.operations.retry_intent.operation.preceding_execution.task_proofs, 'Exact live task cessation before retry submit');
    state.operations.retry_intent_origin = origin;
    await checkpoint(state, 'before-authenticated-retry-submit');
    const submission = await submitCleanupRetryIntent(state.operations.retry_intent);
    const pending = structuredClone(state.operations.retry_intent);
    Object.assign(pending.operation, { status: 'RUNNING', started_at: submission.started_at });
    await save(operationPath, pending);
    state.operations.submission = submission;
    state.result = 'submitted-tracking-deliberately-interrupted-identities-retained';
    await checkpoint(state, 'complete');
  }
}

export async function main(command) {
  if (!['prepare', 'bootstrap-create', 'qualification-start'].includes(command)) throw new Error('Unknown acceptance command');
  if (command === 'prepare') await prepare(); else await afterIntentUpload(command);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `phase=${process.env.ACCEPTANCE_PHASE}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await main(process.argv[2]); console.log('Protected cleanup acceptance source phase completed; durable evidence retained.'); }
  catch { console.error('Cleanup acceptance phase failed; preserve exact artifacts and captured identities for manager recovery.'); process.exitCode = 1; }
}
