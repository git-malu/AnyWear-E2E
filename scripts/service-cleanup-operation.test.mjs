import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  createCleanupOperationEnvelope,
  deterministicCleanupExecutionName,
  runCleanupOperation,
} from '../tests/support/service-cleanup-operation.ts';

const scope = `123456789-1-${'a'.repeat(16)}`;
const subject = '10000000-0000-4000-8000-000000000001';
const inputs = { action: 'cleanup', emails: '[]', cleanup_json: JSON.stringify({
  runScope: scope,
  users: [{ sub: subject, email: 'e2e-beta-worker-0-chromium@anywear.local' }],
}) };
const environment = {
  E2E_CLEANUP_SERVICE_SHA: 'a'.repeat(40),
  E2E_CLEANUP_SERVICE_IMAGE_DIGEST: `sha256:${'b'.repeat(64)}`,
  BETA_CLEANUP_STATE_MACHINE_VERSION_ARN: 'arn:aws:states:ap-east-1:650880818323:stateMachine:beta-anywear-cleanup:7',
  AWS_REGION: 'ap-east-1',
};

test('cleanup envelope binds exact request bytes, source and versioned capability', async () => {
  const envelope = createCleanupOperationEnvelope(inputs, environment);
  assert.equal(envelope.schema_version, 1);
  assert.equal(envelope.operation_id, `beta-tester-cleanup:${scope}`);
  assert.match(envelope.request_sha256, /^[a-f0-9]{64}$/);
  assert.equal(deterministicCleanupExecutionName(envelope), `beta-cleanup-${scope}-${envelope.request_sha256.slice(0, 16)}`);
  assert.throws(() => createCleanupOperationEnvelope({ ...inputs, cleanup_json: inputs.cleanup_json.replace(scope, `${scope}x`) }, environment));
  await assert.rejects(runCleanupOperation(inputs, { ...environment, BETA_CLEANUP_STATE_MACHINE_VERSION_ARN: 'arn:aws:states:ap-east-1:650880818323:stateMachine:beta-anywear-cleanup' }, { start: async () => ({}), describe: async () => ({}), sleep: async () => {} }), /version ARN/);
});

test('cleanup operation waits for exact success and writes terminal evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'anywear-cleanup-operation-'));
  const evidencePath = join(directory, 'operation.json');
  const calls = [];
  let attempt = 0;
  const executionArn = 'arn:aws:states:ap-east-1:650880818323:execution:beta-anywear-cleanup:cleanup-name';
  try {
    const evidence = await runCleanupOperation(inputs, { ...environment, E2E_SERVICE_CLEANUP_EVIDENCE_PATH: evidencePath }, {
      async start(input, name) { calls.push({ type: 'start', input, name }); return { executionArn }; },
      async describe(arn) {
        calls.push({ type: 'describe', arn });
        attempt += 1;
        if (attempt === 1) return { status: 'RUNNING', stateMachineArn: environment.BETA_CLEANUP_STATE_MACHINE_VERSION_ARN };
        const envelope = createCleanupOperationEnvelope(inputs, environment);
        return { status: 'SUCCEEDED', stateMachineArn: environment.BETA_CLEANUP_STATE_MACHINE_VERSION_ARN,
          startDate: new Date('2026-10-10T00:00:00Z'), stopDate: new Date('2026-10-10T00:00:01Z'),
          input: JSON.stringify(envelope), output: JSON.stringify({ operation_id: envelope.operation_id,
            request_sha256: envelope.request_sha256, transaction_committed: true,
            verification_task_arn: 'arn:aws:ecs:ap-east-1:650880818323:task/beta-anywear/verify', verification_task_status: 'SUCCEEDED',
            cleanup_task_arn: 'arn:aws:ecs:ap-east-1:650880818323:task/beta-anywear/cleanup', cleanup_task_status: 'SUCCEEDED' }) };
      },
      async sleep() {},
    });
    assert.equal(evidence.operation.status, 'SUCCEEDED');
    assert.equal(evidence.operation.output.transaction_committed, true);
    assert.equal(calls.filter((call) => call.type === 'describe').length, 2);
    assert.deepEqual(JSON.parse(await readFile(evidencePath, 'utf8')), evidence);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('failed or incomplete terminal output retains cleanup identities', async () => {
  const executionArn = 'arn:aws:states:ap-east-1:650880818323:execution:beta-anywear-cleanup:cleanup-name';
  const io = { start: async () => ({ executionArn }), describe: async () => ({ status: 'FAILED' }), sleep: async () => {} };
  await assert.rejects(runCleanupOperation(inputs, environment, io), /FAILED/);
  const incomplete = { start: async () => ({ executionArn }), describe: async () => ({ status: 'SUCCEEDED', output: '{}' }), sleep: async () => {} };
  await assert.rejects(runCleanupOperation(inputs, environment, incomplete), /exact committed terminal result/);
});
