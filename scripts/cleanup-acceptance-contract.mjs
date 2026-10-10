import { assertEqual, byteHash, exactKeys, parseStrictJson, repositories, requireCommit,
  requireHash, requireId, requireImageDigest } from './evidence-contract.mjs';

export const ACCEPTANCE_WORKFLOW = '.github/workflows/beta-cleanup-acceptance.yml';
export const PHASES = ['bootstrap', 'refusals', 'qualification', 'recovery', 'teardown'];
export const BUDGET = Object.freeze({ maxActiveAccounts: 2, maxNewAccountsPerRun: 2, maxQuarantinedAccounts: 2 });
export const EMAILS = [2, 3].map(slot => `e2e-beta-worker-${slot}-chromium@anywear.local`);
const scopePattern = /^[1-9][0-9]{0,19}-[1-9][0-9]{0,5}-[a-f0-9]{16}$/;
const subjectPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const versionPattern = /^arn:aws:states:ap-east-1:650880818323:stateMachine:beta-anywear-tester-cleanup:[1-9][0-9]*$/;
const definitionPattern = /^arn:aws:ecs:ap-east-1:650880818323:task-definition\/beta-anywear-cleanup-acceptance:[1-9][0-9]*$/;

export function assertOrigin(origin, repository = repositories.e2e) {
  exactKeys(origin, ['repository', 'workflow_path', 'source_sha', 'run_id', 'run_attempt', 'artifact_id', 'artifact_sha256', 'manifest_sha256'], 'Origin');
  if (![repositories.e2e, repositories.infra].includes(repository) || origin.repository !== repository || origin.workflow_path !== ACCEPTANCE_WORKFLOW) throw new Error('Unexpected acceptance origin repository/workflow');
  requireCommit(origin.source_sha, 'Origin source');
  for (const key of ['run_id', 'run_attempt', 'artifact_id']) requireId(origin[key], key);
  for (const key of ['artifact_sha256', 'manifest_sha256']) requireHash(origin[key], key);
  return origin;
}

export function assertProducer(producer, origin) {
  exactKeys(producer, ['repository', 'workflow_path', 'source_sha', 'run_id', 'run_attempt'], 'Producer');
  assertEqual(producer, Object.fromEntries(['repository', 'workflow_path', 'source_sha', 'run_id', 'run_attempt'].map(key => [key, origin[key]])), 'Producer/origin');
}

export function assertFrozenTuple(tuple) {
  exactKeys(tuple, ['service_source_sha', 'service_image_digest', 'state_machine_version_arn', 'fixture_source_sha',
    'fixture_task_definition_arn', 'selection_sha256', 'stack_sources_sha256'], 'Frozen tuple');
  requireCommit(tuple.service_source_sha, 'Service source'); requireCommit(tuple.fixture_source_sha, 'Fixture source');
  requireImageDigest(tuple.service_image_digest);
  requireHash(tuple.selection_sha256, 'Selection'); requireHash(tuple.stack_sources_sha256, 'Stack sources');
  if (!versionPattern.test(tuple.state_machine_version_arn) || !definitionPattern.test(tuple.fixture_task_definition_arn)) throw new Error('Unexpected fixed Beta capability');
  return tuple;
}

function assertScope(scope) { if (!scopePattern.test(scope)) throw new Error('Invalid acceptance run scope'); }
function assertTimestamp(value) { if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('Invalid acceptance timestamp'); }
function assertSlots(identities, captured) {
  if (!Array.isArray(identities) || identities.length !== 2) throw new Error('Acceptance requires exactly slots 2 and 3');
  identities.forEach((identity, index) => {
    exactKeys(identity, captured ? ['slot', 'email', 'sub', 'username', 'lease_generation', 'create_started_at', 'captured_at']
      : ['slot', 'email', 'lease_generation', 'preflight_absent'], 'Captured slot');
    if (identity.slot !== index + 2 || identity.email !== EMAILS[index] || !subjectPattern.test(identity.lease_generation)) throw new Error('Acceptance identity/lease is outside slots 2 and 3');
    if (captured) {
      if (!subjectPattern.test(identity.sub) || typeof identity.username !== 'string' || !identity.username || identity.username.includes('@')) throw new Error('Captured immutable Cognito identity required');
      assertTimestamp(identity.create_started_at); assertTimestamp(identity.captured_at);
      if (Date.parse(identity.captured_at) < Date.parse(identity.create_started_at)) throw new Error('Capture predates creation');
    } else if (identity.preflight_absent !== true) throw new Error('Creation intent requires fresh absent identities');
  });
  if (new Set(identities.map(identity => identity.lease_generation)).size !== 2) throw new Error('Acceptance lease generations are duplicated');
  if (captured && (identities[0].sub === identities[1].sub || identities[0].username === identities[1].username)) throw new Error('Captured identities are not unique');
}

export function acceptanceRequests(runScope, identities) {
  const fixtureRequest = JSON.stringify({ run_scope: runScope, users: identities.map(({ slot, sub, email }) => ({ slot, user_id: sub, email })) });
  const request = users => { const json = JSON.stringify({ runScope, users }); return { json, sha256: byteHash(json) }; };
  return { fixture_request: fixtureRequest, fixture_request_sha256: byteHash(fixtureRequest), cleanup_requests: {
    primary: request([{ sub: identities[0].sub, email: identities[0].email }]),
    mismatch: request([{ sub: identities[0].sub, email: identities[1].email }]),
    sentinel: request([{ sub: identities[1].sub, email: identities[1].email }]),
  } };
}

export function assertIntent(intent, origin) {
  exactKeys(intent, ['schema_version', 'record_type', 'issue', 'producer', 'run_scope', 'account_budget_config', 'identities', 'created_at', 'frozen_tuple'], 'Creation intent');
  if (intent.schema_version !== 1 || intent.record_type !== 'anywear_e2e_cleanup_acceptance_creation_intent' || intent.issue !== 86) throw new Error('Unknown creation intent');
  assertProducer(intent.producer, origin); assertScope(intent.run_scope);
  if (!intent.run_scope.startsWith(`${origin.run_id}-${origin.run_attempt}-`)) throw new Error('Creation intent scope/producer mismatch');
  assertEqual(intent.account_budget_config, BUDGET, 'Fixed budget'); assertSlots(intent.identities, false);
  assertTimestamp(intent.created_at); assertFrozenTuple(intent.frozen_tuple);
  return intent;
}

export function assertBudget(manifest, bootstrap, { deleted = false, intent = false } = {}) {
  exactKeys(manifest, ['version', 'runScope', 'config', 'accounts'], 'Account budget');
  if (manifest.version !== 1 || manifest.runScope !== bootstrap.run_scope) throw new Error('Account budget origin changed');
  assertEqual(manifest.config, BUDGET, 'Budget configuration');
  if (!Array.isArray(manifest.accounts) || manifest.accounts.length !== 2) throw new Error('Acceptance account pool changed');
  manifest.accounts.forEach((account, index) => {
    exactKeys(account, ['email', 'mode', 'status', 'leaseId', 'leaseGeneration', 'createdAt', 'updatedAt', ...(!intent ? ['subject'] : [])], 'Account lease');
    const identity = bootstrap.identities[index];
    assertTimestamp(account.createdAt); assertTimestamp(account.updatedAt);
    if (account.email !== identity.email || account.mode !== 'worker' || account.leaseGeneration !== identity.lease_generation
      || !subjectPattern.test(account.leaseId) || (!intent && account.subject !== identity.sub)
      || (intent && account.subject !== undefined)
      || account.status !== (intent ? 'provisioning' : deleted ? 'deleted' : 'cleanup_pending')) throw new Error('Account budget lease/capture/status changed');
  });
  if (new Set(manifest.accounts.map(account => account.leaseId)).size !== 2) throw new Error('Acceptance lease IDs are duplicated');
  return manifest;
}

export function assertBudgetLeaseChain(first, second) {
  const fields = ['email', 'mode', 'leaseId', 'leaseGeneration', 'createdAt'];
  assertEqual(first.accounts.map(account => Object.fromEntries(fields.map(key => [key, account[key]]))),
    second.accounts.map(account => Object.fromEntries(fields.map(key => [key, account[key]]))), 'Immutable account reservation chain');
  if (second.accounts.some((account, index) => Date.parse(account.updatedAt) < Date.parse(first.accounts[index].updatedAt))) throw new Error('Account lease timestamp moved backwards');
}

export function assertBootstrap(manifest, origin, intent, intentArtifactCreatedAt, bootstrapArtifactCreatedAt) {
  exactKeys(manifest, ['schema_version', 'record_type', 'issue', 'phase', 'result', 'producer', 'run_scope', 'account_budget_config',
    'intent_origin', 'identities', 'fixture_request', 'fixture_request_sha256', 'cleanup_requests', 'frozen_tuple'], 'Bootstrap');
  if (manifest.schema_version !== 1 || manifest.record_type !== 'anywear_e2e_cleanup_acceptance_bootstrap'
    || manifest.issue !== 86 || manifest.phase !== 'bootstrap' || manifest.result !== 'captured-identities-retained') throw new Error('Bootstrap did not complete capture');
  assertProducer(manifest.producer, origin); assertScope(manifest.run_scope); assertSlots(manifest.identities, true);
  assertOrigin(manifest.intent_origin); assertIntent(intent, manifest.intent_origin);
  assertEqual(manifest.account_budget_config, BUDGET, 'Fixed budget'); assertFrozenTuple(manifest.frozen_tuple);
  for (const key of ['producer', 'run_scope', 'account_budget_config', 'frozen_tuple']) assertEqual(manifest[key], intent[key], `Intent ${key}`);
  assertEqual(manifest.identities.map(({ slot, email, lease_generation }) => ({ slot, email, lease_generation, preflight_absent: true })), intent.identities, 'Creation lease chain');
  assertTimestamp(intentArtifactCreatedAt);
  if (Date.parse(intentArtifactCreatedAt) < Date.parse(intent.created_at)
    || manifest.identities.some(identity => Date.parse(identity.create_started_at) < Date.parse(intentArtifactCreatedAt))) throw new Error('Immutable creation intent was not uploaded before creation');
  if (bootstrapArtifactCreatedAt !== undefined) {
    assertTimestamp(bootstrapArtifactCreatedAt);
    if (manifest.identities.some(identity => Date.parse(identity.captured_at) > Date.parse(bootstrapArtifactCreatedAt))) throw new Error('Bootstrap artifact predates captured identities');
  }
  assertEqual(Object.fromEntries(['fixture_request', 'fixture_request_sha256', 'cleanup_requests'].map(key => [key, manifest[key]])), acceptanceRequests(manifest.run_scope, manifest.identities), 'Captured exact request strings');
  return manifest;
}

export function assertPhaseState(state, origin, bootstrap, bootstrapOrigin, expectedPhase, { refusalStage = 'combined' } = {}) {
  exactKeys(state, ['schema_version', 'record_type', 'issue', 'phase', 'producer', 'bootstrap_origin', 'previous_origin',
    'fixture_origins', 'result', 'operations', 'cognito', 'checkpoint'], 'Phase state');
  if (state.schema_version !== 1 || state.record_type !== 'anywear_e2e_cleanup_acceptance_phase' || state.issue !== 86
    || state.phase !== expectedPhase || !PHASES.includes(state.phase)) throw new Error('Unexpected preceding phase');
  assertProducer(state.producer, origin); assertEqual(state.bootstrap_origin, bootstrapOrigin, 'Bootstrap origin');
  if (origin.source_sha !== bootstrap.producer.source_sha) throw new Error('Acceptance source changed across phases');
  if (!Array.isArray(state.fixture_origins) || !state.operations || !Array.isArray(state.cognito)) throw new Error('Incomplete phase state');
  const results = { refusals: refusalStage === 'active' ? 'active-refusal-observed-identities-retained' : 'exact-refusals-observed-identities-retained', qualification: 'submitted-tracking-deliberately-interrupted-identities-retained',
    recovery: 'same-operation-recovered-and-replayed-identities-retained', teardown: 'application-cleanup-and-captured-identities-deleted' };
  if (state.result !== results[expectedPhase] || state.checkpoint !== 'complete') throw new Error('Preceding phase is incomplete');
  const operationKeys = { refusals: ['refusal_stage', 'fixture_baseline', 'inspections', 'active', ...(refusalStage === 'combined' ? ['mismatch'] : [])], qualification: ['fixture_baseline', 'fixture_released', 'retry_intent_origin', 'retry_intent', 'submission'],
    recovery: ['fixture_baseline', 'fixture_released', 'retry_intent_origin', 'retry_intent', 'submission', 'recovery_initial', 'recovered', 'replayed'],
    teardown: ['primary', 'sentinel', 'final_snapshot_required'] };
  exactKeys(state.operations, operationKeys[expectedPhase], 'Phase operations');
  if (expectedPhase !== 'teardown' && state.cognito.length !== 0) throw new Error('Identity deletion is forbidden before teardown');
  if (expectedPhase !== 'refusals' || refusalStage === 'combined') assertOrigin(state.previous_origin);
  else if (state.previous_origin !== null) throw new Error('Active refusal cannot select older phase authority');
  if (state.previous_origin && (state.previous_origin.source_sha !== bootstrap.producer.source_sha
    || (state.previous_origin.run_id === origin.run_id && state.previous_origin.run_attempt === origin.run_attempt))) throw new Error('Previous phase source/run was substituted');
  state.fixture_origins.forEach(entry => { exactKeys(entry, ['action', 'origin'], 'Fixture phase origin'); assertOrigin(entry.origin, repositories.infra); });
  const fixtureActions = { refusals: refusalStage === 'active' ? ['prepare', 'inspect'] : ['inspect'], qualification: ['inspect', 'release-task'], recovery: [], teardown: ['inspect'] };
  assertEqual(state.fixture_origins.map(entry => entry.action), fixtureActions[expectedPhase], 'Phase manager fixture actions');
  const operations = state.operations;
  if (expectedPhase === 'refusals') {
    if (operations.refusal_stage !== refusalStage) throw new Error('Refusal stage was skipped or duplicated');
    assertFixturePending(operations.fixture_baseline);
    assertFixtureSnapshot(operations.fixture_baseline, bootstrap);
    exactKeys(operations.inspections, refusalStage === 'active' ? ['before_active'] : ['before_active', 'after_active'], 'Ordered refusal inspections');
    for (const inspection of Object.values(operations.inspections)) {
      exactKeys(inspection, ['origin', 'snapshot'], 'Refusal inspection'); assertOrigin(inspection.origin, repositories.infra);
      assertPreserved(operations.fixture_baseline, inspection.snapshot);
    }
    if (refusalStage === 'active') assertEqual(operations.inspections.before_active.origin, state.fixture_origins[1].origin, 'Original manager fixture inspection');
    if (refusalStage === 'combined') {
      assertEqual(operations.inspections.after_active.origin, state.fixture_origins[0].origin, 'Fresh post-active manager inspection');
      if (operations.inspections.before_active.origin.artifact_id === operations.inspections.after_active.origin.artifact_id) throw new Error('Post-active inspection was duplicated');
    }
    for (const key of refusalStage === 'active' ? ['active'] : ['active', 'mismatch']) {
      exactKeys(operations[key], ['producer', 'evidence', 'failure_proof'], 'Refusal operation');
      assertProducer(operations[key].producer, key === 'active' && refusalStage === 'combined' ? state.previous_origin : origin);
      const input = assertAcceptanceOperation(operations[key].evidence, bootstrap, key === 'active' ? 'primary' : 'mismatch', 'refused');
      const proof = operations[key].failure_proof;
      exactKeys(proof, ['schema_version', 'record_type', 'execution_arn', 'started_at', 'stopped_at', 'status', 'input_sha256', 'tasks', 'committed_marker_observed', 'log_snapshot_sha256'], 'Refusal proof');
      if (proof.schema_version !== 1 || proof.record_type !== 'anywear_e2e_cleanup_refusal_proof' || proof.status !== 'FAILED'
        || proof.execution_arn !== operations[key].evidence.operation.execution_arn || proof.input_sha256 !== byteHash(JSON.stringify(input))
        || proof.committed_marker_observed !== false) throw new Error('Incomplete exact refusal proof');
      assertTimestamp(proof.started_at); assertTimestamp(proof.stopped_at); requireHash(proof.log_snapshot_sha256, 'Refusal log snapshot');
      assertTaskProofs(proof.tasks, bootstrap, input, false);
    }
  } else if (expectedPhase === 'qualification' || expectedPhase === 'recovery') {
    assertFixtureSnapshot(operations.fixture_baseline, bootstrap); assertFixtureSnapshot(operations.fixture_released, bootstrap);
    assertReleased(operations.fixture_baseline, operations.fixture_released);
    assertOrigin(operations.retry_intent_origin);
    if (expectedPhase === 'qualification' && (operations.retry_intent_origin.run_id !== origin.run_id || operations.retry_intent_origin.run_attempt !== origin.run_attempt
      || operations.retry_intent_origin.source_sha !== origin.source_sha)) throw new Error('Qualification imported an older retry intent');
    assertAcceptanceOperation(operations.retry_intent, bootstrap, 'primary', 'intent', true);
    exactKeys(operations.submission, ['execution_arn', 'started_at', 'submitted_at'], 'Authenticated submission');
    if (operations.submission.execution_arn !== operations.retry_intent.operation.execution_arn) throw new Error('Submission changed the original intent');
    assertTimestamp(operations.submission.started_at); assertTimestamp(operations.submission.submitted_at);
    if (Date.parse(operations.submission.started_at) > Date.parse(operations.submission.submitted_at)) throw new Error('Submission timestamp predates execution');
    if (expectedPhase === 'recovery') {
      exactKeys(operations.recovery_initial, ['execution_arn', 'started_at', 'status', 'task_arns'], 'Initial recovery observation');
      if (operations.recovery_initial.execution_arn !== operations.submission.execution_arn || operations.recovery_initial.started_at !== operations.submission.started_at
        || !['RUNNING', 'SUCCEEDED'].includes(operations.recovery_initial.status) || !Array.isArray(operations.recovery_initial.task_arns)) throw new Error('Recovery original observation changed');
      assertAcceptanceOperation(operations.recovered, bootstrap, 'primary', 'verified', true);
      assertAcceptanceOperation(operations.replayed, bootstrap, 'primary', 'verified', true);
      if (operations.recovered.operation.execution_arn !== operations.submission.execution_arn || operations.recovered.operation.started_at !== operations.submission.started_at
        || operations.recovery_initial.task_arns.some(arn => !operations.recovered.operation.tasks.some(task => task.task_arn === arn))) throw new Error('Recovery replaced an original execution/task');
      assertEqual(operations.recovered.operation, operations.replayed.operation, 'Same completed operation replay');
    }
  } else {
    assertAcceptanceOperation(operations.primary, bootstrap, 'primary', 'verified', true);
    assertAcceptanceOperation(operations.sentinel, bootstrap, 'sentinel', 'verified');
    if (operations.final_snapshot_required !== true || state.cognito.length !== 2) throw new Error('Teardown reconciliation is incomplete');
    state.cognito.forEach((row, index) => {
      exactKeys(row, ['slot', 'email', 'sub', 'username', 'status'], 'Captured deletion outcome');
      const identity = bootstrap.identities[index];
      assertEqual(row, { slot: identity.slot, email: identity.email, sub: identity.sub, username: identity.username, status: 'deleted-absence-observed' }, 'Exact captured deletion');
    });
  }
  return state;
}

export function assertAcceptanceOperation(evidence, bootstrap, request, result, retry = false) {
  exactKeys(evidence, ['schema_version', 'record_type', 'operation'], 'Cleanup evidence');
  const operation = evidence.operation, tuple = bootstrap.frozen_tuple, captured = bootstrap.cleanup_requests[request];
  exactKeys(operation, ['state_machine_version_arn', 'execution_arn', 'execution_name', 'status', 'proof_status', 'input_sha256', 'input'], 'Cleanup operation',
    ['started_at', 'stopped_at', 'output', 'tasks', 'committed_result', 'preceding_execution', 'failure']);
  const input = { schema_version: 1, operation_id: `beta-tester-cleanup:${bootstrap.run_scope}`, run_scope: bootstrap.run_scope,
    request_sha256: captured.sha256, service_commit_sha: tuple.service_source_sha, service_image_digest: tuple.service_image_digest, cleanup_request: captured.json };
  const base = `beta-cleanup-${bootstrap.run_scope}-${captured.sha256.slice(0, 16)}`;
  const name = retry ? `${base.slice(0, 72)}-retry1` : base;
  const arn = `arn:aws:states:ap-east-1:650880818323:execution:beta-anywear-tester-cleanup:${name}`;
  if (evidence.schema_version !== 3 || evidence.record_type !== 'anywear_e2e_service_cleanup_operation'
    || operation.state_machine_version_arn !== tuple.state_machine_version_arn || operation.execution_name !== name
    || operation.execution_arn !== arn || operation.input_sha256 !== byteHash(JSON.stringify(input))) throw new Error('Foreign cleanup operation evidence');
  assertEqual(operation.input, input, 'Captured cleanup envelope');
  const status = { intent: 'PENDING', refused: 'FAILED', verified: 'SUCCEEDED' };
  const proof = { intent: 'pending', refused: 'refused', verified: 'verified' };
  if (operation.status !== status[result] || operation.proof_status !== proof[result]) throw new Error('Cleanup proof status mismatch');
  if (result === 'intent') {
    exactKeys(operation.preceding_execution, ['execution_arn', 'status', 'stopped_tasks', 'task_proofs'], 'Prior cessation');
    if (operation.preceding_execution.execution_arn !== `arn:aws:states:ap-east-1:650880818323:execution:beta-anywear-tester-cleanup:${base}`
      || operation.preceding_execution.status !== 'FAILED') throw new Error('Intent prior execution changed');
    assertTaskProofs(operation.preceding_execution.task_proofs, bootstrap, input, false);
    assertEqual(operation.preceding_execution.stopped_tasks, operation.preceding_execution.task_proofs.map(task => task.task_arn), 'Stopped task identity inventory');
  }
  if (result === 'verified') {
    assertTimestamp(operation.started_at); assertTimestamp(operation.stopped_at);
    assertTaskProofs(operation.tasks, bootstrap, input, true);
    const marker = operation.committed_result;
    if (marker?.schema_version !== 1 || marker.record_type !== 'anywear_beta_cleanup_result' || marker.source !== 'beta-tester-cleanup' || marker.cleanup !== 'beta-testers'
      || marker.transaction_committed !== true || marker.operation_id !== input.operation_id || marker.request_sha256 !== input.request_sha256
      || marker.run_scope !== input.run_scope || marker.service_commit_sha !== input.service_commit_sha || marker.service_image_digest !== input.service_image_digest
      || marker.envelope_sha256 !== operation.input_sha256 || marker.users !== 1 || marker.items !== 1 || marker.tasks !== (request === 'primary' ? 1 : 0)
      || marker.missingUsers !== 0) throw new Error('Application cleanup marker does not prove the exact fixture deletion');
    for (const key of ['outbox', 'idempotency', 'generations', 'relations', 'outfits', 'photos']) if (marker[key] !== 0) throw new Error('Application cleanup touched unexpected fixture resources');
  }
  return input;
}

function assertTaskProofs(tasks, bootstrap, input, success) {
  if (!Array.isArray(tasks) || tasks.length !== 2 || new Set(tasks.map(task => task.task_arn)).size !== 2) throw new Error('Exact two task proofs required');
  for (const task of tasks) {
    const kind = task.kind;
    exactKeys(task, ['task_arn', 'task_definition_arn', 'kind', 'status', 'exit_code', 'image_digest', 'service_commit_sha', 'log_group', 'log_stream', ...(kind === 'cleanup' ? ['envelope_sha256'] : [])], 'Actual task proof');
    const prefix = kind === 'verification' ? 'beta-anywear-cleanup-verify' : 'beta-anywear-cleanup';
    const match = /^arn:aws:ecs:ap-east-1:650880818323:task\/beta-anywear\/([a-f0-9]{32})$/.exec(task.task_arn);
    if (!match || !['verification', 'cleanup'].includes(kind) || task.status !== 'STOPPED'
      || !new RegExp(`^arn:aws:ecs:ap-east-1:650880818323:task-definition/${prefix}:[1-9][0-9]*$`).test(task.task_definition_arn)
      || task.image_digest !== bootstrap.frozen_tuple.service_image_digest || task.service_commit_sha !== bootstrap.frozen_tuple.service_source_sha
      || !Number.isInteger(task.exit_code) || ((success || kind === 'verification') ? task.exit_code !== 0 : task.exit_code === 0)
      || task.log_group !== '/anywear/beta/one-shot' || task.log_stream !== `${prefix}/OneShot/${match[1]}`
      || (kind === 'cleanup' && task.envelope_sha256 !== byteHash(JSON.stringify(input)))) throw new Error('Actual task proof changed');
  }
  if (new Set(tasks.map(task => task.kind)).size !== 2) throw new Error('Task purposes are duplicated');
}

export function assertFixtureRecord(record, origin, bootstrap, bootstrapOrigin, action) {
  exactKeys(record, ['schema_version', 'record_type', 'result', 'executor', 'fixture_source_sha', 'task_definition_arn', 'action',
    'run_scope', 'request_sha256', 'selection', 'stack_sources', 'reviewed_stack_sources', 'bootstrap', 'original', 'launch_attempted',
    'launch_input_sha256', 'launch_response', 'task_arn', 'task_observation', 'service_result', 'final'], 'Fixture operation');
  const tuple = bootstrap.frozen_tuple;
  if (record.schema_version !== 1 || record.record_type !== 'anywear_beta_cleanup_acceptance_operation'
    || record.result !== 'committed-result-and-preserved-state-verified' || record.action !== action
    || record.run_scope !== bootstrap.run_scope || record.request_sha256 !== bootstrap.fixture_request_sha256
    || record.fixture_source_sha !== tuple.fixture_source_sha || record.task_definition_arn !== tuple.fixture_task_definition_arn
    || record.launch_attempted !== true) throw new Error('Fixture operation does not bind this bootstrap/action');
  exactKeys(record.executor, ['repository', 'source_sha', 'workflow_ref', 'run_id', 'run_attempt'], 'Fixture executor');
  if (record.executor.repository !== origin.repository || record.executor.source_sha !== origin.source_sha
    || record.executor.workflow_ref !== `${origin.repository}/${origin.workflow_path}@refs/heads/main`
    || record.executor.run_id !== String(origin.run_id) || record.executor.run_attempt !== String(origin.run_attempt)) throw new Error('Fixture executor/origin mismatch');
  assertEqual(record.bootstrap.origin, bootstrapOrigin, 'Fixture bootstrap origin');
  assertEqual(record.bootstrap.manifest, bootstrap, 'Fixture captured bootstrap');
  exactKeys(record.selection, ['file', 'sha256', 'service_sha', 'image_digest'], 'Fixture selection');
  exactKeys(record.stack_sources, ['file', 'sha256'], 'Fixture stack sources');
  if (!/^selections\/[a-z0-9][a-z0-9._-]{0,127}\.json$/.test(record.selection.file)
    || !/^stack-sources\/[a-z0-9][a-z0-9._-]{0,127}\.json$/.test(record.stack_sources.file)
    || record.selection.sha256 !== tuple.selection_sha256 || record.selection.service_sha !== tuple.service_source_sha
    || record.selection.image_digest !== tuple.service_image_digest || record.stack_sources.sha256 !== tuple.stack_sources_sha256) throw new Error('Fixture selected tuple changed');
  const names = ['AnyWearPlatformStack-beta', 'AnyWearWorkloadStack-beta', 'AnyWearFoundationStack', 'AnyWearBillingStack-beta'];
  const sources = record.reviewed_stack_sources;
  if (!Array.isArray(sources) || sources.length !== 4 || new Set(sources.map(row => row?.stack_name)).size !== 4) throw new Error('Four distinct fixture stack producers required');
  for (const row of sources) {
    exactKeys(row, ['stack_name', 'region', 'source_repository', 'source_sha'], 'Fixture stack producer');
    requireCommit(row.source_sha, 'Fixture stack source');
    if (!names.includes(row.stack_name) || row.region !== (row.stack_name.includes('Billing') ? 'us-east-1' : 'ap-east-1')
      || ![repositories.infra, repositories.service].includes(row.source_repository)) throw new Error('Unexpected fixture stack producer');
  }
  const workload = sources.find(row => row.stack_name === 'AnyWearWorkloadStack-beta');
  if (workload.source_repository !== repositories.infra || workload.source_sha !== tuple.fixture_source_sha) throw new Error('Fixture Workload producer changed');
  assertEqual(record.original, record.final, 'Fixture preserves environment');
  if (record.final.admission?.admission_suspended !== true || record.final.admission?.intake_open !== false) throw new Error('Fixture admission is not closed/suspended');
  if (record.final.definition?.taskDefinitionArn !== tuple.fixture_task_definition_arn) throw new Error('Fixture observed definition mismatch');
  requireHash(record.launch_input_sha256, 'Fixture launch input');
  if (!/^arn:aws:ecs:ap-east-1:650880818323:task\/beta-anywear\/[a-f0-9]{32}$/.test(record.task_arn)) throw new Error('Fixture task identity unavailable');
  exactKeys(record.launch_response, ['task_arns', 'task_count', 'failure_count', 'unidentified_task_count', 'identities_truncated'], 'Fixture launch response');
  assertEqual(record.launch_response, { task_arns: [record.task_arn], task_count: 1, failure_count: 0,
    unidentified_task_count: 0, identities_truncated: false }, 'Unique actual fixture launch');
  const observed = record.task_observation;
  exactKeys(observed, ['task_arn', 'cluster_arn', 'task_definition_arn', 'status', 'container', 'overrides'], 'Actual fixture task');
  assertEqual(observed, { task_arn: record.task_arn, cluster_arn: 'arn:aws:ecs:ap-east-1:650880818323:cluster/beta-anywear',
    task_definition_arn: tuple.fixture_task_definition_arn, status: 'STOPPED',
    container: { name: 'OneShot', status: 'STOPPED', exit_code: 0, image_digest: tuple.service_image_digest },
    overrides: { containerOverrides: [{ name: 'OneShot', command: ['node', 'dist/ops/beta-cleanup-acceptance-fixture.js', action, bootstrap.fixture_request] }] },
  }, 'Actual stopped fixture command/image proof');
  const result = record.service_result;
  if (result.schema_version !== 1 || result.record_type !== 'anywear_beta_cleanup_acceptance_result' || result.action !== action
    || result.run_scope !== bootstrap.run_scope || result.request_sha256 !== bootstrap.fixture_request_sha256
    || result.service_commit_sha !== tuple.service_source_sha || result.service_image_digest !== tuple.service_image_digest
    || result.transaction_committed !== true || result.queue_calls !== 0 || result.provider_calls !== 0 || result.lifecycle_changes !== 0) throw new Error('Fixture committed marker mismatch');
  for (const rows of [result.before, result.after]) assertFixtureSnapshot(rows, bootstrap);
  return result;
}

export function assertFixtureSnapshot(rows, bootstrap) {
  if (!Array.isArray(rows) || rows.length !== 2) throw new Error('Fixture snapshot is incomplete');
  rows.forEach((row, index) => {
    exactKeys(row, ['role', 'slot', 'user_id', 'email', 'absent', 'user', 'item', 'task', 'outbox'], 'Fixture snapshot');
    if (row.slot !== index + 2 || row.role !== (index === 0 ? 'primary' : 'sentinel') || row.user_id !== bootstrap.identities[index].sub
      || row.email !== EMAILS[index] || typeof row.absent !== 'boolean' || row.outbox !== 0) throw new Error('Fixture snapshot identity mismatch');
    if (row.absent) {
      if (row.user !== null || row.item !== null || row.task !== null) throw new Error('Absent fixture still exposes resource rows');
      return;
    }
    exactKeys(row.user, ['snapshot_sha256', 'daily_credits'], 'Fixture user'); requireHash(row.user.snapshot_sha256, 'User snapshot');
    exactKeys(row.item, ['id', 'status', 'snapshot_sha256'], 'Fixture item'); requireHash(row.item.snapshot_sha256, 'Item snapshot');
    if (row.user.daily_credits !== 0 || !subjectPattern.test(row.item.id) || row.item.status !== (index === 0 ? 'processing' : 'ready')) throw new Error('Fixture user/item changed');
    if (index === 1) { if (row.task !== null) throw new Error('Sentinel acquired a task'); return; }
    exactKeys(row.task, ['id', 'status', 'snapshot_sha256', 'available_at', 'execution_token', 'attempt_count', 'unclaimed'], 'Fixture task');
    requireHash(row.task.snapshot_sha256, 'Task snapshot');
    if (!subjectPattern.test(row.task.id) || !['pending', 'failed'].includes(row.task.status) || row.task.available_at !== '2100-01-01T00:00:00.000Z'
      || row.task.execution_token !== 0 || row.task.attempt_count !== 0 || row.task.unclaimed !== true) throw new Error('Fixture task changed or was claimed');
  });
}

export function assertRetryIntent(record, origin, bootstrap, bootstrapOrigin, previousOrigin, fixtureOrigins) {
  exactKeys(record, ['schema_version', 'record_type', 'issue', 'producer', 'bootstrap_origin', 'previous_origin', 'fixture_origins', 'operation'], 'Retry intent');
  if (record.schema_version !== 1 || record.record_type !== 'anywear_e2e_cleanup_acceptance_retry_intent' || record.issue !== 86) throw new Error('Unknown retry intent');
  assertProducer(record.producer, origin); assertEqual(record.bootstrap_origin, bootstrapOrigin, 'Retry bootstrap origin');
  assertEqual(record.previous_origin, previousOrigin, 'Retry preceding refusal origin'); assertEqual(record.fixture_origins, fixtureOrigins, 'Retry manager fixture origins');
  assertAcceptanceOperation(record.operation, bootstrap, 'primary', 'intent', true);
  return record;
}

export function assertPreserved(before, after) { assertEqual(before, after, 'Exact fixture snapshot preservation'); }
export function assertFixturePending(rows) {
  if (rows.some(row => row.absent) || rows[0].task?.status !== 'pending' || rows[0].task.unclaimed !== true
    || rows[0].task.attempt_count !== 0 || rows[0].task.execution_token !== 0 || rows[1].task !== null) throw new Error('Fixture is not inert and pending');
}
export function assertReleased(before, after) {
  assertFixturePending(before);
  assertPreserved(before[1], after[1]);
  assertPreserved(before[0].user, after[0].user); assertPreserved(before[0].item, after[0].item);
  if (after[0].absent || after[0].task?.status !== 'failed' || after[0].task.unclaimed !== true
    || after[0].task.id !== before[0].task.id || after[0].task.attempt_count !== 0 || after[0].task.execution_token !== 0) throw new Error('Fixture task was not released exactly');
}

export function parsePhaseInputs(environment) {
  const phase = environment.ACCEPTANCE_PHASE;
  if (!PHASES.includes(phase)) throw new Error('Unknown acceptance phase');
  const bootstrapOrigin = parseStrictJson(environment.ACCEPTANCE_BOOTSTRAP_ORIGIN ?? 'null');
  const previousOrigin = parseStrictJson(environment.ACCEPTANCE_PREVIOUS_ORIGIN ?? 'null');
  const fixtures = parseStrictJson(environment.ACCEPTANCE_FIXTURE_ORIGINS ?? '[]');
  const tuple = parseStrictJson(environment.ACCEPTANCE_FROZEN_TUPLE ?? 'null');
  if (!Array.isArray(fixtures) || fixtures.length > 3) throw new Error('Unbounded fixture origins');
  fixtures.forEach(entry => { exactKeys(entry, ['action', 'origin'], 'Fixture input'); if (!['prepare', 'inspect', 'release-task'].includes(entry.action)) throw new Error('Unexpected fixture action'); assertOrigin(entry.origin, repositories.infra); });
  if (phase === 'bootstrap') {
    if (bootstrapOrigin || previousOrigin || fixtures.length) throw new Error('Bootstrap cannot import older authority');
    assertFrozenTuple(tuple);
  } else {
    assertOrigin(bootstrapOrigin);
    if (tuple !== null) throw new Error('Later phases must preserve the bootstrap tuple');
    if (phase !== 'refusals' && !previousOrigin) throw new Error('Incorrect previous phase input');
    if (previousOrigin) assertOrigin(previousOrigin);
    const actions = { refusals: previousOrigin ? ['inspect'] : ['prepare', 'inspect'], qualification: ['inspect', 'release-task'], recovery: [], teardown: ['inspect'] };
    assertEqual(fixtures.map(entry => entry.action), actions[phase], 'Required manager fixture sequence');
  }
  return { phase, bootstrapOrigin, previousOrigin, fixtures, tuple };
}
