import { DescribeExecutionCommand, SFNClient, StartExecutionCommand, type DescribeExecutionOutput } from '@aws-sdk/client-sfn';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isDeepStrictEqual, promisify } from 'node:util';
import { parseStrictJson } from '../../scripts/evidence-contract.mjs';
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
const execute = promisify(execFile);

type CleanupRefusalPhase = 'operation_start' | 'execution_observation' | 'retry_eligibility' | 'retry_proof'
  | 'result_proof' | 'task_proof' | 'completion_proof';
type CleanupRefusalCategory = 'operation_start_unavailable' | 'execution_observation_unavailable' | 'retry_not_authorized'
  | 'retry_proof_unavailable' | 'execution_not_succeeded' | 'result_proof_unavailable' | 'task_proof_unavailable'
  | 'completion_proof_unavailable';

export interface CleanupOperationEnvelope {
  schema_version: 1;
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
    preceding_execution?: { execution_arn: string; status: string; stopped_tasks: string[]; task_proofs?: Record<string, unknown>[]; log_snapshot_sha256?: string };
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

function hash(text: string): string { return createHash('sha256').update(text, 'utf8').digest('hex'); }
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
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
  const identities = users.map(value => {
    const user = object(value, 'Captured worker');
    if (Object.keys(user).sort().join(',') !== 'email,sub'
      || typeof user.email !== 'string' || !/^e2e-beta-worker-[0-7]-chromium@anywear\.local$/.test(user.email)
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
  const envelope: CleanupOperationEnvelope = { schema_version: 1, operation_id: `beta-tester-cleanup:${request.runScope}`, run_scope: request.runScope,
    request_sha256: hash(inputs.cleanup_json), service_commit_sha: source, service_image_digest: digest, cleanup_request: inputs.cleanup_json };
  const overrides = { ContainerOverrides: [{ Name: 'OneShot', Command: ['node', 'dist/ops/beta-cleanup-operation.js', JSON.stringify(envelope)] }] };
  if (Buffer.byteLength(JSON.stringify(overrides), 'utf8') > 8192) throw new Error('Cleanup envelope exceeds the ECS container override limit');
  return envelope;
}

export function deterministicCleanupExecutionName(envelope: CleanupOperationEnvelope): string {
  const name = `beta-cleanup-${envelope.run_scope}-${envelope.request_sha256.slice(0, 16)}`;
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
  if (array(response.failures, 'Task failures').length !== 0) throw new Error('Cleanup task cannot be observed');
  const tasks = array(response.tasks, 'Tasks');
  const task = object(tasks[0], 'Exact task');
  if (tasks.length !== 1 || task.taskArn !== taskArn || task.clusterArn !== CLUSTER || task.lastStatus !== 'STOPPED'
    || typeof task.taskDefinitionArn !== 'string' || !DEFINITION_ARN.test(task.taskDefinitionArn)
    || (expectedDefinition && task.taskDefinitionArn !== expectedDefinition)) throw new Error('Cleanup task has not stopped under the exact definition');
  const containers = array(task.containers, 'Task containers');
  const container = object(containers[0], 'OneShot task');
  if (containers.length !== 1 || container.name !== 'OneShot' || container.lastStatus !== 'STOPPED'
    || !Number.isInteger(container.exitCode) || (requireSuccess && container.exitCode !== 0)
    || container.imageDigest !== envelope.service_image_digest) throw new Error('OneShot task image/status/exit proof failed');
  const definitionResponse = object(await io.aws(['ecs', 'describe-task-definition', '--task-definition', task.taskDefinitionArn]), 'Task definition response');
  const definition = object(definitionResponse.taskDefinition, 'Task definition');
  const definitions = array(definition.containerDefinitions, 'Definition containers');
  const fixed = object(definitions[0], 'Fixed OneShot definition');
  const variables = array(fixed.environment, 'Definition environment').map(value => object(value, 'Environment value'));
  const variable = (name: string) => {
    const matches = variables.filter(entry => entry.name === name);
    if (matches.length !== 1) throw new Error('Task source environment is absent or duplicated');
    return matches[0].value;
  };
  const command = array(fixed.command, 'Fixed command');
  const verification = isDeepStrictEqual(command, ['node', 'dist/verify.js']);
  if (!verification && !isDeepStrictEqual(command, ['node', 'dist/ops/beta-cleanup-operation.js'])) throw new Error('Task definition command is not the fixed cleanup capability');
  const prefix = verification ? 'beta-anywear-cleanup-verify' : 'beta-anywear-cleanup';
  const logs = object(fixed.logConfiguration, 'Task logs');
  const options = object(logs.options, 'Task log options');
  if (definition.taskDefinitionArn !== task.taskDefinitionArn || DEFINITION_ARN.exec(task.taskDefinitionArn)?.[1] !== prefix
    || definitions.length !== 1 || fixed.name !== 'OneShot'
    || typeof fixed.image !== 'string' || !fixed.image.startsWith('650880818323.dkr.ecr.ap-east-1.amazonaws.com/')
    || fixed.image.split('@')[1] !== envelope.service_image_digest
    || variable('SERVICE_COMMIT_SHA') !== envelope.service_commit_sha || variable('IMAGE_DIGEST') !== envelope.service_image_digest
    || logs.logDriver !== 'awslogs' || options['awslogs-group'] !== LOG_GROUP || options['awslogs-region'] !== 'ap-east-1'
    || options['awslogs-stream-prefix'] !== prefix) throw new Error('Task definition source/image/fixed log binding failed');
  const overrides = object(task.overrides, 'Task overrides');
  const overridden = array(overrides.containerOverrides, 'Container overrides');
  if (overrides.taskRoleArn || overrides.executionRoleArn || overrides.inferenceAcceleratorOverrides
    || (fixed.entryPoint !== undefined && !isDeepStrictEqual(fixed.entryPoint, []))) throw new Error('Cleanup executable role/entrypoint was overridden');
  let envelopeHash: string | undefined;
  if (verification) {
    if (overridden.length !== 0 && !(overridden.length === 1 && isDeepStrictEqual(overridden[0], { name: 'OneShot' }))) {
      throw new Error('Verification task must not override executable inputs');
    }
  } else {
    const override = object(overridden[0], 'Cleanup override');
    const actual = array(override.command, 'Cleanup command');
    if (overridden.length !== 1 || Object.keys(override).sort().join(',') !== 'command,name' || override.name !== 'OneShot'
      || actual.length !== 3 || actual[0] !== 'node' || actual[1] !== 'dist/ops/beta-cleanup-operation.js'
      || typeof actual[2] !== 'string' || !isDeepStrictEqual(parseStrictJson(actual[2]), envelope)) throw new Error('Cleanup task override does not bind the original envelope');
    envelopeHash = hash(actual[2]);
  }
  return { task_arn: taskArn, task_definition_arn: task.taskDefinitionArn, kind: verification ? 'verification' : 'cleanup',
    status: 'STOPPED', exit_code: container.exitCode, image_digest: container.imageDigest, service_commit_sha: variable('SERVICE_COMMIT_SHA'),
    log_group: LOG_GROUP, log_stream: `${prefix}/OneShot/${TASK_ARN.exec(taskArn)![1]}`, ...(envelopeHash ? { envelope_sha256: envelopeHash } : {}) };
}

function validateCommitted(value: unknown, envelope: CleanupOperationEnvelope): Record<string, unknown> {
  const result = object(value, 'Service committed result');
  const counters = ['users', 'missingUsers', 'tasks', 'outbox', 'idempotency', 'generations', 'relations', 'outfits', 'items', 'photos'];
  if (result.schema_version !== 1 || result.record_type !== 'anywear_beta_cleanup_result' || result.source !== 'beta-tester-cleanup'
    || result.cleanup !== 'beta-testers' || result.operation_id !== envelope.operation_id || result.request_sha256 !== envelope.request_sha256
    || result.run_scope !== envelope.run_scope || result.transaction_committed !== true
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

async function proveStoppedExecution(io: CleanupOperationIo, arn: string, envelope: CleanupOperationEnvelope): Promise<string[]> {
  const history = object(await io.aws(['stepfunctions', 'get-execution-history', '--execution-arn', arn, '--max-results', '1000', '--no-paginate']), 'Execution history');
  if (history.nextToken) throw new Error('Prior execution history is incomplete; retry refused');
  const events = array(history.events, 'Execution events').map(value => object(value, 'Execution event'));
  const begun = events.filter(event => event.type === 'ExecutionStarted');
  const begunDetails = object(begun[0]?.executionStartedEventDetails, 'Prior execution input');
  if (begun.length !== 1 || begunDetails.input !== JSON.stringify(envelope)
    || object(begunDetails.inputDetails, 'Prior input completeness').truncated !== false
    || !events.some(event => ['ExecutionFailed', 'ExecutionTimedOut', 'ExecutionAborted'].includes(String(event.type)))
    || events.some(event => event.type === 'ExecutionRedriven')) throw new Error('Prior terminal execution history does not bind the exact request');
  const scheduled = events.filter(event => event.type === 'TaskScheduled');
  const submitted = events.filter(event => event.type === 'TaskSubmitted');
  if (scheduled.length !== submitted.length || scheduled.length > 2) throw new Error('Prior task launch/cessation is unknown; retry refused');
  for (const event of scheduled) {
    const details = object(event.taskScheduledEventDetails, 'Scheduled task details');
    if (details.resourceType !== 'ecs' || details.resource !== 'runTask.sync') throw new Error('Prior scheduled task is outside the fixed capability');
  }
  const arns = submitted.map(event => {
    const details = object(event.taskSubmittedEventDetails, 'Submitted task details');
    if (object(details.outputDetails, 'Submitted output completeness').truncated !== false) throw new Error('Prior task launch data is truncated; retry refused');
    const output = object(parseStrictJson(String(details.output)), 'Submitted task output');
    const tasks = array(output.Tasks, 'Submitted ECS tasks');
    const task = object(tasks[0], 'Submitted ECS task');
    if (details.resourceType !== 'ecs' || details.resource !== 'runTask.sync' || tasks.length !== 1
      || array(output.Failures, 'Submitted task failures').length !== 0 || typeof task.TaskArn !== 'string') {
      throw new Error('Prior task launch proof is not the fixed ECS capability');
    }
    return task.TaskArn;
  });
  if (new Set(arns).size !== arns.length) throw new Error('Prior task launch identities are duplicated');
  for (const taskArn of arns) await observeTask(io, envelope, taskArn, undefined, false);
  return arns;
}

function defaultIo(versionArn: string): CleanupOperationIo {
  const client = new SFNClient({ region: 'ap-east-1' });
  return {
    async start(input, name) {
      const result = await client.send(new StartExecutionCommand({ stateMachineArn: versionArn, name, input: JSON.stringify(input) }));
      return { executionArn: result.executionArn };
    },
    describe: executionArn => client.send(new DescribeExecutionCommand({ executionArn })),
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

export async function observeFailedCleanupOperation(inputs: ServiceCleanupInputs, environment: NodeJS.ProcessEnv = process.env,
  io?: CleanupOperationIo): Promise<Record<string, unknown>> {
  const envelope = createCleanupOperationEnvelope(inputs, environment);
  const versionArn = environment.BETA_CLEANUP_STATE_MACHINE_VERSION_ARN!;
  const name = deterministicCleanupExecutionName(envelope);
  const arn = cleanupExecutionArn(versionArn, name);
  const transport = io ?? defaultIo(versionArn);
  const description = await transport.describe(arn);
  validateDescription(description, envelope, versionArn, name);
  if (description.status !== 'FAILED' || !description.startDate || !description.stopDate) throw new Error('Expected refusal lacks exact terminal failure');
  const arns = await proveStoppedExecution(transport, arn, envelope);
  const tasks = await Promise.all(arns.map(task => observeTask(transport, envelope, task, undefined, false)));
  const verification = tasks.filter(task => task.kind === 'verification');
  const cleanup = tasks.filter(task => task.kind === 'cleanup');
  if (tasks.length !== 2 || verification.length !== 1 || cleanup.length !== 1
    || verification[0].exit_code !== 0 || cleanup[0].exit_code === 0) throw new Error('Refusal needs a successful verifier and exact stopped failed cleanup');
  const snapshots: string[] = [];
  for (let scan = 0; scan < 2; scan += 1) {
    const events: unknown[] = [];
    let token: string | undefined;
    let complete = false;
    for (let page = 0; page < 20; page += 1) {
      const response = object(await transport.aws(['logs', 'get-log-events', '--log-group-name', LOG_GROUP,
        '--log-stream-name', String(cleanup[0].log_stream), '--start-from-head', '--limit', '1000', ...(token ? ['--next-token', token] : [])]), 'Refusal logs');
      const pageEvents = array(response.events, 'Refusal events');
      if (pageEvents.length > 1000 || events.length + pageEvents.length > 4096) throw new Error('Refusal log inventory exceeds bound');
      for (const value of pageEvents) {
        const event = object(value, 'Refusal event');
        if (typeof event.message !== 'string' || event.message.length > 262144 || event.message.includes(MARKER)) throw new Error('Refused cleanup exposes a committed marker or malformed log');
        events.push(event);
      }
      if (typeof response.nextForwardToken !== 'string') throw new Error('Refusal log pagination is incomplete');
      if (response.nextForwardToken === token) { complete = true; break; }
      token = response.nextForwardToken;
    }
    if (!complete || events.length === 0) throw new Error('Refusal log proof unavailable');
    snapshots.push(hash(JSON.stringify(events)));
    if (scan === 0) await transport.sleep(2_000);
  }
  if (snapshots[0] !== snapshots[1]) throw new Error('Refusal logs changed during observation');
  return { schema_version: 1, record_type: 'anywear_e2e_cleanup_refusal_proof', execution_arn: arn,
    started_at: description.startDate.toISOString(), stopped_at: description.stopDate.toISOString(), status: 'FAILED',
    input_sha256: hash(JSON.stringify(envelope)), tasks, committed_marker_observed: false, log_snapshot_sha256: snapshots[0] };
}

export async function prepareCleanupRetryIntent(inputs: ServiceCleanupInputs, original: CleanupOperationEvidence,
  environment: NodeJS.ProcessEnv = process.env, io?: CleanupOperationIo): Promise<CleanupOperationEvidence> {
  const envelope = createCleanupOperationEnvelope(inputs, environment);
  const versionArn = environment.BETA_CLEANUP_STATE_MACHINE_VERSION_ARN!;
  const name = deterministicCleanupExecutionName(envelope);
  if (original.schema_version !== 3 || original.record_type !== 'anywear_e2e_service_cleanup_operation'
    || original.operation.state_machine_version_arn !== versionArn || original.operation.execution_name !== name
    || original.operation.execution_arn !== cleanupExecutionArn(versionArn, name)
    || original.operation.input_sha256 !== hash(JSON.stringify(envelope)) || !isDeepStrictEqual(original.operation.input, envelope)
    || original.operation.status !== 'FAILED' || original.operation.proof_status !== 'refused') throw new Error('Retry intent lacks the exact original refused operation');
  const proof = await observeFailedCleanupOperation(inputs, environment, io);
  const retryName = `${name.slice(0, 72)}-retry1`;
  return { schema_version: 3, record_type: 'anywear_e2e_service_cleanup_operation', operation: {
    state_machine_version_arn: versionArn, execution_name: retryName, execution_arn: cleanupExecutionArn(versionArn, retryName),
    input: envelope, input_sha256: hash(JSON.stringify(envelope)), status: 'PENDING', proof_status: 'pending',
    preceding_execution: { execution_arn: String(proof.execution_arn), status: 'FAILED', task_proofs: proof.tasks as Record<string, unknown>[],
      log_snapshot_sha256: String(proof.log_snapshot_sha256),
      stopped_tasks: (proof.tasks as Record<string, unknown>[]).map(task => String(task.task_arn)) },
  } };
}

export async function submitCleanupRetryIntent(evidence: CleanupOperationEvidence, environment: NodeJS.ProcessEnv = process.env,
  start?: (input: CleanupOperationEnvelope, name: string) => Promise<{ executionArn?: string; startDate?: Date }>): Promise<{ execution_arn: string; started_at: string; submitted_at: string }> {
  const operation = evidence.operation;
  const versionArn = environment.BETA_CLEANUP_STATE_MACHINE_VERSION_ARN!;
  const base = deterministicCleanupExecutionName(operation.input);
  const expectedInput = createCleanupOperationEnvelope({ action: 'cleanup', emails: '[]', cleanup_json: operation.input.cleanup_request }, environment);
  if (evidence.schema_version !== 3 || operation.proof_status !== 'pending' || operation.status !== 'PENDING'
    || operation.state_machine_version_arn !== versionArn || operation.execution_name !== `${base.slice(0, 72)}-retry1`
    || operation.execution_arn !== cleanupExecutionArn(versionArn, operation.execution_name)
    || operation.preceding_execution?.execution_arn !== cleanupExecutionArn(versionArn, base)
    || operation.preceding_execution.status !== 'FAILED' || operation.preceding_execution.stopped_tasks.length !== 2
    || new Set(operation.preceding_execution.stopped_tasks).size !== 2 || operation.preceding_execution.stopped_tasks.some(arn => !TASK_ARN.test(arn))
    || !isDeepStrictEqual(operation.input, expectedInput)
    || operation.input_sha256 !== hash(JSON.stringify(operation.input))) throw new Error('Submit requires the exact stopped-failure retry intent');
  const client = new SFNClient({ region: 'ap-east-1', maxAttempts: 1 });
  try {
    const result = await (start ? start(operation.input, operation.execution_name)
      : client.send(new StartExecutionCommand({ stateMachineArn: versionArn, name: operation.execution_name, input: JSON.stringify(operation.input) })));
    if (result.executionArn !== operation.execution_arn || !result.startDate || !Number.isFinite(result.startDate.getTime())) throw new Error('Retry submit did not return authenticated exact ARN/start time');
    return { execution_arn: result.executionArn, started_at: result.startDate.toISOString(), submitted_at: new Date().toISOString() };
  } finally { client.destroy(); }
}

export async function observeSubmittedCleanupOperation(evidence: CleanupOperationEvidence, environment: NodeJS.ProcessEnv = process.env,
  io?: CleanupOperationIo): Promise<Record<string, unknown>> {
  const operation = evidence.operation;
  const versionArn = environment.BETA_CLEANUP_STATE_MACHINE_VERSION_ARN!;
  const transport = io ?? defaultIo(versionArn);
  const description = await transport.describe(operation.execution_arn);
  validateDescription(description, operation.input, versionArn, operation.execution_name);
  if (!['RUNNING', 'SUCCEEDED'].includes(description.status!) || description.startDate?.toISOString() !== operation.started_at) throw new Error('Original submitted execution is unavailable or changed');
  const history = object(await transport.aws(['stepfunctions', 'get-execution-history', '--execution-arn', operation.execution_arn,
    '--max-results', '1000', '--no-paginate']), 'Submitted history');
  if (history.nextToken) throw new Error('Original submitted history is incomplete');
  const events = array(history.events, 'Submitted events').map(event => object(event, 'Submitted event'));
  const terminal = events.filter(event => ['ExecutionFailed', 'ExecutionTimedOut', 'ExecutionAborted', 'ExecutionSucceeded'].includes(String(event.type)));
  if (description.status === 'RUNNING' ? terminal.length !== 0 : terminal.length !== 1 || terminal[0].type !== 'ExecutionSucceeded') throw new Error('Original submitted terminal history changed');
  const scheduledTasks = events.filter(event => event.type === 'TaskScheduled');
  if (scheduledTasks.length > 2 || scheduledTasks.some(event => {
    const details = object(event.taskScheduledEventDetails, 'Submitted schedule');
    return details.resourceType !== 'ecs' || details.resource !== 'runTask.sync';
  })) throw new Error('Original scheduled capability changed');
  const begun = events.filter(event => event.type === 'ExecutionStarted');
  const details = object(begun[0]?.executionStartedEventDetails, 'Submitted input');
  if (begun.length !== 1 || details.input !== JSON.stringify(operation.input)
    || object(details.inputDetails, 'Submitted completeness').truncated !== false || events.some(event => event.type === 'ExecutionRedriven')) throw new Error('Original submitted input/history changed');
  const tasks = events.filter(event => event.type === 'TaskSubmitted').map(event => {
    const value = object(event.taskSubmittedEventDetails, 'Submitted task');
    if (value.resourceType !== 'ecs' || value.resource !== 'runTask.sync'
      || object(value.outputDetails, 'Submitted task completeness').truncated !== false) throw new Error('Original task submission is unknown');
    const output = object(parseStrictJson(String(value.output)), 'Submitted task output');
    const rows = array(output.Tasks, 'Submitted task rows');
    const task = object(rows[0], 'Submitted task identity');
    if (rows.length !== 1 || array(output.Failures, 'Submitted task errors').length !== 0
      || typeof task.TaskArn !== 'string' || !TASK_ARN.test(task.TaskArn)) throw new Error('Original submitted task identity unavailable');
    return task.TaskArn;
  });
  if (tasks.length > scheduledTasks.length || tasks.length > 2 || new Set(tasks).size !== tasks.length
    || (description.status === 'SUCCEEDED' && (tasks.length !== 2 || scheduledTasks.length !== 2))) throw new Error('Original task submission inventory changed');
  return { execution_arn: operation.execution_arn, started_at: operation.started_at, status: description.status, task_arns: tasks };
}

async function writeEvidence(path: string, evidence: CleanupOperationEvidence): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.tmp`, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  await rename(`${path}.tmp`, path);
}

export async function runCleanupOperation(inputs: ServiceCleanupInputs, environment: NodeJS.ProcessEnv = process.env, io?: CleanupOperationIo): Promise<CleanupOperationEvidence | undefined> {
  const versionArn = environment.BETA_CLEANUP_STATE_MACHINE_VERSION_ARN;
  if (!versionArn) {
    console.warn('Beta cleanup capability is not configured; cleanup deferred and identities retained');
    return undefined;
  }
  const envelope = createCleanupOperationEnvelope(inputs, environment);
  let name = deterministicCleanupExecutionName(envelope);
  cleanupExecutionArn(versionArn, name);
  const originalPath = environment.E2E_CLEANUP_ORIGINAL_EVIDENCE_PATH;
  if (originalPath) {
    const original = object(parseStrictJson(await readFile(originalPath)), 'Original cleanup evidence');
    const operation = object(original.operation, 'Original cleanup operation');
    const retryName = `${name.slice(0, 72)}-retry1`;
    if (![2, 3].includes(original.schema_version as number) || original.record_type !== 'anywear_e2e_service_cleanup_operation'
      || operation.state_machine_version_arn !== versionArn || !isDeepStrictEqual(operation.input, envelope)
      || operation.input_sha256 !== hash(JSON.stringify(envelope)) || ![name, retryName].includes(String(operation.execution_name))
      || operation.execution_arn !== cleanupExecutionArn(versionArn, String(operation.execution_name))) throw new Error('Original cleanup evidence does not bind this exact request/source/version');
  }
  const transport = io ?? defaultIo(versionArn);
  const path = environment.E2E_SERVICE_CLEANUP_EVIDENCE_PATH ?? 'test-results/service-cleanup-operation.json';
  const evidence: CleanupOperationEvidence = { schema_version: 3, record_type: 'anywear_e2e_service_cleanup_operation',
    operation: { state_machine_version_arn: versionArn, execution_arn: cleanupExecutionArn(versionArn, name), execution_name: name,
      status: 'PENDING', proof_status: 'pending', input_sha256: hash(JSON.stringify(envelope)), input: envelope } };
  let refusalPhase: CleanupRefusalPhase = 'operation_start';
  let refusalCategory: CleanupRefusalCategory = 'operation_start_unavailable';
  const start = async () => {
    await writeEvidence(path, evidence);
    try {
      const started = await transport.start(envelope, name);
      if (started.executionArn && started.executionArn !== evidence.operation.execution_arn) throw new Error('Cleanup start returned a foreign execution ARN');
    } catch (error) {
      if (!(error instanceof Error) || !['ExecutionAlreadyExists', 'TimeoutError', 'RequestTimeout', 'NetworkingError', 'InternalServerError', 'ServiceUnavailable'].includes(error.name)) throw error;
      // The exact Describe below resolves completed names and an ambiguous lost response.
    }
  };
  try {
    await start();
    refusalPhase = 'execution_observation';
    refusalCategory = 'execution_observation_unavailable';
    let description: DescribeExecutionOutput | undefined;
    for (let poll = 0; poll < 900; poll += 1) {
      description = await transport.describe(evidence.operation.execution_arn);
      validateDescription(description, envelope, versionArn, name);
      evidence.operation.status = description.status!;
      evidence.operation.started_at = description.startDate?.toISOString();
      evidence.operation.stopped_at = description.stopDate?.toISOString();
      await writeEvidence(path, evidence);
      if (description.status === 'SUCCEEDED') break;
      if (TERMINAL_FAILURE.includes(description.status!)) {
        refusalPhase = 'retry_eligibility';
        refusalCategory = 'retry_not_authorized';
        if (environment.E2E_CLEANUP_RETRY_FAILED !== 'true' || name.endsWith('-retry1')) throw new Error('Cleanup terminated without success; identities retained and retry requires explicit task-cessation proof');
        refusalPhase = 'retry_proof';
        refusalCategory = 'retry_proof_unavailable';
        const proof = await observeFailedCleanupOperation(inputs, environment, transport);
        if (proof.execution_arn !== evidence.operation.execution_arn || proof.status !== 'FAILED'
          || proof.input_sha256 !== evidence.operation.input_sha256 || proof.committed_marker_observed !== false
          || typeof proof.log_snapshot_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(proof.log_snapshot_sha256)
          || !Array.isArray(proof.tasks) || proof.tasks.length !== 2) {
          throw new Error('Cleanup retry requires the exact stable no-commit refusal proof');
        }
        const taskProofs = proof.tasks as Record<string, unknown>[];
        evidence.operation.preceding_execution = { execution_arn: proof.execution_arn, status: 'FAILED',
          stopped_tasks: taskProofs.map(task => String(task.task_arn)), task_proofs: taskProofs,
          log_snapshot_sha256: proof.log_snapshot_sha256 };
        name = `${name.slice(0, 72)}-retry1`;
        evidence.operation.execution_name = name;
        evidence.operation.execution_arn = cleanupExecutionArn(versionArn, name);
        evidence.operation.status = 'PENDING';
        description = undefined;
        refusalPhase = 'operation_start';
        refusalCategory = 'operation_start_unavailable';
        await start();
        refusalPhase = 'execution_observation';
        refusalCategory = 'execution_observation_unavailable';
      } else await transport.sleep(2_000);
    }
    refusalPhase = 'execution_observation';
    refusalCategory = 'execution_not_succeeded';
    if (description?.status !== 'SUCCEEDED' || !description.output || description.outputDetails?.included !== true) throw new Error('Cleanup did not expose complete terminal success');
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
