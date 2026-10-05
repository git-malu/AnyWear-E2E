import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fencingCiFixture, stableAuditFixture } from './fixtures/runtime-evidence.mjs';
import {
  assertRuntimeDrillEnvironment,
  assertRuntimeDrillExecutionEnvironment,
  assertRuntimeDrillExecutorAdapter,
  assertRuntimeDrillMutationConfirmation,
  buildRuntimeDrillPlan,
  executeRuntimeDrill,
  loadExecutionAdapter,
  readProviderFailureFixture,
  verifyRuntimeDrillEvidence,
} from './runtime-drill.mjs';

const environment = {
  E2E_STAGE: 'beta',
  AWS_ACCOUNT_ID: '650880818323',
  AWS_REGION: 'ap-east-1',
  E2E_CLIENT_URL: 'https://d2rztl7o0y7rf8.cloudfront.net',
  E2E_SERVICE_URL: 'https://dapi.example.cloudfront.net',
  RUNTIME_DRILL_EXCLUSIVE_WINDOW: 'beta-exclusive-runtime',
};
const compatibility = {
  client: { sha: 'a'.repeat(40) },
  service: { sha: 'b'.repeat(40) },
};

function validEvidence() {
  const request = { runScope: '123-1-aaaaaaaaaaaaaaaa',
    user: { sub: '123e4567-e89b-12d3-a456-426614174000', email: 'e2e-beta-123-1-aaaaaaaaaaaaaaaa-0-01234567@anywear.local' },
    taskId: '123e4567-e89b-12d3-a456-426614174001', itemId: '123e4567-e89b-12d3-a456-426614174002',
    idempotencyKey: '123e4567-e89b-12d3-a456-426614174003' };
  return {
    schema_version: 2,
    record_type: 'anywear_beta_runtime_drill',
    drill_id: 'beta-runtime-test-001',
    environment: {
      stage: 'beta',
      aws_account_id: '650880818323',
      aws_region: 'ap-east-1',
      client_url: environment.E2E_CLIENT_URL,
      service_url: environment.E2E_SERVICE_URL,
    },
    deployment: {
      client_source_commit: compatibility.client.sha,
      service_source_commit: compatibility.service.sha,
      service_image_digest: `sha256:${'c'.repeat(64)}`,
    },
    fencing_ci: fencingCiFixture(compatibility.service.sha),
    runtime_control: { restored: true, phase: 'restored', nonpaid_provider_only: true, shared_worker_iam_and_network: true,
      service_source_commit: compatibility.service.sha, service_image_digest: `sha256:${'c'.repeat(64)}` },
    drills: [
      {
        id: 'accepted-task-restart',
        status: 'passed',
        evidence: {
          task_id: request.taskId,
          api_restart: true,
          worker_restart: true,
          rolling_deployment: true,
          idempotency_replay_same_response: true,
          terminal_audit: stableAuditFixture(request),
          execution_token_before: 1, execution_token_after: 1, recovery_kind: 'graceful-drain',
          credit: { applicability: 'not-applicable', reason: 'auto-tagging' },
          state_versions: [1, 2, 3],
          api_task_arns: ['api-a', 'api-b'],
          worker_task_arns: ['worker-a', 'worker-b'],
          terminal_status: 'ready',
        },
      },
      {
        id: 'multi-replica-sse',
        status: 'passed',
        evidence: {
          api_task_arns: ['api-a', 'api-b'],
          stream_task_arns: ['api-a', 'api-b'],
          distinct_replica_logs: true,
          reconnected_after_replacement: true,
          both_observers_terminal: true,
          monotonic_state_versions: true,
        },
      },
      {
        id: 'retry-visibility-dlq',
        status: 'passed',
        evidence: {
          task_id: request.taskId,
          retryable_failures: 2,
          receive_count: 3,
          database_lease_renewed: true,
          sqs_visibility_extended: true,
          terminal_audit: stableAuditFixture(request, { status: 'failed', token: 3 }),
          execution_token: 3, credit: { applicability: 'not-applicable', reason: 'auto-tagging' },
          dlq_message_id: 'message-1',
          terminal_status: 'failed',
        },
      },
    ],
  };
}

test('runtime drills fail closed outside the Beta NonProd account', () => {
  assert.deepEqual(assertRuntimeDrillEnvironment(environment).awsAccountId, '650880818323');
  assert.throws(() => assertRuntimeDrillEnvironment({ ...environment, E2E_STAGE: 'dev' }), /E2E_STAGE=beta/);
  assert.throws(() => assertRuntimeDrillEnvironment({ ...environment, AWS_ACCOUNT_ID: '123456789012' }), /650880818323/);
  assert.throws(() => assertRuntimeDrillEnvironment({ ...environment, E2E_SERVICE_URL: 'http://api.example' }), /HTTPS/);
});

test('runtime mutations require the explicit Beta confirmation token', () => {
  assert.doesNotThrow(() => assertRuntimeDrillMutationConfirmation({ RUNTIME_DRILL_CONFIRM: 'beta-runtime-drill' }));
  assert.throws(
    () => assertRuntimeDrillMutationConfirmation({}),
    /RUNTIME_DRILL_CONFIRM=beta-runtime-drill/,
  );
  assert.throws(
    () => assertRuntimeDrillMutationConfirmation({ RUNTIME_DRILL_CONFIRM: 'production' }),
    /RUNTIME_DRILL_CONFIRM=beta-runtime-drill/,
  );
});

test('runtime execution requires main, Beta concurrency, and a unique marker', () => {
  const executionEnvironment = {
    ...environment,
    GITHUB_REF: 'refs/heads/main',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_SHA: 'a'.repeat(40),
    RUNTIME_DRILL_CONCURRENCY: 'anywear-beta-runtime',
    RUNTIME_DRILL_CONFIRM: 'beta-runtime-drill',
    RUNTIME_DRILL_ID: 'beta-runtime-test-001',
    RUNTIME_DRILL_E2E_SHA: 'a'.repeat(40),
    RUNTIME_DRILL_CLIENT_SHA: 'a'.repeat(40),
    RUNTIME_DRILL_SERVICE_SHA: 'b'.repeat(40),
    RUNTIME_DRILL_RUN_SCOPE: '123-1-aaaaaaaaaaaaaaaa',
  };
  const compatibilitySet = { client: { sha: 'a'.repeat(40) }, service: { sha: 'b'.repeat(40) } };
  assert.equal(assertRuntimeDrillExecutionEnvironment(executionEnvironment, compatibilitySet).drillId, 'beta-runtime-test-001');
  assert.throws(() => assertRuntimeDrillExecutionEnvironment({ ...executionEnvironment, GITHUB_REF: 'refs/heads/codex/test' }, compatibilitySet), /main branch/);
  assert.throws(() => assertRuntimeDrillExecutionEnvironment({ ...executionEnvironment, RUNTIME_DRILL_CONCURRENCY: 'other' }, compatibilitySet), /concurrency/);
  assert.throws(() => assertRuntimeDrillExecutionEnvironment({ ...executionEnvironment, RUNTIME_DRILL_ID: 'prod-runtime-test' }, compatibilitySet), /RUNTIME_DRILL_ID/);
  assert.throws(() => assertRuntimeDrillExecutionEnvironment({ ...executionEnvironment, GITHUB_EVENT_NAME: undefined }, compatibilitySet), /workflow_dispatch/);
});

test('retry execution refuses missing or unapproved provider-failure fixtures', async () => {
  await assert.rejects(readProviderFailureFixture(), /requires RUNTIME_DRILL_PROVIDER_FAILURE_FIXTURE/);
  await assert.rejects(readProviderFailureFixture('tests/fixtures/dummy.png'), /approved provider-failure/);
  const directory = await mkdtemp(path.join(tmpdir(), 'anywear-runtime-drill-'));
  const manifestPath = path.join(directory, 'provider-failure-test.json');
  try {
    await writeFile(manifestPath, JSON.stringify({
      schema_version: 1,
      kind: 'provider-failure',
      source: 'beta-provider-nonpaid-loopback',
      application_backdoor: false,
      approved: true,
      image_path: 'tests/fixtures/dummy.png',
      delay_ms: 45000, failure_status: 500, forwards_requests: false, provider_billing_applicability: 'not-applicable',
    }));
    const fixture = await readProviderFailureFixture(manifestPath);
    assert.equal(fixture.application_backdoor, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('runtime executor refuses adapters without exact cleanup and replica attribution hooks', () => {
  assert.throws(() => assertRuntimeDrillExecutorAdapter({}), /cleanupOwnedResources/);
  const names = [
    'createSyntheticAccount', 'runWardrobeApiFlow', 'replaceAndRestoreEcs',
    'captureReplicaAttribution', 'runProviderFailureFixture', 'collectRetryEvidence',
    'cleanupOwnedResources',
    'prepareNonPaidRuntime', 'restoreNonPaidRuntime',
    'pauseRuntimeWindow', 'restoreRuntimeWindow',
  ];
  const adapter = Object.fromEntries(names.map((name) => [name, () => undefined]));
  assert.equal(assertRuntimeDrillExecutorAdapter(adapter), adapter);
});

test('runtime executor adapter loading rejects absent or escaping modules', async () => {
  assert.equal(await loadExecutionAdapter({}), undefined);
  await assert.rejects(loadExecutionAdapter({ RUNTIME_DRILL_ADAPTER_MODULE: '../adapter.mjs' }), /relative module/);
  await assert.rejects(loadExecutionAdapter({ RUNTIME_DRILL_ADAPTER_MODULE: 'C:\\adapter.mjs' }), /relative module/);
});

test('runtime executor cleans the owned scope after an adapter failure', async () => {
  const executionEnvironment = {
    ...environment,
    GITHUB_REF: 'refs/heads/main',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_SHA: 'a'.repeat(40),
    RUNTIME_DRILL_CONCURRENCY: 'anywear-beta-runtime',
    RUNTIME_DRILL_CONFIRM: 'beta-runtime-drill',
    RUNTIME_DRILL_ID: 'beta-runtime-cleanup-test',
    RUNTIME_DRILL_E2E_SHA: 'a'.repeat(40),
    RUNTIME_DRILL_CLIENT_SHA: compatibility.client.sha,
    RUNTIME_DRILL_SERVICE_SHA: compatibility.service.sha,
    RUNTIME_DRILL_RUN_SCOPE: '123-1-bbbbbbbbbbbbbbbb',
  };
  let cleaned = false;
  const names = [
    'createSyntheticAccount', 'runWardrobeApiFlow', 'replaceAndRestoreEcs',
    'captureReplicaAttribution', 'runProviderFailureFixture', 'collectRetryEvidence',
    'cleanupOwnedResources',
    'prepareNonPaidRuntime', 'restoreNonPaidRuntime',
    'pauseRuntimeWindow', 'restoreRuntimeWindow',
  ];
  const adapter = Object.fromEntries(names.map((name) => [name, async () => undefined]));
  adapter.createSyntheticAccount = async () => ({ owned: true });
  adapter.runWardrobeApiFlow = async () => { throw new Error('synthetic adapter failure'); };
  adapter.cleanupOwnedResources = async ({ scope, marker }) => {
    cleaned = scope.owned === true && marker === executionEnvironment.RUNTIME_DRILL_ID;
  };
  const preflight = {
    intake_open: false,
    stack: { cluster: 'beta', apiService: 'api', workerService: 'worker' },
    deployment: {
      client: { source_commit: compatibility.client.sha },
      service: { source_commit: compatibility.service.sha, image_digest: `sha256:${'c'.repeat(64)}` },
    },
  };
  await assert.rejects(executeRuntimeDrill(executionEnvironment, compatibility, adapter, {
    fixtureReader: async () => ({ image_path: 'unused' }),
    preflightCollector: async () => preflight,
    fencingReader: async () => fencingCiFixture(compatibility.service.sha),
  }), /synthetic adapter failure/);
  assert.equal(cleaned, true);
});

test('runtime plan names bounded drills and cleanup controls', () => {
  const plan = buildRuntimeDrillPlan(assertRuntimeDrillEnvironment(environment), {
    cluster: 'beta-anywear',
    apiService: 'beta-anywear-api',
    workerService: 'beta-anywear-worker',
  });
  assert.equal(plan.record_type, 'anywear_beta_runtime_drill_plan');
  assert.deepEqual(plan.drills.map((drill) => drill.id), [
    'accepted-task-restart',
    'multi-replica-sse',
    'retry-visibility-dlq',
    'rollback',
  ]);
  assert.match(plan.controls.cleanup, /current drill_id/);
});

test('runtime evidence verifies restart, replica, retry, and DLQ invariants', () => {
  const result = verifyRuntimeDrillEvidence(validEvidence(), compatibility);
  assert.equal(result.passed, true);
  assert.equal(result.rollback, 'not_recorded');
});

test('runtime evidence rejects duplicate replica claims and incomplete visibility evidence', () => {
  const duplicateReplica = validEvidence();
  duplicateReplica.drills[1].evidence.api_task_arns = ['api-a', 'api-a'];
  assert.throws(
    () => verifyRuntimeDrillEvidence(duplicateReplica, compatibility),
    /api_task_arns must contain unique values/,
  );

  const missingStreamReplicas = validEvidence();
  missingStreamReplicas.drills[1].evidence.stream_task_arns = ['api-a'];
  assert.throws(
    () => verifyRuntimeDrillEvidence(missingStreamReplicas, compatibility),
    /stream_task_arns must contain at least 2 non-empty string\(s\)/,
  );

  const missingVisibility = validEvidence();
  missingVisibility.drills[2].evidence.sqs_visibility_extended = false;
  assert.throws(
    () => verifyRuntimeDrillEvidence(missingVisibility, compatibility),
    /sqs_visibility_extended must be true/,
  );
});

test('runtime evidence rejects a state version regression between adjacent observations', () => {
  const evidence = validEvidence();
  evidence.drills[0].evidence.state_versions = [1, 3, 2];
  assert.throws(
    () => verifyRuntimeDrillEvidence(evidence, compatibility),
    /state_versions must be monotonic/,
  );
});

test('runtime evidence requires a bounded unique drill id', () => {
  const evidence = validEvidence();
  delete evidence.drill_id;
  assert.throws(() => verifyRuntimeDrillEvidence(evidence, compatibility), /drill_id/);

  evidence.drill_id = 'prod-runtime-test';
  assert.throws(() => verifyRuntimeDrillEvidence(evidence, compatibility), /drill_id/);
});

test('runtime evidence rejects a changed service identity', () => {
  const evidence = validEvidence();
  evidence.deployment.service_source_commit = 'd'.repeat(40);
  assert.throws(
    () => verifyRuntimeDrillEvidence(evidence, compatibility),
    /Service commit does not match compatibility.json/,
  );
});

test('runtime evidence rejects an explicitly failed rollback drill', () => {
  const evidence = validEvidence();
  evidence.drills.push({ id: 'rollback', status: 'failed', evidence: {} });
  assert.throws(
    () => verifyRuntimeDrillEvidence(evidence, compatibility),
    /Optional rollback drill is marked failed/,
  );
});
