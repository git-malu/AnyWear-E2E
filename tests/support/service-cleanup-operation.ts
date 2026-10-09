import {
  DescribeExecutionCommand,
  SFNClient,
  StartExecutionCommand,
  type DescribeExecutionOutput,
} from '@aws-sdk/client-sfn';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ServiceCleanupInputs } from './worker-cleanup.js';

const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const RUN_SCOPE = /^[1-9][0-9]{0,19}-[1-9][0-9]{0,5}-[a-f0-9]{16}$/;
const VERSION_ARN = /^arn:aws:states:[a-z0-9-]+:[0-9]{12}:stateMachine:[A-Za-z0-9_-]+:[1-9][0-9]*$/;

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
  operation_id: string;
  request_sha256: string;
  transaction_committed: true;
  verification_task_arn: string;
  verification_task_status: 'SUCCEEDED';
  cleanup_task_arn: string;
  cleanup_task_status: 'SUCCEEDED';
  [key: string]: unknown;
}

export interface CleanupOperationEvidence {
  schema_version: 2;
  record_type: 'anywear_e2e_service_cleanup_operation';
  operation: {
    state_machine_version_arn: string;
    execution_arn: string;
    execution_name: string;
    started_at?: string;
    stopped_at?: string;
    status: 'SUCCEEDED';
    input_sha256: string;
    input: CleanupOperationEnvelope;
    output: CleanupOperationResult;
  };
}

export interface CleanupOperationIo {
  start(input: CleanupOperationEnvelope, executionName: string): Promise<{ executionArn?: string }>;
  describe(executionArn: string): Promise<DescribeExecutionOutput>;
  sleep(milliseconds: number): Promise<void>;
}

function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function parseCleanupRequest(cleanupJson: string, runScope: string): void {
  const bytes = Buffer.from(cleanupJson, 'utf8');
  if (bytes.byteLength > 16_384) throw new Error('Cleanup request exceeds the Service limit');
  let request: unknown;
  try { request = JSON.parse(cleanupJson); } catch { throw new Error('Cleanup request is not valid JSON'); }
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || Object.keys(request).sort().join(',') !== 'runScope,users') throw new Error('Cleanup request shape is invalid');
  const value = request as { runScope?: unknown; users?: unknown };
  if (value.runScope !== runScope || !Array.isArray(value.users) || value.users.length < 1 || value.users.length > 8) {
    throw new Error('Cleanup request run scope or worker bound is invalid');
  }
}

export function createCleanupOperationEnvelope(
  inputs: ServiceCleanupInputs,
  environment: NodeJS.ProcessEnv = process.env,
): CleanupOperationEnvelope {
  if (inputs.action !== 'cleanup' || inputs.emails !== '[]') throw new Error('Unsupported Service cleanup action');
  const request = JSON.parse(inputs.cleanup_json) as { runScope?: unknown };
  if (typeof request.runScope !== 'string' || !RUN_SCOPE.test(request.runScope)) throw new Error('Cleanup request run scope is invalid');
  parseCleanupRequest(inputs.cleanup_json, request.runScope);
  const serviceCommit = environment.E2E_CLEANUP_SERVICE_SOURCE_SHA ?? environment.E2E_CLEANUP_SERVICE_SHA;
  const serviceDigest = environment.E2E_CLEANUP_SERVICE_IMAGE_DIGEST;
  if (!serviceCommit || !SHA.test(serviceCommit)) throw new Error('E2E_CLEANUP_SERVICE_SHA must be a full commit SHA');
  if (!serviceDigest || !DIGEST.test(serviceDigest)) throw new Error('E2E_CLEANUP_SERVICE_IMAGE_DIGEST must be an OCI digest');
  const requestSha = hashBytes(Buffer.from(inputs.cleanup_json, 'utf8'));
  return {
    schema_version: 1,
    operation_id: `beta-tester-cleanup:${request.runScope}`,
    run_scope: request.runScope,
    request_sha256: requestSha,
    service_commit_sha: serviceCommit,
    service_image_digest: serviceDigest,
    cleanup_request: inputs.cleanup_json,
  };
}

export function deterministicCleanupExecutionName(envelope: CleanupOperationEnvelope): string {
  const suffix = envelope.request_sha256.slice(0, 16);
  const name = `beta-cleanup-${envelope.run_scope}-${suffix}`;
  if (name.length > 80) throw new Error('Cleanup execution name exceeds the Step Functions limit');
  return name;
}

function validateVersionArn(arn: string): void {
  if (!VERSION_ARN.test(arn)) throw new Error('BETA_CLEANUP_STATE_MACHINE_VERSION_ARN must be a version ARN');
}

function validateResult(value: unknown, envelope: CleanupOperationEnvelope): CleanupOperationResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Cleanup operation output is not an object');
  const output = value as Record<string, unknown>;
  if (output.operation_id !== envelope.operation_id || output.request_sha256 !== envelope.request_sha256
    || output.transaction_committed !== true
    || typeof output.verification_task_arn !== 'string' || output.verification_task_status !== 'SUCCEEDED'
    || typeof output.cleanup_task_arn !== 'string' || output.cleanup_task_status !== 'SUCCEEDED') {
    throw new Error('Cleanup operation output is not the exact committed terminal result');
  }
  return output as CleanupOperationResult;
}

function defaultIo(stateMachineArn: string, region: string): CleanupOperationIo {
  const client = new SFNClient({ region });
  return {
    async start(input, executionName) {
      try {
        const result = await client.send(new StartExecutionCommand({ stateMachineArn, name: executionName, input: JSON.stringify(input) }));
        return { executionArn: result.executionArn };
      } catch (error: unknown) {
        const executionArn = error && typeof error === 'object' && 'executionArn' in error
          ? String(error.executionArn) : undefined;
        if (executionArn) return { executionArn };
        throw error;
      }
    },
    describe(executionArn) { return client.send(new DescribeExecutionCommand({ executionArn })); },
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  };
}

export async function runCleanupOperation(
  inputs: ServiceCleanupInputs,
  environment: NodeJS.ProcessEnv = process.env,
  io?: CleanupOperationIo,
): Promise<CleanupOperationEvidence | undefined> {
  const stateMachineArn = environment.BETA_CLEANUP_STATE_MACHINE_VERSION_ARN;
  if (!stateMachineArn) {
    console.warn('Beta cleanup capability is not configured; cleanup deferred and identities retained');
    return undefined;
  }
  validateVersionArn(stateMachineArn);
  const envelope = createCleanupOperationEnvelope(inputs, environment);
  const executionName = deterministicCleanupExecutionName(envelope);
  const transport = io ?? defaultIo(stateMachineArn, environment.AWS_REGION ?? 'ap-east-1');
  const started = await transport.start(envelope, executionName);
  if (!started.executionArn || !/^arn:aws:states:[a-z0-9-]+:[0-9]{12}:execution:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/.test(started.executionArn)) {
    throw new Error('Cleanup operation did not return an identifiable execution ARN');
  }
  const deadline = Date.now() + 30 * 60_000;
  let description: DescribeExecutionOutput | undefined;
  while (Date.now() < deadline) {
    description = await transport.describe(started.executionArn);
    if (description.status === 'SUCCEEDED') break;
    if (description.status && ['FAILED', 'TIMED_OUT', 'ABORTED'].includes(description.status)) {
      throw new Error(`Cleanup operation terminated with ${description.status}; Cognito identities were retained`);
    }
    await transport.sleep(2_000);
  }
  if (!description || description.status !== 'SUCCEEDED') throw new Error('Cleanup operation did not reach terminal success; Cognito identities were retained');
  if (!description.output) throw new Error('Cleanup operation succeeded without a result; Cognito identities were retained');
  const output = validateResult(JSON.parse(description.output), envelope);
  const evidence: CleanupOperationEvidence = {
    schema_version: 2,
    record_type: 'anywear_e2e_service_cleanup_operation',
    operation: {
      state_machine_version_arn: stateMachineArn,
      execution_arn: started.executionArn,
      execution_name: executionName,
      started_at: description.startDate?.toISOString(),
      stopped_at: description.stopDate?.toISOString(),
      status: 'SUCCEEDED',
      input_sha256: hashBytes(Buffer.from(JSON.stringify(envelope), 'utf8')),
      input: envelope,
      output,
    },
  };
  const evidencePath = environment.E2E_SERVICE_CLEANUP_EVIDENCE_PATH ?? 'test-results/service-cleanup-operation.json';
  await mkdir(dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  return evidence;
}
