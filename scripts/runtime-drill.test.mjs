import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertRuntimeDrillEnvironment,
  assertRuntimeDrillMutationConfirmation,
  buildRuntimeDrillPlan,
  verifyRuntimeDrillEvidence,
} from './runtime-drill.mjs';

const environment = {
  E2E_STAGE: 'beta',
  AWS_ACCOUNT_ID: '650880818323',
  AWS_REGION: 'ap-east-1',
  E2E_CLIENT_URL: 'https://d2rztl7o0y7rf8.cloudfront.net',
  E2E_SERVICE_URL: 'https://dapi.example.cloudfront.net',
};
const compatibility = {
  client: { sha: 'a'.repeat(40) },
  service: { sha: 'b'.repeat(40) },
};

function validEvidence() {
  return {
    schema_version: 1,
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
    drills: [
      {
        id: 'accepted-task-restart',
        status: 'passed',
        evidence: {
          task_id: 'task-1',
          api_restart: true,
          worker_restart: true,
          rolling_deployment: true,
          idempotency_replay_same_response: true,
          no_duplicate_terminal_effect: true,
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
          task_id: 'task-1',
          retryable_failures: 2,
          receive_count: 3,
          database_lease_renewed: true,
          sqs_visibility_extended: true,
          no_duplicate_side_effects: true,
          credit_settlement_count: 1,
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
