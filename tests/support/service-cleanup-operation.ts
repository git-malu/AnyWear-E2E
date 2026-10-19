import { DescribeExecutionCommand, SFNClient, StartExecutionCommand, type DescribeExecutionOutput } from '@aws-sdk/client-sfn';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isDeepStrictEqual, promisify } from 'node:util';
import { parseStrictJson } from '../../scripts/evidence-contract.mjs';
import { isBetaWorkerEmailForScope } from './beta-address.ts';
import type { ServiceCleanupInputs } from './worker-cleanup.js';

const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const RUN_SCOPE = /^[1-9][0-9]{0,19}-[1-9][0-9]{0,5}-[a-f0-9]{16}$/;
const VERSION_ARN = /^arn:aws:states:ap-east-1:650880818323:stateMachine:beta-anywear-tester-cleanup:([1-9][0-9]*)$/;
const TASK_ARN = /^arn:aws:ecs:ap-east-1:650880818323:task\/beta-anywear\/([a-f0-9]{32})$/;
const DEFINITION_ARN = /^arn:aws:ecs:ap-east-1:650880818323:task-definition\/(beta-anywear-cleanup(?:-verify)?):[1-9][0-9]*$/;
const CLUSTER = 'arn:aws:ecs:ap-east-1:650880818323:cluster/beta-anywear';
const LOG_GROUP = '/anywear/beta/one-shot';
const MARKER = 'ANYWEAR_BETA_CLEANUP_RESULT=';
const TERMINAL_FAILURE = ['FAILED', 'TIMED_OUT', 'ABORTED'];
const CLEANUP_FAMILIES = ['beta-anywear-cleanup', 'beta-anywear-cleanup-verify', 'beta-anywear-cleanup-acceptance'] as const;
const MAX_GENERATIONS = 1;
const execute = promisify(execFile);

type CleanupRefusalPhase = 'operation_start' | 'execution_observation' | 'retry_eligibility' | 'retry_proof'
  | 'result_proof' | 'task_proof' | 'completion_proof';
type CleanupRefusalCategory = 'operation_start_unavailable' | 'execution_observation_unavailable' | 'retry_not_authorized'
  | 'retry_proof_unavailable' | 'execution_not_succeeded' | 'result_proof_unavailable' | 'task_proof_unavailable'
  | 'completion_proof_unavailable';

export interface CleanupOperationEnvelope {
  schema_version: 1;
  operation_mode: 'normal';
  recovery_attempt?: number;
  operation_id: string;
  run_scope: string;
  request_sha256: string;
  service_commit_sha: string;
  service_image_digest: string;
  cleanup_request: string;
}

export interface CleanupOperationResult {
  schema_version: 1;
  record_type: 'anywear_beta_cleanup_tasks';
  operation_id: string;
  request_sha256: string;
  run_scope: string;
  service_commit_sha: string;
  service_image_digest: string;
  cluster_arn: string;
  log_group_name: string;
  verification_task_arn: string;
  verification_task_definition_arn: string;
  verification_task_status: 'STOPPED';
  verification_exit_code: 0;
  verification_log_stream_prefix: string;
  cleanup_task_arn: string;
  cleanup_task_definition_arn: string;
  cleanup_task_status: 'STOPPED';
  cleanup_exit_code: 0;
  cleanup_log_stream_prefix: string;
}

export interface CleanupOperationEvidence {
  schema_version: 3;
  record_type: 'anywear_e2e_service_cleanup_operation';
  operation: {
    operation_mode: 'normal';
    recovery_attempt?: number;
    state_machine_version_arn: string;
    execution_arn: string;
    execution_name: string;
    started_at?: string;
    stopped_at?: string;
    status: string;
    proof_status: 'pending' | 'verified' | 'refused';
    input_sha256: string;
    input: CleanupOperationEnvelope;
    output?: CleanupOperationResult;
    tasks?: Record<string, unknown>[];
    committed_result?: Record<string, unknown>;
    preceding_execution?: { execution_arn: string; status: string; stopped_at?: string; cleanup_families: string[] };
    failure?: string;
    refusal_phase?: CleanupRefusalPhase;
    refusal_category?: CleanupRefusalCategory;
  };
}

export interface CleanupOperationIo {
  start(input: CleanupOperationEnvelope, executionName: string): Promise<{ executionArn?: string }>;
  describe(executionArn: string): Promise<DescribeExecutionOutput>;
  aws(args: string[]): Promise<unknown>;
  sleep(milliseconds: number): Promise<void>;
}

interface CanonicalTask {
  taskArn: string;
  clusterArn: string;
  taskDefinitionArn: string;
  lastStatus: string;
  desiredStatus: string;
  startedBy: string;
  containers: Record<string, unknown>[];
  overrides: Record<string, unknown>;
}

interface TaskProofOptions {
  expectedDefinition?: string;
  requireSuccess: boolean;
  snapshotText?: string;
}

function hash(text: string): string { return createHash('sha256').update(text, 'utf8').digest('hex'); }
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function exactObject(value: unknown, label: string, allowed: string[]): Record<string, unknown> {
  const result = object(value, label);
  if (Object.keys(result).some(key => !allowed.includes(key))) throw new Error(`${label} contains an unknown field`);
  return result;
}

function optionalArray(value: unknown, label: string): unknown[] {
  if (value === undefined) return [];
  return array(value, label);
}

function mapLiveTask(value: unknown): CanonicalTask {
  const task = object(value, 'Live ECS task');
  for (const key of ['taskArn', 'clusterArn', 'taskDefinitionArn', 'lastStatus', 'desiredStatus', 'startedBy']) {
    if (typeof task[key] !== 'string' || task[key] === '') throw new Error(`Live ECS task field ${key} is malformed`);
  }
  const containers = array(task.containers, 'Live ECS containers').map(entry => object(entry, 'Live ECS container'));
  return { taskArn: task.taskArn as string, clusterArn: task.clusterArn as string, taskDefinitionArn: task.taskDefinitionArn as string,
    lastStatus: task.lastStatus as string, desiredStatus: task.desiredStatus as string, startedBy: task.startedBy as string, containers,
    overrides: object(task.overrides === undefined ? {} : task.overrides, 'Live ECS overrides') };
}

function validateCanonicalTask(task: CanonicalTask, envelope: CleanupOperationEnvelope, io: CleanupOperationIo,
  options: TaskProofOptions): Promise<Record<string, unknown>> {
  return (async () => {
    if (!TASK_ARN.test(task.taskArn) || task.clusterArn !== CLUSTER || task.lastStatus !== 'STOPPED' || task.desiredStatus !== 'STOPPED'
      || task.startedBy !== 'AWS Step Functions' || !DEFINITION_ARN.test(task.taskDefinitionArn)
      || (options.expectedDefinition && task.taskDefinitionArn !== options.expectedDefinition)) throw new Error('Cleanup task has not stopped under the exact definition');
    if (task.containers.length !== 1) throw new Error('Cleanup task must have exactly one container');
    const container = task.containers[0];
    if (container.name !== 'OneShot' || container.lastStatus !== 'STOPPED' || !Number.isInteger(container.exitCode)
      || (options.requireSuccess && container.exitCode !== 0) || container.imageDigest !== envelope.service_image_digest) {
      throw new Error('OneShot task image/status/exit proof failed');
    }
    const definitionResponse = object(await io.aws(['ecs', 'describe-task-definition', '--task-definition', task.taskDefinitionArn]), 'Task definition response');
    const definition = object(definitionResponse.taskDefinition, 'Task definition');
    const definitions = array(definition.containerDefinitions, 'Definition containers');
    if (definitions.length !== 1 || definition.taskDefinitionArn !== task.taskDefinitionArn || definition.cpu !== '512' || definition.memory !== '1024'
      || definition.networkMode !== 'awsvpc' || !isDeepStrictEqual(definition.requiresCompatibilities, ['FARGATE'])) throw new Error('Immutable cleanup definition changed');
    const fixed = object(definitions[0], 'Fixed OneShot definition');
    if (fixed.name !== 'OneShot' || typeof fixed.image !== 'string' || !fixed.image.startsWith('650880818323.dkr.ecr.ap-east-1.amazonaws.com/')
      || fixed.image.split('@')[1] !== envelope.service_image_digest) throw new Error('Task definition image binding failed');
    if (fixed.entryPoint !== undefined && (!Array.isArray(fixed.entryPoint) || fixed.entryPoint.length !== 0)) throw new Error('Task definition entrypoint was overridden');
    for (const field of ['environmentFiles', 'resourceRequirements']) {
      if (fixed[field] !== undefined && (!Array.isArray(fixed[field]) || (fixed[field] as unknown[]).length !== 0)) throw new Error('Task definition inert defaults changed');
    }
    const variables = array(fixed.environment, 'Definition environment').map(value => object(value, 'Environment value'));
    const variable = (name: string) => {
      const matches = variables.filter(entry => entry.name === name);
      if (matches.length !== 1 || typeof matches[0].value !== 'string' || !matches[0].value) throw new Error('Task source environment is absent or duplicated');
      return matches[0].value;
    };
    const command = array(fixed.command, 'Fixed command');
    const verification = isDeepStrictEqual(command, ['node', 'dist/verify.js']);
    if (!verification && !isDeepStrictEqual(command, ['node', 'dist/ops/beta-cleanup-operation.js'])) throw new Error('Task definition command is not the fixed cleanup capability');
    const prefix = verification ? 'beta-anywear-cleanup-verify' : 'beta-anywear-cleanup';
    const logs = object(fixed.logConfiguration, 'Task logs');
    const logOptions = object(logs.options, 'Task log options');
    if (DEFINITION_ARN.exec(task.taskDefinitionArn)?.[1] !== prefix
      || variable('SERVICE_COMMIT_SHA') !== envelope.service_commit_sha || variable('IMAGE_DIGEST') !== envelope.service_image_digest
      || logs.logDriver !== 'awslogs' || logOptions['awslogs-group'] !== LOG_GROUP || logOptions['awslogs-region'] !== 'ap-east-1'
      || logOptions['awslogs-stream-prefix'] !== prefix) throw new Error('Task definition source/fixed log binding failed');
    const overrides = exactObject(task.overrides, 'Task overrides', ['containerOverrides', 'inferenceAcceleratorOverrides', 'taskRoleArn', 'executionRoleArn', 'cpu', 'memory']);
    const accelerator = optionalArray(overrides.inferenceAcceleratorOverrides, 'Inference accelerator overrides');
    if (accelerator.length !== 0 || overrides.taskRoleArn !== undefined || overrides.executionRoleArn !== undefined
      || overrides.cpu !== undefined || overrides.memory !== undefined) throw new Error('Cleanup executable role/cpu/memory was overridden');
    const containerOverrides = optionalArray(overrides.containerOverrides, 'Container overrides');
    if (containerOverrides.length > 1) throw new Error('Cleanup has multiple container overrides');
    let envelopeHash: string | undefined;
    if (verification) {
      if (containerOverrides.length === 1) {
        const override = exactObject(containerOverrides[0], 'Verifier container override', ['name', 'command', 'environment', 'environmentFiles', 'resourceRequirements']);
        if (override.name !== 'OneShot' || override.environment !== undefined || override.environmentFiles !== undefined
          || override.resourceRequirements !== undefined || override.command !== undefined) throw new Error('Verifier executable override changed');
      }
    } else {
      if (containerOverrides.length !== 1) throw new Error('Cleanup command override is missing');
      const override = exactObject(containerOverrides[0], 'Cleanup container override', ['name', 'command', 'environment', 'environmentFiles', 'resourceRequirements']);
      const actual = array(override.command, 'Cleanup command');
      if (override.name !== 'OneShot' || actual.length !== 3 || actual[0] !== 'node' || actual[1] !== 'dist/ops/beta-cleanup-operation.js'
        || actual[2] !== JSON.stringify(envelope) || !isDeepStrictEqual(parseStrictJson(actual[2]), envelope)
        || optionalArray(override.environment, 'Cleanup environment').length !== 0
        || optionalArray(override.environmentFiles, 'Cleanup environment files').length !== 0
        || optionalArray(override.resourceRequirements, 'Cleanup resource requirements').length !== 0) throw new Error('Cleanup task override does not bind the original envelope');
      envelopeHash = hash(actual[2]);
    }
    return { task_arn: task.taskArn, task_definition_arn: task.taskDefinitionArn, kind: verification ? 'verification' : 'cleanup',
      status: 'STOPPED', exit_code: container.exitCode, image_digest: container.imageDigest, service_commit_sha: variable('SERVICE_COMMIT_SHA'),
      log_group: LOG_GROUP, log_stream: `${prefix}/OneShot/${TASK_ARN.exec(task.taskArn)![1]}`,
      proof_origin: 'live', snapshot_sha256: hash(options.snapshotText ?? JSON.stringify(task)),
      ...(envelopeHash ? { envelope_sha256: envelopeHash } : {}) };
  })();
}

export function createCleanupOperationEnvelope(inputs: ServiceCleanupInputs, environment: NodeJS.ProcessEnv = process.env): CleanupOperationEnvelope {
  if (inputs.action !== 'cleanup' || inputs.emails !== '[]') throw new Error('Unsupported Service cleanup action');
  if (Buffer.byteLength(inputs.cleanup_json, 'utf8') > 16_384) throw new Error('Cleanup request exceeds the Service limit');
  const request = object(parseStrictJson(inputs.cleanup_json), 'Cleanup request');
  if (JSON.stringify(request) !== inputs.cleanup_json) throw new Error('Cleanup request must preserve canonical producer JSON bytes');
  const users = array(request.users, 'Captured workers');
  if (Object.keys(request).sort().join(',') !== 'runScope,users'
    || typeof request.runScope !== 'string' || !RUN_SCOPE.test(request.runScope) || users.length < 1 || users.length > 8) {
    throw new Error('Cleanup request run scope or worker bound is invalid');
  }
  // Captured once, because the identity check below runs inside a callback and
  // the address must be bound to this request's own scope.
  const runScope = request.runScope;
  const identities = users.map(value => {
    const user = object(value, 'Captured worker');
    // This run's scoped Beta worker address, or a stable allowlist row a
    // pre-#129 manifest still captures. The Service's parser accepts the same
    // two families, so the reviewed request and the capability agree.
    if (Object.keys(user).sort().join(',') !== 'email,sub'
      || typeof user.email !== 'string' || !isBetaWorkerEmailForScope(user.email, runScope)
      || typeof user.sub !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(user.sub)) {
      throw new Error('Cleanup request requires exact captured worker subjects');
    }
    return user;
  });
  if (new Set(identities.map(user => user.email)).size !== users.length || new Set(identities.map(user => user.sub)).size !== users.length) {
    throw new Error('Cleanup request contains duplicate identities');
  }
  const source = environment.E2E_CLEANUP_SERVICE_SOURCE_SHA ?? environment.E2E_CLEANUP_SERVICE_SHA;
  const digest = environment.E2E_CLEANUP_SERVICE_IMAGE_DIGEST;
  if (!source || !SHA.test(source)) throw new Error('Reviewed cleanup source must be a full commit SHA');
  if (!digest || !DIGEST.test(digest)) throw new Error('Reviewed cleanup image must be an OCI digest');
  // The Service envelope keeps `operation_mode` (and its optional
  // `recovery_attempt`) because the Service validator requires the field. E2E
  // always submits the ordinary mode, and never submits an attempt.
  const envelope: CleanupOperationEnvelope = { schema_version: 1, operation_mode: 'normal',
    operation_id: `beta-tester-cleanup:${request.runScope}`, run_scope: request.runScope,
    request_sha256: hash(inputs.cleanup_json), service_commit_sha: source, service_image_digest: digest, cleanup_request: inputs.cleanup_json };
  const overrides = { ContainerOverrides: [{ Name: 'OneShot', Command: ['node', 'dist/ops/beta-cleanup-operation.js', JSON.stringify(envelope)] }] };
  if (Buffer.byteLength(JSON.stringify(overrides), 'utf8') > 8192) throw new Error('Cleanup envelope exceeds the ECS container override limit');
  return envelope;
}

/**
 * The two deterministic names of one captured scope: the base name and exactly
 * one retry. Nothing else is ever derived from the captured identities, so a
 * replay of the same scope can only land on generation 0 or generation 1.
 */
export function deterministicCleanupExecutionName(envelope: CleanupOperationEnvelope, generation = 0): string {
  if (!Number.isSafeInteger(generation) || generation < 0 || generation > MAX_GENERATIONS) throw new Error('Cleanup execution generation is invalid');
  const base = `beta-cleanup-${envelope.run_scope}-${envelope.request_sha256.slice(0, 16)}`;
  const name = generation === 0 ? base : `${base}-retry1`;
  if (name.length > 80) throw new Error('Cleanup execution name exceeds the Step Functions limit');
  return name;
}

export function cleanupExecutionArn(versionArn: string, name: string): string {
  if (!VERSION_ARN.test(versionArn) || !/^[A-Za-z0-9_-]{1,80}$/.test(name)) throw new Error('Cleanup requires the fixed Beta state-machine version ARN and execution name');
  return `${versionArn.replace(/:stateMachine:/, ':execution:').replace(/:[1-9][0-9]*$/, '')}:${name}`;
}

function validateDescription(description: DescribeExecutionOutput, envelope: CleanupOperationEnvelope, versionArn: string, name: string): void {
  if (description.executionArn !== cleanupExecutionArn(versionArn, name) || description.name !== name
    || description.stateMachineArn !== versionArn.replace(/:[1-9][0-9]*$/, '') || description.stateMachineVersionArn !== versionArn
    || description.input !== JSON.stringify(envelope) || description.inputDetails?.included !== true
    || !description.status || !['RUNNING', 'SUCCEEDED', ...TERMINAL_FAILURE].includes(description.status)) {
    throw new Error('Observed cleanup execution does not bind the exact input, name and immutable version');
  }
}

function validateResult(value: unknown, envelope: CleanupOperationEnvelope): CleanupOperationResult {
  const output = object(value, 'Cleanup task output');
  if (output.schema_version !== 1 || output.record_type !== 'anywear_beta_cleanup_tasks'
    || output.operation_id !== envelope.operation_id || output.request_sha256 !== envelope.request_sha256 || output.run_scope !== envelope.run_scope
    || output.service_commit_sha !== envelope.service_commit_sha || output.service_image_digest !== envelope.service_image_digest
    || output.cluster_arn !== CLUSTER || output.log_group_name !== LOG_GROUP) throw new Error('Cleanup task output has a foreign operation/artifact binding');
  for (const purpose of ['verification', 'cleanup']) {
    if (typeof output[`${purpose}_task_arn`] !== 'string' || !TASK_ARN.test(output[`${purpose}_task_arn`] as string)
      || typeof output[`${purpose}_task_definition_arn`] !== 'string' || !DEFINITION_ARN.test(output[`${purpose}_task_definition_arn`] as string)
      || output[`${purpose}_task_status`] !== 'STOPPED' || output[`${purpose}_exit_code`] !== 0
      || output[`${purpose}_log_stream_prefix`] !== (purpose === 'verification' ? 'beta-anywear-cleanup-verify' : 'beta-anywear-cleanup')) {
      throw new Error('Cleanup output lacks exact stopped successful task identities');
    }
  }
  if (output.verification_task_arn === output.cleanup_task_arn) throw new Error('Verification and cleanup must be distinct tasks');
  return output as unknown as CleanupOperationResult;
}

async function observeTask(io: CleanupOperationIo, envelope: CleanupOperationEnvelope, taskArn: string,
  expectedDefinition?: string, requireSuccess = true): Promise<Record<string, unknown>> {
  if (!TASK_ARN.test(taskArn)) throw new Error('Cleanup task ARN is outside the fixed Beta cluster');
  const response = object(await io.aws(['ecs', 'describe-tasks', '--cluster', CLUSTER, '--tasks', taskArn]), 'Observed cleanup tasks');
  const failures = array(response.failures, 'Task failures');
  const tasks = array(response.tasks, 'Tasks');
  const missingFailure = failures.length === 1 ? exactObject(failures[0], 'Task failure', ['arn', 'reason']) : undefined;
  const missing = tasks.length === 0 && failures.length === 1 && missingFailure?.arn === taskArn && missingFailure.reason === 'MISSING';
  if (missing) throw new Error('Cleanup task history fallback is unavailable');
  if (failures.length !== 0 || tasks.length !== 1) throw new Error('Cleanup task cannot be observed');
  const liveTask = mapLiveTask(tasks[0]);
  if (liveTask.taskArn !== taskArn) throw new Error('Observed ECS task differs from the submitted task identity');
  return validateCanonicalTask(liveTask, envelope, io, { expectedDefinition, requireSuccess, snapshotText: JSON.stringify(tasks[0]) });
}

function validateCommitted(value: unknown, envelope: CleanupOperationEnvelope): Record<string, unknown> {
  const result = object(value, 'Service committed result');
  const counters = ['users', 'missingUsers', 'tasks', 'outbox', 'idempotency', 'generations', 'relations', 'outfits', 'items', 'photos'];
  if (result.schema_version !== 1 || result.record_type !== 'anywear_beta_cleanup_result' || result.source !== 'beta-tester-cleanup'
    || result.cleanup !== 'beta-testers' || result.operation_id !== envelope.operation_id || result.request_sha256 !== envelope.request_sha256
    || result.run_scope !== envelope.run_scope || result.operation_mode !== envelope.operation_mode
    || result.recovery_attempt !== envelope.recovery_attempt || result.transaction_committed !== true
    || result.service_commit_sha !== envelope.service_commit_sha || result.service_image_digest !== envelope.service_image_digest
    || typeof result.envelope_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(result.envelope_sha256)
    || counters.some(key => !Number.isSafeInteger(result[key]) || (result[key] as number) < 0)
    || (result.users as number) + (result.missingUsers as number) !== (object(parseStrictJson(envelope.cleanup_request), 'Cleanup request').users as unknown[]).length) {
    throw new Error('Service completion marker lacks exact committed request/source proof');
  }
  const dlq = object(result.dlq, 'Preserved DLQ proof');
  if (!Number.isSafeInteger(dlq.deleted) || (dlq.deleted as number) < 0
    || !Number.isSafeInteger(dlq.preserved) || (dlq.preserved as number) < 0 || dlq.known_message !== undefined) {
    throw new Error('Cleanup lacks bounded DLQ counters or includes an unassigned diagnostic message');
  }
  return result;
}

async function readCommitted(io: CleanupOperationIo, proof: Record<string, unknown>, envelope: CleanupOperationEnvelope): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const markers: string[] = [];
    let token: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      let response: Record<string, unknown>;
      try {
        response = object(await io.aws(['logs', 'get-log-events', '--log-group-name', LOG_GROUP, '--log-stream-name', String(proof.log_stream),
          '--start-from-head', '--limit', '1000', ...(token ? ['--next-token', token] : [])]), 'Cleanup logs');
      } catch (error) {
        if (error instanceof Error && error.name === 'ResourceNotFoundException') break;
        throw error;
      }
      for (const event of array(response.events, 'Log events')) {
        const message = object(event, 'Log event').message;
        if (typeof message !== 'string') throw new Error('Cleanup log message is malformed');
        for (const line of message.split(/\r?\n/)) if (line.startsWith(MARKER)) markers.push(line.slice(MARKER.length));
      }
      if (markers.length > 1) throw new Error('Cleanup logs contain duplicate completion markers');
      if (typeof response.nextForwardToken !== 'string') throw new Error('Cleanup log pagination is incomplete');
      if (response.nextForwardToken === token) {
        if (markers.length === 1) {
          const result = validateCommitted(parseStrictJson(markers[0]), envelope);
          if (result.envelope_sha256 !== proof.envelope_sha256) throw new Error('Service completion does not bind the actual ECS envelope bytes');
          return result;
        }
        break;
      }
      if (page === 19) throw new Error('Cleanup log pagination exceeded its bounded proof window');
      token = response.nextForwardToken;
    }
    if (attempt < 14) await io.sleep(2_000);
  }
  throw new Error('Cleanup log completion marker was not observed within the bounded wait');
}

function defaultIo(versionArn: string): CleanupOperationIo {
  const client = new SFNClient({ region: 'ap-east-1' });
  return {
    async start(input, name) {
      const result = await client.send(new StartExecutionCommand({ stateMachineArn: versionArn, name, input: JSON.stringify(input) }));
      return { executionArn: result.executionArn };
    },
    describe: executionArn => client.send(new DescribeExecutionCommand({ executionArn }), { abortSignal: AbortSignal.timeout(15_000) }),
    async aws(args) {
      try {
        const { stdout } = await execute('aws', [...args, '--region', 'ap-east-1', '--output', 'json', '--no-cli-pager'],
          { timeout: 15_000, maxBuffer: 1024 * 1024, encoding: 'utf8', windowsHide: true });
        return parseStrictJson(stdout);
      } catch (error) {
        const sanitized = new Error('Cleanup read-only AWS evidence request failed');
        if (error && typeof error === 'object' && 'stderr' in error && /ResourceNotFoundException/.test(String(error.stderr))) sanitized.name = 'ResourceNotFoundException';
        throw sanitized;
      }
    },
    sleep: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  };
}

async function writeEvidence(path: string, evidence: CleanupOperationEvidence): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.tmp`, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  await rename(`${path}.tmp`, path);
}

function recordedEnvelope(value: unknown): CleanupOperationEnvelope {
  const input = object(value, 'Recorded cleanup envelope');
  // Owner evidence produced before `operation_mode` became mandatory may omit
  // that one field; it may not omit anything else or carry a replay attempt.
  const legacy = input.operation_mode === undefined && input.recovery_attempt === undefined;
  const expected = createCleanupOperationEnvelope({ action: 'cleanup', emails: '[]', cleanup_json: String(input.cleanup_request) }, {
    E2E_CLEANUP_SERVICE_SOURCE_SHA: String(input.service_commit_sha), E2E_CLEANUP_SERVICE_IMAGE_DIGEST: String(input.service_image_digest),
  });
  if (legacy) {
    const original = Object.fromEntries(Object.entries(expected).filter(([key]) => key !== 'operation_mode'));
    if (!isDeepStrictEqual(input, original)) throw new Error('Legacy owner envelope contains unknown or changed fields');
    // Keep the original input bytes/hash; the missing mode is tolerated only for
    // historical owner evidence, never for a new dispatch.
    return input as unknown as CleanupOperationEnvelope;
  }
  if (!isDeepStrictEqual(input, expected)) throw new Error('Recorded cleanup envelope is malformed');
  return expected;
}

function recordedOperation(value: unknown): CleanupOperationEvidence['operation'] {
  const evidence = object(value, 'Original owner evidence');
  const operation = object(evidence.operation, 'Original owner operation') as unknown as CleanupOperationEvidence['operation'];
  const input = recordedEnvelope(operation.input);
  if (evidence.schema_version !== 3 || evidence.record_type !== 'anywear_e2e_service_cleanup_operation'
    || operation.operation_mode !== input.operation_mode || operation.recovery_attempt !== input.recovery_attempt
    || operation.input_sha256 !== hash(JSON.stringify(input))
    || ![deterministicCleanupExecutionName(input, 0), deterministicCleanupExecutionName(input, 1)].includes(operation.execution_name)
    || operation.execution_arn !== cleanupExecutionArn(operation.state_machine_version_arn, operation.execution_name)) throw new Error('Original owner evidence has a foreign operation binding');
  return operation;
}

export function assertCleanupOwnerEvidence(value: unknown, cleanupRequest: string): CleanupOperationEvidence['operation'] {
  const operation = recordedOperation(value);
  if ((operation.operation_mode ?? 'normal') !== 'normal' || operation.input.cleanup_request !== cleanupRequest) throw new Error('Original owner evidence differs from captured canonical request');
  return operation;
}

/**
 * Resolve one deterministic execution name without starting anything. An absent
 * name is the start candidate; any other describe failure is a refusal, because
 * the entry point must never guess whether an execution exists.
 */
async function resolveExecution(io: CleanupOperationIo, arn: string, envelope: CleanupOperationEnvelope,
  versionArn: string, name: string): Promise<DescribeExecutionOutput | undefined> {
  try {
    const description = await io.describe(arn);
    validateDescription(description, envelope, versionArn, name);
    return description;
  } catch (error) {
    if (error instanceof Error && error.name === 'ExecutionDoesNotExist') return undefined;
    throw error;
  }
}

async function recordDescription(evidence: CleanupOperationEvidence, path: string, description: DescribeExecutionOutput): Promise<void> {
  evidence.operation.status = description.status!;
  evidence.operation.started_at = description.startDate?.toISOString();
  evidence.operation.stopped_at = description.stopDate?.toISOString();
  await writeEvidence(path, evidence);
}

/** Resume one execution: observe it until it is terminal, bounded to 900 observations. */
async function awaitTerminal(io: CleanupOperationIo, arn: string, envelope: CleanupOperationEnvelope, versionArn: string,
  name: string, evidence: CleanupOperationEvidence, path: string, initial?: DescribeExecutionOutput): Promise<DescribeExecutionOutput> {
  let description = initial;
  let last: DescribeExecutionOutput | undefined;
  for (let observation = 0; observation < 900; observation += 1) {
    if (!description) description = await io.describe(arn);
    validateDescription(description, envelope, versionArn, name);
    last = description;
    await recordDescription(evidence, path, description);
    if (description.status === 'SUCCEEDED' || TERMINAL_FAILURE.includes(description.status!)) return description;
    await io.sleep(2_000);
    description = undefined;
  }
  // Every observation was RUNNING: report the last one so the caller refuses
  // with the execution identity it actually observed.
  return last!;
}

/**
 * The one bounded predecessor check. One inventory pass over the three cleanup
 * task families asks ECS for `RUNNING`-desired tasks only; a returned task means
 * the cleanup family may still be working, so the next generation cannot start.
 */
async function cleanupFamiliesStopped(io: CleanupOperationIo): Promise<string[]> {
  const families: string[] = [];
  for (const family of CLEANUP_FAMILIES) {
    const rows: unknown[] = [];
    const tokens = new Set<string>();
    let token: string | undefined;
    let complete = false;
    for (let page = 0; page < 10; page += 1) {
      const response = object(await io.aws(['ecs', 'list-tasks', '--cluster', CLUSTER, '--family', family,
        '--desired-status', 'RUNNING', '--max-results', '100', '--no-paginate', ...(token ? ['--next-token', token] : [])]),
      'Cleanup family inventory');
      const taskArns = array(response.taskArns, 'Cleanup family tasks');
      if (taskArns.length > 100 || rows.length + taskArns.length > 1000) throw new Error('Cleanup family inventory exceeds its bound');
      rows.push(...taskArns);
      if (response.nextToken === undefined) { complete = true; break; }
      if (typeof response.nextToken !== 'string' || !response.nextToken || tokens.has(response.nextToken)) {
        throw new Error('Cleanup family inventory pagination is incomplete or repeated');
      }
      tokens.add(response.nextToken);
      token = response.nextToken;
    }
    if (!complete) throw new Error('Cleanup family inventory pagination exceeds its bound');
    for (const arn of rows) {
      if (typeof arn !== 'string' || !TASK_ARN.test(arn)) throw new Error('Cleanup family inventory contains a foreign task');
    }
    if (rows.length !== 0) throw new Error('Cleanup family still has RUNNING tasks; the next generation is refused');
    families.push(family);
  }
  return families;
}

/**
 * Start or resume the deterministic cleanup operation for one captured run
 * scope.
 *
 * The rule is the same for qualification and recovery dispatch: resolve
 * generation 0, resume it while it runs, verify it when it succeeded, and start
 * generation 1 only after generation 0 is terminal non-success and exactly one
 * bounded predecessor check (its describe plus one cleanup-family inventory)
 * shows the cleanup families stopped. If generation 1 already exists it is
 * resumed or verified; if it is already terminal the dispatch refuses and
 * starts nothing. At most two deterministic names exist per captured scope.
 */
export async function runCleanupOperation(inputs: ServiceCleanupInputs, environment: NodeJS.ProcessEnv = process.env,
  io?: CleanupOperationIo): Promise<CleanupOperationEvidence | undefined> {
  const versionArn = environment.BETA_CLEANUP_STATE_MACHINE_VERSION_ARN;
  if (!versionArn) {
    console.warn('Beta cleanup capability is not configured; cleanup deferred and identities retained');
    return undefined;
  }
  const envelope = createCleanupOperationEnvelope(inputs, environment);
  const names = [deterministicCleanupExecutionName(envelope, 0), deterministicCleanupExecutionName(envelope, 1)];
  const arns = names.map(name => cleanupExecutionArn(versionArn, name));
  const originalPath = environment.E2E_CLEANUP_ORIGINAL_EVIDENCE_PATH;
  if (originalPath) {
    const original = object(parseStrictJson(await readFile(originalPath)), 'Original cleanup evidence');
    const operation = object(original.operation, 'Original cleanup operation');
    if (![2, 3].includes(original.schema_version as number) || original.record_type !== 'anywear_e2e_service_cleanup_operation'
      || (operation.operation_mode ?? 'normal') !== 'normal'
      || operation.state_machine_version_arn !== versionArn || !isDeepStrictEqual(operation.input, envelope)
      || operation.input_sha256 !== hash(JSON.stringify(envelope))
      || !names.includes(String(operation.execution_name))
      || operation.execution_arn !== cleanupExecutionArn(versionArn, String(operation.execution_name))) throw new Error('Original cleanup evidence does not bind this exact request/source/version');
  }
  const transport = io ?? defaultIo(versionArn);
  const path = environment.E2E_SERVICE_CLEANUP_EVIDENCE_PATH ?? 'test-results/service-cleanup-operation.json';
  const evidence: CleanupOperationEvidence = { schema_version: 3, record_type: 'anywear_e2e_service_cleanup_operation',
    operation: { operation_mode: 'normal', state_machine_version_arn: versionArn, execution_arn: arns[0], execution_name: names[0],
      status: 'PENDING', proof_status: 'pending', input_sha256: hash(JSON.stringify(envelope)), input: envelope } };
  let refusalPhase: CleanupRefusalPhase = 'operation_start';
  let refusalCategory: CleanupRefusalCategory = 'operation_start_unavailable';
  const target = (generation: number) => {
    evidence.operation.execution_name = names[generation];
    evidence.operation.execution_arn = arns[generation];
    evidence.operation.status = 'PENDING';
    evidence.operation.started_at = undefined;
    evidence.operation.stopped_at = undefined;
  };
  const start = async () => {
    await writeEvidence(path, evidence);
    try {
      const started = await transport.start(envelope, evidence.operation.execution_name);
      if (started.executionArn && started.executionArn !== evidence.operation.execution_arn) throw new Error('Cleanup start returned a foreign execution ARN');
    } catch (error) {
      if (!(error instanceof Error) || !['ExecutionAlreadyExists', 'TimeoutError', 'RequestTimeout', 'NetworkingError', 'InternalServerError', 'ServiceUnavailable'].includes(error.name)) throw error;
      // The exact resolution below settles a completed name or a lost response.
    }
  };
  try {
    // Generation 0: resolve, start only when absent, then resume or verify it.
    refusalPhase = 'execution_observation';
    refusalCategory = 'execution_observation_unavailable';
    let description = await resolveExecution(transport, arns[0], envelope, versionArn, names[0]);
    if (!description) {
      refusalPhase = 'operation_start';
      refusalCategory = 'operation_start_unavailable';
      await start();
      refusalPhase = 'execution_observation';
      refusalCategory = 'execution_observation_unavailable';
      description = await awaitTerminal(transport, arns[0], envelope, versionArn, names[0], evidence, path);
    } else if (description.status === 'RUNNING') {
      description = await awaitTerminal(transport, arns[0], envelope, versionArn, names[0], evidence, path, description);
    } else {
      await recordDescription(evidence, path, description);
    }
    if (description.status !== 'SUCCEEDED') {
      if (description.status === 'RUNNING') {
        refusalPhase = 'execution_observation';
        refusalCategory = 'execution_not_succeeded';
        throw new Error('Cleanup execution did not reach a terminal state within the bounded wait');
      }
      // Generation 0 is terminal non-success. One bounded predecessor check
      // (its describe above plus this single inventory pass) gates generation 1.
      refusalPhase = 'retry_proof';
      refusalCategory = 'retry_proof_unavailable';
      const families = await cleanupFamiliesStopped(transport);
      evidence.operation.preceding_execution = { execution_arn: description.executionArn!, status: description.status!,
        ...(description.stopDate ? { stopped_at: description.stopDate.toISOString() } : {}), cleanup_families: families };
      await writeEvidence(path, evidence);
      target(1);
      refusalPhase = 'execution_observation';
      refusalCategory = 'execution_observation_unavailable';
      let retry = await resolveExecution(transport, arns[1], envelope, versionArn, names[1]);
      if (!retry) {
        refusalPhase = 'operation_start';
        refusalCategory = 'operation_start_unavailable';
        await start();
        refusalPhase = 'execution_observation';
        refusalCategory = 'execution_observation_unavailable';
        retry = await awaitTerminal(transport, arns[1], envelope, versionArn, names[1], evidence, path);
      } else if (retry.status === 'RUNNING') {
        retry = await awaitTerminal(transport, arns[1], envelope, versionArn, names[1], evidence, path, retry);
      } else {
        await recordDescription(evidence, path, retry);
      }
      if (retry.status === 'RUNNING') {
        refusalPhase = 'execution_observation';
        refusalCategory = 'execution_not_succeeded';
        throw new Error('Cleanup retry did not reach a terminal state within the bounded wait');
      }
      if (retry.status !== 'SUCCEEDED') {
        refusalPhase = 'retry_eligibility';
        refusalCategory = 'retry_not_authorized';
        throw new Error('Cleanup retry already exists and is terminal; no third execution is started');
      }
      description = retry;
    }
    refusalPhase = 'execution_observation';
    refusalCategory = 'execution_not_succeeded';
    if (!description.output || description.outputDetails?.included !== true) throw new Error('Cleanup did not expose complete terminal success');
    refusalPhase = 'result_proof';
    refusalCategory = 'result_proof_unavailable';
    const output = validateResult(parseStrictJson(description.output), envelope);
    evidence.operation.output = output;
    await writeEvidence(path, evidence);
    refusalPhase = 'task_proof';
    refusalCategory = 'task_proof_unavailable';
    const verification = await observeTask(transport, envelope, output.verification_task_arn, output.verification_task_definition_arn);
    const cleanup = await observeTask(transport, envelope, output.cleanup_task_arn, output.cleanup_task_definition_arn);
    if (verification.kind !== 'verification' || cleanup.kind !== 'cleanup') throw new Error('Cleanup tasks exchanged their fixed purposes');
    evidence.operation.tasks = [verification, cleanup];
    await writeEvidence(path, evidence);
    refusalPhase = 'completion_proof';
    refusalCategory = 'completion_proof_unavailable';
    evidence.operation.committed_result = await readCommitted(transport, cleanup, envelope);
    evidence.operation.proof_status = 'verified';
    await writeEvidence(path, evidence);
    return evidence;
  } catch {
    evidence.operation.proof_status = 'refused';
    evidence.operation.failure = 'Exact execution/task/committed-result proof unavailable; Cognito identities retained';
    evidence.operation.refusal_phase = refusalPhase;
    evidence.operation.refusal_category = refusalCategory;
    await writeEvidence(path, evidence);
    throw new Error(evidence.operation.failure);
  }
}
