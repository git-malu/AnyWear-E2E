import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { collectDeploymentEvidence } from './qualification-record.mjs';

const exec = promisify(execFile);
const TARGET_ACCOUNT = '650880818323';
const TARGET_REGION = 'ap-east-1';
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const DRILL_ID_PATTERN = /^beta-runtime-[a-z0-9-]+$/;
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
          'State versions never decrease and exactly one terminal result is visible.',
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
          'A reconnect after task replacement receives the database snapshot without duplicate terminal effects.',
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
          'Run only after a previous Beta WorkloadStack digest and qualification artifact are recorded.',
          'Use a reviewed deployment failure that occurs after WorkloadStack update and before post-deploy verification succeeds.',
          'Capture the previous digest, failed candidate, rollback digest, health identity, and schema version.',
        ],
        pass_conditions: [
          'The final API and worker report the previous digest and commit.',
          'The qualification candidate is not reported as healthy after rollback.',
          'The database is not rolled back and remains at the compatible forward schema version.',
        ],
        cleanup: 'Leave the prior known-good WorkloadStack active; do not alter Production.',
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

function verifyRestartDrill(evidence) {
  requireString(evidence.task_id, 'accepted-task-restart task_id');
  requireBoolean(evidence.api_restart, 'accepted-task-restart api_restart');
  requireBoolean(evidence.worker_restart, 'accepted-task-restart worker_restart');
  requireBoolean(evidence.rolling_deployment, 'accepted-task-restart rolling_deployment');
  requireBoolean(evidence.idempotency_replay_same_response, 'accepted-task-restart idempotency_replay_same_response');
  requireBoolean(evidence.no_duplicate_terminal_effect, 'accepted-task-restart no_duplicate_terminal_effect');
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

function verifyReplicaDrill(evidence) {
  requireUniqueStrings(evidence.api_task_arns, 'multi-replica-sse api_task_arns', { minimum: 2 });
  requireUniqueStrings(evidence.stream_task_arns, 'multi-replica-sse stream_task_arns', { minimum: 2 });
  requireBoolean(evidence.distinct_replica_logs, 'multi-replica-sse distinct_replica_logs');
  requireBoolean(evidence.reconnected_after_replacement, 'multi-replica-sse reconnected_after_replacement');
  requireBoolean(evidence.both_observers_terminal, 'multi-replica-sse both_observers_terminal');
  requireBoolean(evidence.monotonic_state_versions, 'multi-replica-sse monotonic_state_versions');
}

function verifyRetryDrill(evidence) {
  requireString(evidence.task_id, 'retry-visibility-dlq task_id');
  requireInteger(evidence.retryable_failures, 'retry-visibility-dlq retryable_failures', { minimum: 1 });
  requireInteger(evidence.receive_count, 'retry-visibility-dlq receive_count', { minimum: 3 });
  requireBoolean(evidence.database_lease_renewed, 'retry-visibility-dlq database_lease_renewed');
  requireBoolean(evidence.sqs_visibility_extended, 'retry-visibility-dlq sqs_visibility_extended');
  requireBoolean(evidence.no_duplicate_side_effects, 'retry-visibility-dlq no_duplicate_side_effects');
  requireInteger(evidence.credit_settlement_count, 'retry-visibility-dlq credit_settlement_count');
  if (evidence.credit_settlement_count > 1) throw new Error('retry-visibility-dlq settled credits more than once');
  requireString(evidence.dlq_message_id, 'retry-visibility-dlq dlq_message_id');
  if (!['failed', 'ready', 'Complete'].includes(evidence.terminal_status)) {
    throw new Error('retry-visibility-dlq terminal_status is invalid');
  }
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
  if (record?.schema_version !== 1 || record.record_type !== 'anywear_beta_runtime_drill') {
    throw new Error('Unsupported runtime drill evidence schema');
  }
  if (!DRILL_ID_PATTERN.test(record.drill_id ?? '')) {
    throw new Error('Runtime evidence drill_id must match beta-runtime-<unique-id>');
  }
  assertDeploymentBinding(record, compatibility);
  const drills = new Map((record.drills ?? []).map((drill) => [drill.id, drill]));
  for (const id of REQUIRED_DRILLS) {
    const drill = drills.get(id);
    if (!drill || drill.status !== 'passed') throw new Error(`Required runtime drill ${id} did not pass`);
    if (id === 'accepted-task-restart') verifyRestartDrill(drill.evidence);
    if (id === 'multi-replica-sse') verifyReplicaDrill(drill.evidence);
    if (id === 'retry-visibility-dlq') verifyRetryDrill(drill.evidence);
  }
  const rollback = drills.get('rollback');
  if (rollback?.status === 'failed') throw new Error('Optional rollback drill is marked failed');
  if (rollback?.status === 'passed') verifyRollbackDrill(rollback.evidence);
  return {
    passed: true,
    required_drills: [...REQUIRED_DRILLS],
    rollback: rollback?.status ?? 'not_recorded',
  };
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

  const [platformResponse, workloadResponse] = await Promise.all([
    awsJson(['cloudformation', 'describe-stacks', '--stack-name', 'AnyWearPlatformStack-beta']),
    awsJson(['cloudformation', 'describe-stacks', '--stack-name', 'AnyWearWorkloadStack-beta']),
  ]);
  const platform = platformResponse.Stacks?.[0];
  const workload = workloadResponse.Stacks?.[0];
  if (!platform || !workload) throw new Error('Beta PlatformStack and WorkloadStack must exist before runtime drills');
  const platformOutputs = outputMap(platform.Outputs);
  const workloadOutputs = outputMap(workload.Outputs);
  if (platformOutputs.BetaActive === 'false' || workloadOutputs.BetaActive === 'false') {
    throw new Error('Beta compute is stopped; run the approved lifecycle start before runtime drills');
  }
  const stack = {
    cluster: platformOutputs.EcsClusterName,
    apiService: workloadOutputs.ApiServiceName,
    workerService: workloadOutputs.WorkerServiceName,
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
  const intake = await awsJson(['ssm', 'get-parameter', '--name', '/anywear/beta/intake_open']);
  const intakeOpen = intake.Parameter?.Value === 'true';
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
    intake_open: intakeOpen,
    queues,
    notes: [
      'Preflight is read-only and does not restart ECS tasks, publish SQS messages, or mutate database state.',
      ...(intakeOpen ? [] : ['Task-bearing runtime drills require an approved Beta test window that opens /anywear/beta/intake_open.']),
      'A passing preflight is not runtime reliability evidence.',
    ],
  };
}

async function loadCompatibility() {
  return JSON.parse(await readFile(new URL('../compatibility.json', import.meta.url), 'utf8'));
}

function usage() {
  console.log([
    'Usage:',
    '  node scripts/runtime-drill.mjs --plan',
    '  node scripts/runtime-drill.mjs --preflight',
    '  node scripts/runtime-drill.mjs --verify <evidence.json>',
    '',
    'All modes are Beta-only. --plan and --preflight are read-only.',
    'The drill plan describes operator-approved ECS/SQS mutations but never executes them.',
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
