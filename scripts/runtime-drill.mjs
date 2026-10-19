import { execFile } from 'node:child_process';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { collectDeploymentEvidence } from './qualification-record.mjs';
import { readFencingCiEvidence, verifyFencingCiEvidence } from './runtime-fencing-evidence.mjs';
import { assertStableAudits, TERMINAL_STABILITY_MS, validateTaskAudit } from './runtime-task-audit.mjs';
import { parseRuntimeRecovery } from './runtime-recovery.mjs';
import { assertLiveRuntimeSourceReady } from './runtime-source-readiness.mjs';
import { validateOneShotProof } from './runtime-one-shot.mjs';
import { validateCleanupEvidence } from './runtime-one-shot-logs.mjs';
import { isDeepStrictEqual } from 'node:util';
import { ADMISSION_MODE_PARAMETER, parseAdmissionMode } from './beta-admission-mode.mjs';
import { testerHash } from './runtime-window-controls.mjs';

const exec = promisify(execFile);
export const TARGET_ACCOUNT = '650880818323';
export const TARGET_REGION = 'ap-east-1';
export const RUNTIME_DRILL_CONCURRENCY = 'anywear-beta-runtime';
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const DRILL_ID_PATTERN = /^beta-runtime-[a-z0-9-]+$/;
const FIXTURE_MANIFEST_PATTERN = /^provider-failure-[a-z0-9-]+\.json$/;
const APPROVED_PROVIDER_FIXTURE_SOURCE = /^beta-provider-nonpaid-loopback$/;
const RUN_SCOPE_PATTERN = /^[1-9][0-9]{0,19}-[1-9][0-9]{0,5}-[a-f0-9]{16}$/;
const REQUIRED_DRILLS = [
  'accepted-task-restart',
  'multi-replica-sse',
  'retry-visibility-dlq',
];

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is required`);
  return value;
}

function requireHttps(value, label) {
  const url = new URL(requireString(value, label));
  if (url.protocol !== 'https:') throw new Error(`${label} must use HTTPS`);
  return url.toString().replace(/\/$/, '');
}

function requireBoolean(value, label) {
  if (value !== true) throw new Error(`${label} must be true`);
}

function requireInteger(value, label, { minimum = 0 } = {}) {
  if (!Number.isInteger(value) || value < minimum) throw new Error(`${label} must be an integer >= ${minimum}`);
  return value;
}

function requireUniqueStrings(values, label, { minimum = 1 } = {}) {
  if (!Array.isArray(values) || values.length < minimum || values.some((value) => typeof value !== 'string' || value.length === 0)) {
    throw new Error(`${label} must contain at least ${minimum} non-empty string(s)`);
  }
  if (new Set(values).size !== values.length) throw new Error(`${label} must contain unique values`);
  return values;
}

export function assertRuntimeDrillEnvironment(environment = process.env) {
  if (environment.E2E_STAGE !== 'beta') throw new Error('Runtime drills are restricted to E2E_STAGE=beta');
  if (environment.AWS_ACCOUNT_ID !== TARGET_ACCOUNT) {
    throw new Error(`Runtime drills require AWS_ACCOUNT_ID=${TARGET_ACCOUNT}`);
  }
  if (environment.AWS_REGION !== TARGET_REGION) {
    throw new Error(`Runtime drills require AWS_REGION=${TARGET_REGION}`);
  }
  return {
    stage: 'beta',
    awsAccountId: TARGET_ACCOUNT,
    awsRegion: TARGET_REGION,
    clientUrl: requireHttps(environment.E2E_CLIENT_URL, 'E2E_CLIENT_URL'),
    serviceUrl: requireHttps(environment.E2E_SERVICE_URL, 'E2E_SERVICE_URL'),
  };
}

export function assertRuntimeDrillMutationConfirmation(environment = process.env) {
  if (environment.RUNTIME_DRILL_CONFIRM !== 'beta-runtime-drill') {
    throw new Error('Runtime mutations require RUNTIME_DRILL_CONFIRM=beta-runtime-drill');
  }
}

export function assertRuntimeDrillExecutionEnvironment(environment = process.env, compatibility) {
  const config = assertRuntimeDrillEnvironment(environment);
  if (environment.GITHUB_REF !== 'refs/heads/main') {
    throw new Error('Runtime mutations require the main branch');
  }
  if (environment.GITHUB_EVENT_NAME !== 'workflow_dispatch') {
    throw new Error('Runtime mutations require a workflow_dispatch event');
  }
  if (environment.RUNTIME_DRILL_CONCURRENCY !== RUNTIME_DRILL_CONCURRENCY) {
    throw new Error(`Runtime mutations require concurrency=${RUNTIME_DRILL_CONCURRENCY}`);
  }
  if (!COMMIT_PATTERN.test(environment.GITHUB_SHA ?? '')) {
    throw new Error('Runtime mutations require the full current E2E commit SHA');
  }
  if (environment.RUNTIME_DRILL_E2E_SHA !== environment.GITHUB_SHA) {
    throw new Error('Runtime mutations require RUNTIME_DRILL_E2E_SHA to match the current workflow revision');
  }
  if (environment.RUNTIME_DRILL_CLIENT_SHA !== compatibility?.client?.sha
    || environment.RUNTIME_DRILL_SERVICE_SHA !== compatibility?.service?.sha) {
    throw new Error('Runtime mutations require Client and Service pins to match compatibility.json');
  }
  if (!RUN_SCOPE_PATTERN.test(environment.RUNTIME_DRILL_RUN_SCOPE ?? '')) {
    throw new Error('Runtime mutations require a bounded RUNTIME_DRILL_RUN_SCOPE');
  }
  if (environment.RUNTIME_DRILL_EXCLUSIVE_WINDOW !== 'beta-exclusive-runtime') {
    throw new Error('Runtime mutations require an authorized beta-exclusive-runtime window');
  }
  assertRuntimeDrillMutationConfirmation(environment);
  if (!DRILL_ID_PATTERN.test(environment.RUNTIME_DRILL_ID ?? '')) {
    throw new Error('Runtime mutations require RUNTIME_DRILL_ID=beta-runtime-<unique-id>');
  }
  if (!compatibility?.client?.sha || !COMMIT_PATTERN.test(compatibility.client.sha)
    || !compatibility?.service?.sha || !COMMIT_PATTERN.test(compatibility.service.sha)) {
    throw new Error('Runtime mutations require full pinned Client and Service commit SHAs');
  }
  return { ...config, drillId: environment.RUNTIME_DRILL_ID, concurrency: RUNTIME_DRILL_CONCURRENCY };
}

export function assertRuntimeRecoveryExecutionEnvironment(environment, compatibility, record) {
  if (environment.RUNTIME_DRILL_CONFIRM !== 'beta-runtime-recovery') throw new Error('Recovery requires beta-runtime-recovery confirmation');
  assertRuntimeDrillExecutionEnvironment({ ...environment, RUNTIME_DRILL_CONFIRM: 'beta-runtime-drill' }, compatibility);
  if (environment.RUNTIME_DRILL_RUN_SCOPE !== record.run_scope || environment.RUNTIME_DRILL_ID !== record.marker
    || record.deployment.service.source_commit !== compatibility.service.sha) throw new Error('Recovery original run/marker/Service pins disagree');
}

export async function readProviderFailureFixture(fixturePath) {
  if (typeof fixturePath !== 'string' || fixturePath.length === 0) {
    throw new Error('retry-visibility-dlq requires RUNTIME_DRILL_PROVIDER_FAILURE_FIXTURE');
  }
  if (!FIXTURE_MANIFEST_PATTERN.test(fixturePath.split(/[\\/]/).pop() ?? '')) {
    throw new Error('Provider failure fixture must be an approved provider-failure-*.json manifest');
  }
  const details = await stat(fixturePath).catch(() => undefined);
  if (!details?.isFile()) throw new Error('Provider failure fixture manifest does not exist');
  let fixture;
  try {
    fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
  } catch (error) {
    throw new Error('Provider failure fixture manifest is not valid JSON', { cause: error });
  }
  if (fixture?.schema_version !== 1 || fixture.kind !== 'provider-failure'
    || fixture.application_backdoor !== false || typeof fixture.source !== 'string'
    || !APPROVED_PROVIDER_FIXTURE_SOURCE.test(fixture.source)
    || fixture.approved !== true || typeof fixture.image_path !== 'string'
    || fixture.delay_ms !== 45_000 || fixture.failure_status !== 500 || fixture.forwards_requests !== false
    || fixture.provider_billing_applicability !== 'not-applicable') {
    throw new Error('Provider failure fixture must be the approved non-paid loopback fixture and have no application backdoor');
  }
  if (!fixture.image_path.startsWith('tests/fixtures/') || fixture.image_path.includes('..')) {
    throw new Error('Provider failure fixture image must be checked in under tests/fixtures');
  }
  const image = await stat(fixture.image_path).catch(() => undefined);
  if (!image?.isFile()) throw new Error('Provider failure fixture image does not exist');
  return fixture;
}

export function buildRuntimeDrillPlan(config, stack = {}) {
  const { clientUrl, serviceUrl, awsAccountId, awsRegion } = config;
  return {
    schema_version: 1,
    record_type: 'anywear_beta_runtime_drill_plan',
    generated_at: new Date().toISOString(),
    environment: {
      stage: 'beta',
      aws_account_id: awsAccountId,
      aws_region: awsRegion,
      client_url: clientUrl,
      service_url: serviceUrl,
    },
    deployment: {
      cluster: stack.cluster ?? null,
      api_service: stack.apiService ?? null,
      worker_service: stack.workerService ?? null,
      queues: stack.queues ?? {},
    },
    controls: {
      mutation_confirmation: 'RUNTIME_DRILL_CONFIRM=beta-runtime-drill',
      unique_marker: 'Use one drill_id in every operator-created message and artifact.',
      cleanup: 'Delete only resources and queue messages carrying the current drill_id.',
      production_policy: 'Production is never a valid target for this plan.',
    },
    drills: [
      {
        id: 'accepted-task-restart',
        objective: 'Prove an accepted auto-tag task survives API and worker replacement plus a rolling deployment.',
        operator_steps: [
          'Create one synthetic @anywear.local account and upload one fixture through the existing wardrobe UI.',
          'Record the item id, idempotency key, state version, API and worker task ARNs before replacement.',
          'While the item is processing, perform a controlled API rolling replacement and stop the active worker task once.',
          'Replay the same Idempotency-Key, then poll the item endpoint until one terminal ready state is observed.',
        ],
        pass_conditions: [
          'The item id and original idempotency response are unchanged.',
          'State versions never decrease; exact current terminal task/resource snapshots remain stable over 440000ms (lease + provider deadline + grace).',
          'Same token proves graceful drain; an increased token identifies takeover. Ordinary StopTask is not stale-worker or missed-heartbeat proof.',
          'The replacement task ARNs and CloudWatch logs are retained with the evidence.',
        ],
        cleanup: 'Delete the item and Cognito user after the terminal observation; restore service desired counts and autoscaling.',
      },
      {
        id: 'multi-replica-sse',
        objective: 'Prove PostgreSQL-backed status delivery across two identified API replicas.',
        operator_steps: [
          'Confirm the API service has at least two healthy task ARNs and capture them before opening streams.',
          'Open two authenticated status streams for the same unique item and correlate each stream with an API task ARN in logs.',
          'Replace one API task while the item is processing and allow the client to reconnect and poll.',
        ],
        pass_conditions: [
          'At least two distinct API task ARNs delivered or reconciled the same resource.',
          'Both observers reach the same terminal state and monotonic state version.',
          'A reconnect after task replacement receives the same terminal database snapshot/version.',
        ],
        cleanup: 'Close both streams and delete the unique item and user.',
      },
      {
        id: 'retry-visibility-dlq',
        objective: 'Prove lease renewal, SQS visibility extension, retry backoff, and DLQ redrive for one marked task.',
        operator_steps: [
          'Use a provider failure or timeout fixture approved for Beta; do not add an application test backdoor.',
          'Capture the task row state/version/attempt count and queue ApproximateReceiveCount on every retry.',
          'Verify the message reaches the matching Beta DLQ after the configured redrive count and retains the drill marker.',
        ],
        pass_conditions: [
          'The database lease and SQS visibility are renewed before expiry while the provider call is active.',
          'Retryable failures use bounded backoff and do not create a second task or credit settlement.',
          'The matching DLQ payload is present and no unrelated message is consumed or deleted.',
        ],
        cleanup: 'Redrive or delete only the marked DLQ payload according to the approved operator procedure; remove its user/item.',
      },
      {
        id: 'rollback',
        objective: 'Verify application rollback selects the previous immutable digest and leaves schema forward-only.',
        operator_steps: [
          'Run only after a previous Beta Runtime stack digest and qualification artifact are recorded.',
          'Use a reviewed deployment failure that occurs after the Runtime stack update and before post-deploy verification succeeds.',
          'Capture the previous digest, failed candidate, rollback digest, health identity, and schema version.',
        ],
        pass_conditions: [
          'The final API and worker report the previous digest and commit.',
          'The qualification candidate is not reported as healthy after rollback.',
          'The database is not rolled back and remains at the compatible forward schema version.',
        ],
        cleanup: 'Leave the prior known-good Runtime stack deployed; do not alter Production.',
      },
    ],
  };
}

function assertDeploymentBinding(record, compatibility) {
  const environment = record.environment;
  if (environment?.stage !== 'beta') throw new Error('Runtime evidence must target Beta');
  if (environment.aws_account_id !== TARGET_ACCOUNT || environment.aws_region !== TARGET_REGION) {
    throw new Error('Runtime evidence targets an unauthorized account or region');
  }
  requireHttps(environment.client_url, 'Evidence client_url');
  requireHttps(environment.service_url, 'Evidence service_url');

  const deployment = record.deployment;
  if (!deployment || deployment.client_source_commit !== compatibility.client.sha) {
    throw new Error('Evidence Client commit does not match compatibility.json');
  }
  if (!deployment.service_source_commit || deployment.service_source_commit !== compatibility.service.sha) {
    throw new Error('Evidence Service commit does not match compatibility.json');
  }
  if (!DIGEST_PATTERN.test(deployment.service_image_digest ?? '')) {
    throw new Error('Evidence Service image digest is invalid');
  }
}

export function verifyRestartDrillEvidence(evidence) {
  requireString(evidence.task_id, 'accepted-task-restart task_id');
  requireBoolean(evidence.api_restart, 'accepted-task-restart api_restart');
  requireBoolean(evidence.worker_restart, 'accepted-task-restart worker_restart');
  requireBoolean(evidence.rolling_deployment, 'accepted-task-restart rolling_deployment');
  requireBoolean(evidence.idempotency_replay_same_response, 'accepted-task-restart idempotency_replay_same_response');
  if ('no_duplicate_terminal_effect' in evidence) throw new Error('Current snapshots do not prove terminal-effect history');
  verifyTerminalAuditEvidence(evidence, 'ready');
  requireInteger(evidence.execution_token_before, 'execution_token_before', { minimum: 1 });
  requireInteger(evidence.execution_token_after, 'execution_token_after', { minimum: 1 });
  if (evidence.execution_token_after < evidence.execution_token_before
    || evidence.execution_token_after !== evidence.terminal_audit.after.task.execution_token
    || evidence.recovery_kind !== (evidence.execution_token_after === evidence.execution_token_before ? 'graceful-drain' : 'takeover')) {
    throw new Error('Restart recovery classification must match the exact before/after execution tokens');
  }
  if (!Array.isArray(evidence.state_versions) || evidence.state_versions.length < 2) {
    throw new Error('accepted-task-restart state_versions must contain at least 2 values');
  }
  const versions = evidence.state_versions.map((value, index) => requireInteger(value, `accepted-task-restart state_versions[${index}]`, { minimum: 1 }));
  requireUniqueStrings(evidence.api_task_arns, 'accepted-task-restart api_task_arns', { minimum: 2 });
  requireUniqueStrings(evidence.worker_task_arns, 'accepted-task-restart worker_task_arns', { minimum: 2 });
  for (let index = 1; index < versions.length; index += 1) {
    if (versions[index] < versions[index - 1]) {
      throw new Error('accepted-task-restart state_versions must be monotonic');
    }
  }
  if (!['ready', 'Complete'].includes(evidence.terminal_status)) throw new Error('accepted-task-restart must reach a terminal success state');
}

export function verifyReplicaDrillEvidence(evidence) {
  requireUniqueStrings(evidence.api_task_arns, 'multi-replica-sse api_task_arns', { minimum: 2 });
  requireUniqueStrings(evidence.stream_task_arns, 'multi-replica-sse stream_task_arns', { minimum: 2 });
  requireBoolean(evidence.distinct_replica_logs, 'multi-replica-sse distinct_replica_logs');
  requireBoolean(evidence.reconnected_after_replacement, 'multi-replica-sse reconnected_after_replacement');
  requireBoolean(evidence.both_observers_terminal, 'multi-replica-sse both_observers_terminal');
  requireBoolean(evidence.monotonic_state_versions, 'multi-replica-sse monotonic_state_versions');
  const arn = /^arn:aws:ecs:ap-east-1:650880818323:task\/beta-anywear\/[a-f0-9]{32}$/;
  if ([...evidence.api_task_arns, ...evidence.stream_task_arns].some((value) => !arn.test(value))
    || !Array.isArray(evidence.api_task_arns_after) || evidence.api_task_arns_after.some((value) => !evidence.api_task_arns.includes(value))
    || !Array.isArray(evidence.request_attribution) || evidence.request_attribution.length < 4
    || new Set(evidence.request_attribution.map((entry) => entry.request_id)).size !== evidence.request_attribution.length
    || evidence.request_attribution.some((entry) => typeof entry.request_id !== 'string' || !entry.request_id
      || !evidence.api_task_arns.includes(entry.task_arn) || !evidence.stream_task_arns.includes(entry.task_arn))
    || !Array.isArray(evidence.reconnected_request_ids) || evidence.reconnected_request_ids.length !== 2
    || new Set(evidence.reconnected_request_ids).size !== 2) throw new Error('Replica raw request/task attribution is not exact');
  const after = evidence.reconnected_request_ids.map((id) => evidence.request_attribution.find((entry) => entry.request_id === id)?.task_arn);
  if (new Set(after).size !== 2 || after.some((value) => !evidence.api_task_arns_after.includes(value))) throw new Error('Reconnects did not use two distinct post-replacement API tasks');
  if (!Array.isArray(evidence.terminal_observers) || evidence.terminal_observers.length !== 2
    || evidence.terminal_observers.some((entry) => !['ready', 'failed'].includes(entry.status) || !Number.isInteger(entry.version) || entry.version < 1)
    || !isDeepStrictEqual(evidence.terminal_observers[0], evidence.terminal_observers[1])) throw new Error('Replica observers have inconsistent terminal snapshots');
}

export function verifyRetryDrillEvidence(evidence) {
  requireString(evidence.task_id, 'retry-visibility-dlq task_id');
  requireInteger(evidence.retryable_failures, 'retry-visibility-dlq retryable_failures', { minimum: 1 });
  requireInteger(evidence.receive_count, 'retry-visibility-dlq receive_count', { minimum: 3 });
  requireBoolean(evidence.database_lease_renewed, 'retry-visibility-dlq database_lease_renewed');
  requireBoolean(evidence.sqs_visibility_extended, 'retry-visibility-dlq sqs_visibility_extended');
  if ('no_duplicate_side_effects' in evidence || 'credit_settlement_count' in evidence) {
    throw new Error('Auto-tagging has no credit settlement; current rows do not establish side-effect history');
  }
  verifyTerminalAuditEvidence(evidence, 'failed');
  if (evidence.execution_token !== evidence.terminal_audit.after.task.execution_token) throw new Error('Failure token differs from exact terminal audit');
  requireString(evidence.dlq_message_id, 'retry-visibility-dlq dlq_message_id');
  if (evidence.terminal_status !== 'failed') {
    throw new Error('retry-visibility-dlq terminal_status is invalid');
  }
}

function verifyTerminalAuditEvidence(evidence, status) {
  const audit = evidence.terminal_audit;
  const request = audit?.before?.binding;
  if (!RUN_SCOPE_PATTERN.test(request?.runScope ?? '')
    || !new RegExp(`^e2e-beta-${request.runScope}-0-[a-f0-9]{8}@anywear\\.local$`).test(request?.user?.email ?? '')
    || !/^[0-9a-f-]{36}$/i.test(request?.user?.sub ?? '') || request?.taskId !== evidence.task_id
    || !/^[0-9a-f-]{36}$/i.test(request?.itemId ?? '') || !/^[0-9a-f-]{36}$/i.test(request?.idempotencyKey ?? '')
    || audit?.scope !== 'current-terminal-snapshot-only' || audit.late_stale_rejection_proven !== false
    || audit.missed_heartbeat_proven !== false || evidence.credit?.applicability !== 'not-applicable'
    || evidence.credit.reason !== 'auto-tagging') throw new Error('Terminal evidence must bind exact synthetic task/resource and honest snapshot/credit scope');
  validateTaskAudit(audit.before, request, status);
  validateTaskAudit(audit.after, request, status);
  assertStableAudits(audit.before, audit.after, audit.observation_window_ms);
  if (audit.observation_window_ms < TERMINAL_STABILITY_MS) throw new Error('Terminal observation window is shorter than policy lease/provider bounds');
  for (const snapshot of [audit.before, audit.after]) {
    const id = snapshot.extraction?.task_arn?.match(/^arn:aws:ecs:ap-east-1:650880818323:task\/[^/]+\/([a-f0-9]{32})$/)?.[1];
    if (!id || snapshot.extraction.exit_code !== 0 || snapshot.extraction.log_group !== '/anywear/beta/one-shot'
      || snapshot.extraction.log_stream !== `beta-anywear-task-audit/OneShot/${id}`) throw new Error('Terminal audit must originate from the exact successful one-shot ECS task log stream');
  }
  if (audit.before.extraction.task_arn === audit.after.extraction.task_arn) throw new Error('Terminal stability needs two distinct read-only one-shot audits');
}

function verifyRollbackDrill(evidence) {
  requireBoolean(evidence.attempted, 'rollback attempted');
  if (!evidence.attempted) return;
  for (const [key, label] of [
    ['previous_service_commit', 'rollback previous_service_commit'],
    ['candidate_service_commit', 'rollback candidate_service_commit'],
    ['final_service_commit', 'rollback final_service_commit'],
  ]) {
    if (!COMMIT_PATTERN.test(evidence[key] ?? '')) throw new Error(`${label} must be a full commit SHA`);
  }
  for (const [key, label] of [
    ['previous_image_digest', 'rollback previous_image_digest'],
    ['candidate_image_digest', 'rollback candidate_image_digest'],
    ['final_image_digest', 'rollback final_image_digest'],
  ]) {
    if (!DIGEST_PATTERN.test(evidence[key] ?? '')) throw new Error(`${label} must be an OCI digest`);
  }
  if (evidence.final_image_digest !== evidence.previous_image_digest) {
    throw new Error('rollback final image does not match the previous digest');
  }
  requireBoolean(evidence.database_rollback_attempted === false, 'rollback database_rollback_attempted=false');
}

export function verifyRuntimeDrillEvidence(record, compatibility) {
  if (record?.schema_version !== 2 || record.record_type !== 'anywear_beta_runtime_drill') {
    throw new Error('Unsupported runtime drill evidence schema');
  }
  if (!DRILL_ID_PATTERN.test(record.drill_id ?? '')) {
    throw new Error('Runtime evidence drill_id must match beta-runtime-<unique-id>');
  }
  assertDeploymentBinding(record, compatibility);
  if (!RUN_SCOPE_PATTERN.test(record.run_scope ?? '')
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(record.synthetic_owner?.sub ?? '')
    || !new RegExp(`^e2e-beta-${record.run_scope}-0-[a-f0-9]{8}@anywear\\.local$`).test(record.synthetic_owner?.email ?? '')) {
    throw new Error('Runtime record requires one exact run-owned synthetic identity');
  }
  const scope = { runScope: record.run_scope, subject: record.synthetic_owner.sub, email: record.synthetic_owner.email,
    deployment: { service: { source_commit: record.deployment.service_source_commit, image_digest: record.deployment.service_image_digest } } };
  verifyFencingCiEvidence(record.fencing_ci, compatibility.service.sha);
  if (record.runtime_control?.run_scope !== scope.runScope || record.runtime_control?.restored !== true || record.runtime_control.phase !== 'restored'
    || record.runtime_control.nonpaid_provider_only !== true || record.runtime_control.shared_worker_iam_and_network !== true
    || record.runtime_control.service_source_commit !== compatibility.service.sha
    || record.runtime_control.service_image_digest !== record.deployment.service_image_digest) {
    throw new Error('Runtime evidence requires exact non-paid baseline restoration and explicit shared IAM/network scope');
  }
  const drills = new Map((record.drills ?? []).map((drill) => [drill.id, drill]));
  if (drills.size !== record.drills?.length) throw new Error('Duplicate runtime drill records');
  for (const id of REQUIRED_DRILLS) {
    const drill = drills.get(id);
    if (!drill || drill.status !== 'passed') throw new Error(`Required runtime drill ${id} did not pass`);
    if (id === 'accepted-task-restart') verifyRestartDrillEvidence(drill.evidence);
    if (id === 'multi-replica-sse') verifyReplicaDrillEvidence(drill.evidence);
    if (id === 'retry-visibility-dlq') verifyRetryDrillEvidence(drill.evidence);
  }
  const restart = drills.get('accepted-task-restart').evidence;
  const retry = drills.get('retry-visibility-dlq').evidence;
  const replica = drills.get('multi-replica-sse').evidence;
  if (replica.item_id !== restart.terminal_audit.after.binding.itemId
    || replica.terminal_observers.some((observer) => observer.status !== restart.terminal_audit.after.resource.tagging_status
      || observer.version !== restart.terminal_audit.after.resource.state_version)
    || replica.api_task_arns.some((arn) => !restart.api_task_arns.includes(arn))) throw new Error('Replica evidence differs from exact restart item/tasks/terminal snapshot');
  const requests = [restart, retry].map((evidence) => evidence.terminal_audit.before.binding);
  if (requests[0].taskId === requests[1].taskId || requests[0].itemId === requests[1].itemId
    || requests[0].idempotencyKey === requests[1].idempotencyKey) throw new Error('Restart and retry must use distinct tasks/items/idempotency keys');
  const helperTasks = [];
  for (const evidence of [restart, retry]) {
    for (const audit of [evidence.terminal_audit.before, evidence.terminal_audit.after]) {
      if (audit.binding.runScope !== scope.runScope || !isDeepStrictEqual(audit.binding.user, record.synthetic_owner)) {
        throw new Error('Terminal audit belongs to a foreign run/user');
      }
      validateOneShotProof(audit.extraction, scope, 'task-audit', JSON.stringify(audit.binding));
      helperTasks.push(audit.extraction.task_arn);
    }
  }
  for (const arn of record.runtime_control.fixture_task_definitions ?? []) {
    if (!new RegExp(`^arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-nonpaid-${scope.runScope}:[1-9][0-9]*$`).test(arn)) {
      throw new Error('Fixture task definition belongs to a foreign family/run');
    }
  }
  verifyWindowEvidence(record.window_control, scope, helperTasks);
  scope.knownDLQMessageId = { taskId: retry.task_id, messageId: retry.dlq_message_id };
  validateCleanupEvidence(record.cleanup_evidence, scope);
  helperTasks.push(record.cleanup_evidence.extraction.task_arn);
  if (new Set(helperTasks).size !== helperTasks.length) throw new Error('Helper evidence reuses an ECS task across distinct operations');
  const rollback = drills.get('rollback');
  if (rollback?.status === 'failed') throw new Error('Optional rollback drill is marked failed');
  if (rollback?.status === 'passed') verifyRollbackDrill(rollback.evidence);
  return {
    passed: true,
    required_drills: [...REQUIRED_DRILLS],
    rollback: rollback?.status ?? 'not_recorded',
  };
}

function verifyWindowEvidence(window, scope, helperTasks) {
  if (window?.run_scope !== scope.runScope || !isDeepStrictEqual(window.synthetic_owner, { sub: scope.subject, email: scope.email })
    || window.restored !== true || window.phase !== 'restored' || !Array.isArray(window.write_ledger) || window.write_ledger.length < 3) {
    throw new Error('Admission ledger lacks exact restored run/user binding');
  }
  // One mode parameter: `set-testers` moves the tester list and `suspend`/`resume` move
  // the mode, so each ledger entry carries exactly one parameter's version increment.
  const keys = ['admission_mode', 'tester_allowlist'];
  let versions = window.baseline_versions;
  const lastSetTesters = window.write_ledger.findLast((entry) => entry.action === 'set-testers');
  let activated = false;
  for (const entry of window.write_ledger) {
    if (entry.run_scope !== scope.runScope || !isDeepStrictEqual(entry.before_versions, versions)) throw new Error('Foreign run or discontinuous admission write ledger');
    const deltas = entry.action === 'set-testers' ? [0, 1] : [1, 0];
    if (!['set-testers', 'suspend', 'resume'].includes(entry.action) || keys.some((key, offset) =>
      !Number.isInteger(versions?.[key]) || versions[key] < 1 || entry.after_versions?.[key] !== versions[key] + deltas[offset])) {
      throw new Error('Admission write ledger has non-nominal versions');
    }
    const payload = entry.extraction?.command?.[3] ?? '';
    validateOneShotProof(entry.extraction, scope, 'lifecycle', payload, entry.action);
    if (entry.action === 'set-testers') {
      const emails = JSON.parse(payload);
      if (!Array.isArray(emails) || emails.some((email) => typeof email !== 'string') || testerHash(emails) !== entry.tester_hash
        || (entry !== lastSetTesters && payload !== JSON.stringify([scope.email]))
        || (entry === lastSetTesters && entry.tester_hash !== window.baseline_audit?.policy?.tester_allowlist_hash)) {
        throw new Error('Admission tester writes are not bound to synthetic activation or exact baseline restoration');
      }
    }
    if (!activated && entry.action !== 'suspend') {
      if (entry.action !== 'set-testers' || payload !== JSON.stringify([scope.email])) throw new Error('Admission did not begin with the exact run-owned tester');
      activated = true;
    }
    helperTasks.push(entry.extraction.task_arn);
    versions = entry.after_versions;
  }
  if (!activated || !isDeepStrictEqual(versions, window.final_versions)) throw new Error('Admission final versions do not match the write ledger');
  for (const audit of [window.baseline_audit, window.final_audit]) {
    const request = { runScope: scope.runScope, mode: 'window-preflight' };
    if (audit?.source !== 'durable-runtime-window-audit' || audit.schema_version !== 1
      || !isDeepStrictEqual(audit.binding, request)
      || !Number.isFinite(Date.parse(audit.observed_at)) || !Number.isFinite(Date.parse(audit.policy.updated_at))
      || !['closed', 'testers'].includes(audit.policy.admission_mode) || !/^[a-f0-9]{64}$/.test(audit.policy.tester_allowlist_hash ?? '')
      || !Number.isInteger(audit.policy.tester_count) || audit.policy.tester_count < 0 || audit.policy.tester_count > 50
      || ['active_tasks', 'unpublished_outbox', 'manual_intervention_outbox'].some((key) => audit.current_rows?.[key] !== 0)) {
      throw new Error('Admission requires exact before/after empty durable census');
    }
    validateOneShotProof(audit.extraction, scope, 'task-audit', JSON.stringify(request));
    helperTasks.push(audit.extraction.task_arn);
  }
  if (!isDeepStrictEqual(window.baseline_audit.policy, window.final_audit.policy)) {
    // `updated_at` is the Service row's write instant, which the restoration rewrites; the
    // mode decision and the tester list are what must match.
    const { updated_at: ignoredBefore, ...before } = window.baseline_audit.policy;
    const { updated_at: ignoredAfter, ...after } = window.final_audit.policy;
    void ignoredBefore; void ignoredAfter;
    if (!isDeepStrictEqual(before, after)) throw new Error('Original private admission policy was not restored');
  }
}

function outputMap(outputs) {
  return Object.fromEntries((outputs ?? []).map((entry) => [entry.OutputKey, entry.OutputValue]));
}

async function awsJson(args) {
  try {
    const { stdout } = await exec('aws', [...args, '--output', 'json'], { maxBuffer: 10 * 1024 * 1024 });
    return stdout.trim() ? JSON.parse(stdout) : {};
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`AWS read-only command failed (${args.join(' ')}): ${message}`, { cause: error });
  }
}

async function collectPreflight(config, compatibility) {
  const identity = await awsJson(['sts', 'get-caller-identity']);
  if (identity.Account !== TARGET_ACCOUNT) throw new Error(`AWS identity account ${identity.Account ?? 'unknown'} is not Beta NonProd`);

  const [platformResponse, runtimeResponse] = await Promise.all([
    awsJson(['cloudformation', 'describe-stacks', '--stack-name', 'AnyWearPlatformStack-beta']),
    awsJson(['cloudformation', 'describe-stacks', '--stack-name', 'AnyWearRuntimeStack-beta']),
  ]);
  const platform = platformResponse.Stacks?.[0];
  const runtime = runtimeResponse.Stacks?.[0];
  // Issue #166: the persistent Base stack and the Service-owned Runtime slice are
  // the two stacks a running Beta has. There is no separate active flag any more:
  // the stopped state is simply the absent Runtime stack, so its presence is the
  // whole precondition.
  if (!platform || !runtime) throw new Error('Beta Base (AnyWearPlatformStack-beta) and Runtime (AnyWearRuntimeStack-beta) stacks must exist before runtime drills');
  const platformOutputs = outputMap(platform.Outputs);
  const runtimeOutputs = outputMap(runtime.Outputs);
  const stack = {
    cluster: platformOutputs.EcsClusterName,
    apiService: runtimeOutputs.ApiServiceName,
    workerService: runtimeOutputs.WorkerServiceName,
    userPoolId: platformOutputs.UserPoolId,
    userPoolClientId: platformOutputs.UserPoolClientId,
    bucket: platformOutputs.WardrobeBucketName,
    oneShotExecutionRoleArn: platformOutputs.OneShotExecutionRoleArn,
    verificationTaskRoleArn: platformOutputs.VerificationTaskRoleArn,
    lifecycleTaskRoleArn: platformOutputs.LifecycleTaskRoleArn,
    queues: {
      vto: platformOutputs.VtoQueueUrl,
      autoTagging: platformOutputs.AutoTaggingQueueUrl,
      vtoDlq: platformOutputs.VtoDlqUrl,
      autoTaggingDlq: platformOutputs.AutoTaggingDlqUrl,
    },
  };
  for (const [key, label] of Object.entries({
    cluster: 'ECS cluster',
    apiService: 'API service',
    workerService: 'worker service',
    userPoolId: 'Cognito user pool',
    userPoolClientId: 'Cognito user pool client',
    bucket: 'Wardrobe bucket',
    oneShotExecutionRoleArn: 'one-shot execution role',
    verificationTaskRoleArn: 'verification task role',
    lifecycleTaskRoleArn: 'lifecycle task role',
    'queues.vto': 'VTO queue',
    'queues.autoTagging': 'auto-tagging queue',
    'queues.vtoDlq': 'VTO DLQ',
    'queues.autoTaggingDlq': 'auto-tagging DLQ',
  })) {
    const value = key.includes('.') ? stack.queues[key.split('.')[1]] : stack[key];
    requireString(value, label);
  }

  const services = await awsJson([
    'ecs', 'describe-services', '--cluster', stack.cluster, '--services', stack.apiService, stack.workerService,
  ]);
  if ((services.failures ?? []).length > 0) throw new Error('Unable to identify every Beta ECS service');
  for (const service of services.services ?? []) {
    if (service.runningCount < 1 || service.desiredCount < 1) {
      throw new Error(`Beta ECS service ${service.serviceName ?? 'unknown'} is not running`);
    }
  }
  const admission = await awsJson(['ssm', 'get-parameter', '--name', ADMISSION_MODE_PARAMETER]);
  const admissionMode = parseAdmissionMode(admission.Parameter?.Value);
  if (!admissionMode) throw new Error('Runtime drills require a reader-valid Beta admission mode record');
  const queues = {};
  for (const [name, url] of Object.entries(stack.queues)) {
    queues[name] = await awsJson(['sqs', 'get-queue-attributes', '--queue-url', url, '--attribute-names', 'All']);
  }
  return {
    schema_version: 1,
    record_type: 'anywear_beta_runtime_preflight',
    collected_at: new Date().toISOString(),
    environment: config,
    deployment: await collectDeploymentEvidence({
      clientUrl: config.clientUrl,
      serviceUrl: config.serviceUrl,
    }, compatibility),
    stack,
    services: services.services ?? [],
    admission_mode: admissionMode.mode,
    queues,
    notes: [
      'Preflight is read-only and does not restart ECS tasks, publish SQS messages, or mutate database state.',
      `Task-bearing runtime drills open admission to their own run-owned tester from /anywear/beta/admission_mode=${admissionMode.mode} and restore that decision and the tester list afterwards.`,
      'A passing preflight is not runtime reliability evidence.',
    ],
  };
}

export function assertRuntimeDrillExecutorAdapter(adapter) {
  const required = [
    'createSyntheticAccount',
    'prepareNonPaidRuntime',
    'restoreNonPaidRuntime',
    'pauseRuntimeWindow',
    'restoreRuntimeWindow',
    'runWardrobeApiFlow',
    'replaceAndRestoreEcs',
    'captureReplicaAttribution',
    'runProviderFailureFixture',
    'collectRetryEvidence',
    'cleanupOwnedResources',
  ];
  if (!adapter || required.some((name) => typeof adapter[name] !== 'function')) {
    throw new Error(`Runtime executor requires a reviewed adapter implementing: ${required.join(', ')}`);
  }
  return adapter;
}

export async function executeRuntimeDrill(environment, compatibility, adapter, {
  preflightCollector = collectPreflight,
  fixtureReader = readProviderFailureFixture,
  fencingReader = readFencingCiEvidence,
} = {}) {
  const config = assertRuntimeDrillExecutionEnvironment(environment, compatibility);
  assertRuntimeDrillExecutorAdapter(adapter);
  const providerFixture = await fixtureReader(environment.RUNTIME_DRILL_PROVIDER_FAILURE_FIXTURE);
  const fencingCi = await fencingReader(environment, compatibility.service.sha);

  let preflight;
  let scope;
  let result;
  let operationError;
  let operationPhase = 'synthetic account creation';
  let pauseError;
  let cleanupError;
  let restorationError;
  let policyRestorationError;
  // The whole operation sits inside one `finally` because admission has no expiry: if
  // this run opened admission and any later step throws, nothing else will close it. The
  // teardown therefore always attempts the explicit pause, and a pause failure is reported
  // as a teardown failure instead of being skipped.
  try {
    preflight = await preflightCollector(config, compatibility);
    if (!['closed', 'testers'].includes(preflight.admission_mode)) throw new Error('Runtime drills require a reader-valid /anywear/beta/admission_mode record');
    try {
      scope = await adapter.createSyntheticAccount({ config, marker: config.drillId, stack: preflight.stack, deployment: preflight.deployment });
      scope.deployment = preflight.deployment;
      operationPhase = 'non-paid worker runtime setup';
      await adapter.prepareNonPaidRuntime({ scope, fixture: providerFixture });
      operationPhase = 'accepted wardrobe API flow';
      const restart = await adapter.runWardrobeApiFlow({ scope, marker: config.drillId });
      operationPhase = 'ECS replacement and restoration';
      const replacement = await adapter.replaceAndRestoreEcs({ stack: preflight.stack, scope, marker: config.drillId });
      operationPhase = 'multi-replica SSE attribution';
      const replica = await adapter.captureReplicaAttribution({ scope, marker: config.drillId, replacement });
      if (!replica.distinct_replica_logs || !Array.isArray(replica.stream_task_arns)
        || new Set(replica.stream_task_arns).size < 2) {
        throw new Error('Runtime executor refused SSE evidence without two distinct request-attributed ECS replicas');
      }
      operationPhase = 'runtime evidence verification';
      const restartEvidence = replacement.restart_evidence ?? restart;
      verifyRestartDrillEvidence(restartEvidence);
      verifyReplicaDrillEvidence(replica);
      operationPhase = 'provider failure fixture';
      const failure = await adapter.runProviderFailureFixture({ scope, marker: config.drillId, fixture: providerFixture });
      operationPhase = 'retry visibility and DLQ evidence';
      const retry = await adapter.collectRetryEvidence({ scope, marker: config.drillId, failure });
      verifyRetryDrillEvidence(retry);
      result = {
        schema_version: 2,
        record_type: 'anywear_beta_runtime_drill',
        drill_id: config.drillId,
        run_scope: scope.runScope,
        synthetic_owner: { sub: scope.subject, email: scope.email },
        environment: { stage: 'beta', aws_account_id: TARGET_ACCOUNT, aws_region: TARGET_REGION, client_url: config.clientUrl, service_url: config.serviceUrl },
        deployment: {
          client_source_commit: preflight.deployment.client.source_commit,
          service_source_commit: preflight.deployment.service.source_commit,
          service_image_digest: preflight.deployment.service.image_digest,
        },
        fencing_ci: fencingCi,
        drills: [
          { id: 'accepted-task-restart', status: 'passed', evidence: restartEvidence },
          { id: 'multi-replica-sse', status: 'passed', evidence: replica },
          { id: 'retry-visibility-dlq', status: 'passed', evidence: retry },
        ],
      };
    } catch (error) {
      operationError = error;
    }
  } finally {
    if (scope) {
      try { await adapter.pauseRuntimeWindow({ scope }); }
      catch (error) { pauseError = error; }
      // Resource cleanup is withheld when the admission pause/ownership guard failed, but
      // the failure still surfaces as a teardown failure below.
      if (pauseError) {
        cleanupError = new Error('Resource cleanup withheld because admission pause/ownership guard failed', { cause: pauseError });
      } else {
        try { await adapter.cleanupOwnedResources({ scope, marker: config.drillId, stack: preflight.stack }); }
        catch (error) { cleanupError = error; }
      }
      try { await adapter.restoreNonPaidRuntime({ scope }); }
      catch (error) { restorationError = error; }
      try { await adapter.restoreRuntimeWindow({ scope }); }
      catch (error) { policyRestorationError = error; }
    }
  }
  const failures = [
    operationError && operationPhase,
    pauseError && 'admission pause',
    cleanupError && 'run-owned resource cleanup',
    restorationError && 'non-paid runtime restoration',
    policyRestorationError && 'admission restoration',
  ].filter(Boolean);
  if (failures.length) {
    const errors = [operationError, pauseError, cleanupError, restorationError, policyRestorationError].filter(Boolean);
    const cause = errors.length === 1 ? errors[0] : new AggregateError(errors);
    // Preserve internal causes for tests without printing provider responses or CLI argv.
    throw new Error(`Runtime execution failed in: ${failures.join('; ')}. Inspect available recovery artifacts before retrying.`, { cause });
  }
  result.runtime_control = scope.runtimeControl;
  result.window_control = { run_scope: scope.runScope, synthetic_owner: { sub: scope.subject, email: scope.email },
    restored: scope.runtimeWindow?.restored === true, phase: scope.runtimeWindow?.phase, write_ledger: scope.runtimeWindow?.write_ledger,
    baseline_audit: scope.runtimeWindow?.baseline_audit, final_audit: scope.runtimeWindow?.final_audit,
    baseline_versions: Object.fromEntries(Object.entries(scope.runtimeWindow?.baseline ?? {}).map(([key, value]) => [key, value.version])),
    final_versions: Object.fromEntries(Object.entries(scope.runtimeWindow?.expected ?? {}).map(([key, value]) => [key, value.version])) };
  result.cleanup_evidence = scope.cleanupEvidence;
  verifyRuntimeDrillEvidence(result, compatibility);
  return result;
}

async function loadCompatibility() {
  return JSON.parse(await readFile(new URL('../compatibility.json', import.meta.url), 'utf8'));
}

export async function loadExecutionAdapter(environment) {
  const modulePath = environment.RUNTIME_DRILL_ADAPTER_MODULE;
  if (!modulePath) return undefined;
  if (modulePath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(modulePath) || modulePath.includes('..') || modulePath.includes('\\')) {
    throw new Error('Runtime drill adapter must be a relative module under scripts');
  }
  const module = await import(new URL(modulePath, import.meta.url));
  if (typeof module.createRuntimeDrillAdapter === 'function') return module.createRuntimeDrillAdapter(undefined, environment);
  return module.default ?? module.runtimeDrillAdapter;
}

function usage() {
  console.log([
    'Usage:',
    '  node scripts/runtime-drill.mjs --plan',
    '  node scripts/runtime-drill.mjs --preflight',
    '  node scripts/runtime-drill.mjs --execute',
    '  node scripts/runtime-drill.mjs --verify <evidence.json>',
    '  node scripts/runtime-drill.mjs --recover <recovery.json>',
    '',
    'All modes are Beta-only. --plan and --preflight are read-only.',
    '--execute requires main, anywear-beta-runtime concurrency, explicit confirmation, and an approved provider-failure fixture.',
  ].join('\n'));
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const mode = process.argv[2];
  if (mode === '--help' || !mode) {
    usage();
  } else {
    try {
      const compatibility = await loadCompatibility();
      if (mode === '--verify') {
        const evidencePath = process.argv.slice(3).find((argument) => argument !== '--')
          ?? process.env.RUNTIME_DRILL_EVIDENCE_PATH;
        const record = JSON.parse(await readFile(requireString(evidencePath, 'Evidence path'), 'utf8'));
        const result = verifyRuntimeDrillEvidence(record, compatibility);
        console.log(`Verified Beta runtime drill evidence: ${result.required_drills.join(', ')}; rollback=${result.rollback}`);
      } else if (mode === '--recover') {
        assertLiveRuntimeSourceReady();
        const record = parseRuntimeRecovery(await readFile(requireString(process.argv[3], 'Recovery path'), 'utf8'));
        const environment = { ...process.env };
        assertRuntimeRecoveryExecutionEnvironment(environment, compatibility, record);
        const adapter = await loadExecutionAdapter(environment);
        if (typeof adapter?.recoverOwnedRuntime !== 'function') throw new Error('Protected adapter has no runtime recovery hook');
        console.log(JSON.stringify(await adapter.recoverOwnedRuntime(record)));
      } else if (mode === '--execute') {
        assertLiveRuntimeSourceReady();
        const adapter = await loadExecutionAdapter(process.env);
        const execution = await executeRuntimeDrill(process.env, compatibility, adapter);
        const outputPath = process.env.RUNTIME_DRILL_EVIDENCE_PATH ?? 'runtime-drill-evidence.json';
        await writeFile(outputPath, `${JSON.stringify(execution, null, 2)}\n`, 'utf8');
        console.log(`Wrote Beta runtime drill evidence to ${outputPath}`);
      } else {
        const config = assertRuntimeDrillEnvironment();
        if (mode === '--plan') {
          const outputPath = process.env.RUNTIME_DRILL_PLAN_PATH ?? 'runtime-drill-plan.json';
          await writeFile(outputPath, `${JSON.stringify(buildRuntimeDrillPlan(config), null, 2)}\n`, 'utf8');
          console.log(`Wrote read-only Beta runtime drill plan to ${outputPath}`);
        } else if (mode === '--preflight') {
          const preflight = await collectPreflight(config, compatibility);
          const outputPath = process.env.RUNTIME_PREFLIGHT_OUTPUT_PATH ?? 'runtime-preflight.json';
          await writeFile(outputPath, `${JSON.stringify(preflight, null, 2)}\n`, 'utf8');
          console.log(`Wrote read-only Beta runtime preflight to ${outputPath}`);
        } else {
          usage();
          process.exitCode = 2;
        }
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
