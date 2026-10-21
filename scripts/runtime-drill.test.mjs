import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { cleanupFixture, fencingCiFixture, scopeFixture, stableAuditFixture, windowFixture } from './fixtures/runtime-evidence.mjs';
import { readQualificationTuple, requireQualificationTuplePath } from './qualification-record.mjs';
import {
  assertRuntimeDrillEnvironment,
  assertRuntimeDrillExecutionEnvironment,
  assertRuntimeDrillExecutorAdapter,
  assertRuntimeDrillMutationConfirmation,
  buildRuntimeDrillPlan,
  collectPreflightDeployment,
  executeRuntimeDrill,
  loadExecutionAdapter,
  parseRuntimeDrillArguments,
  qualificationTupleExpectation,
  readProviderFailureFixture,
  verifyRuntimeDrillEvidence,
} from './runtime-drill.mjs';
import { repositoryRoot } from './test-selection.mjs';

const exec = promisify(execFile);
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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
  const retryRequest = { ...request, taskId: '123e4567-e89b-12d3-a456-426614174004',
    itemId: '123e4567-e89b-12d3-a456-426614174005', idempotencyKey: '123e4567-e89b-12d3-a456-426614174006' };
  const scope = { ...scopeFixture(request), knownDLQMessageId: { taskId: retryRequest.taskId, messageId: 'message-1' } };
  const apiArns = ['5', '6'].map((id) => `arn:aws:ecs:ap-east-1:650880818323:task/beta-anywear/${id.repeat(32)}`);
  return {
    schema_version: 2,
    record_type: 'anywear_beta_runtime_drill',
    drill_id: 'beta-runtime-test-001',
    run_scope: request.runScope, synthetic_owner: request.user,
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
    window_control: windowFixture(scope), cleanup_evidence: cleanupFixture(scope),
    runtime_control: { run_scope: request.runScope, restored: true, phase: 'restored', nonpaid_provider_only: true, shared_worker_iam_and_network: true,
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
          api_task_arns: apiArns,
          worker_task_arns: ['worker-a', 'worker-b'],
          terminal_status: 'ready',
        },
      },
      {
        id: 'multi-replica-sse',
        status: 'passed',
        evidence: {
          api_task_arns: apiArns, api_task_arns_after: apiArns,
          stream_task_arns: apiArns,
          item_id: request.itemId, reconnected_request_ids: ['r3', 'r4'],
          request_attribution: ['r1', 'r2', 'r3', 'r4'].map((id, index) => ({ request_id: id, task_arn: apiArns[index % 2] })),
          terminal_observers: [{ status: 'ready', version: 3 }, { status: 'ready', version: 3 }],
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
          task_id: retryRequest.taskId,
          retryable_failures: 2,
          receive_count: 3,
          database_lease_renewed: true,
          sqs_visibility_extended: true,
          terminal_audit: stableAuditFixture(retryRequest, { status: 'failed', token: 3 }),
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
  const operationFailure = new Error('sensitive adapter detail');
  const restorationFailure = new Error('sensitive restoration detail');
  const policyFailure = new Error('sensitive policy detail');
  adapter.runWardrobeApiFlow = async () => { throw operationFailure; };
  adapter.restoreNonPaidRuntime = async () => { throw restorationFailure; };
  adapter.restoreRuntimeWindow = async () => { throw policyFailure; };
  adapter.cleanupOwnedResources = async ({ scope, marker }) => {
    cleaned = scope.owned === true && marker === executionEnvironment.RUNTIME_DRILL_ID;
  };
  const preflight = {
    admission_mode: 'closed',
    stack: { cluster: 'beta', apiService: 'api', workerService: 'worker' },
    deployment: {
      client: { source_commit: compatibility.client.sha },
      service: { source_commit: compatibility.service.sha, image_digest: `sha256:${'c'.repeat(64)}` },
    },
  };
  const options = {
    fixtureReader: async () => ({ image_path: 'unused' }),
    preflightCollector: async () => preflight,
    fencingReader: async () => fencingCiFixture(compatibility.service.sha),
  };
  const execute = () => executeRuntimeDrill(executionEnvironment, compatibility, adapter, options);
  await assert.rejects(execute(), (error) => {
    assert.equal(error.message,
      'Runtime execution failed in: accepted wardrobe API flow; non-paid runtime restoration; admission restoration. Inspect available recovery artifacts before retrying.');
    assert.doesNotMatch(error.message, /sensitive/);
    assert.ok(error.cause instanceof AggregateError);
    assert.deepEqual(error.cause.errors, [operationFailure, restorationFailure, policyFailure]);
    return true;
  });
  assert.equal(cleaned, true);

  adapter.restoreNonPaidRuntime = async () => undefined;
  adapter.restoreRuntimeWindow = async () => undefined;
  for (const [hook, phase] of [
    ['pauseRuntimeWindow', 'admission pause; run-owned resource cleanup'],
    ['cleanupOwnedResources', 'run-owned resource cleanup'],
  ]) {
    const original = adapter[hook];
    const failure = new Error('sensitive cleanup detail');
    adapter[hook] = async () => { throw failure; };
    await assert.rejects(execute(), (error) => {
      assert.equal(error.message,
        `Runtime execution failed in: accepted wardrobe API flow; ${phase}. Inspect available recovery artifacts before retrying.`);
      assert.doesNotMatch(error.message, /sensitive/);
      assert.equal(error.cause.errors[0], operationFailure);
      assert.equal(error.cause.errors[1], failure);
      return true;
    });
    adapter[hook] = original;
  }

  cleaned = false;
  const creationFailure = new Error('sensitive identity detail');
  adapter.createSyntheticAccount = async () => { throw creationFailure; };
  await assert.rejects(execute(), (error) => {
    assert.equal(error.message,
      'Runtime execution failed in: synthetic account creation. Inspect available recovery artifacts before retrying.');
    assert.equal(error.cause, creationFailure);
    assert.doesNotMatch(error.message, /sensitive|artifact retained/);
    return true;
  });
  assert.equal(cleaned, false);

  // Admission has no expiry, so the teardown must attempt the explicit close even when the
  // operation throws immediately after opening it. Nothing else would ever close it.
  const teardown = [];
  adapter.createSyntheticAccount = async () => ({ owned: true });
  adapter.prepareNonPaidRuntime = async ({ scope }) => {
    scope.runtimeWindow = { run_scope: scope.runScope, phase: 'private-owned-tester' };
    teardown.push('admission-opened');
    throw new Error('sensitive setup detail');
  };
  adapter.pauseRuntimeWindow = async () => { teardown.push('pause'); };
  adapter.cleanupOwnedResources = async () => { teardown.push('cleanup'); };
  adapter.restoreNonPaidRuntime = async () => { teardown.push('restore non-paid'); };
  adapter.restoreRuntimeWindow = async () => { teardown.push('restore admission'); };
  await assert.rejects(execute(), (error) => {
    assert.equal(error.message,
      'Runtime execution failed in: non-paid worker runtime setup. Inspect available recovery artifacts before retrying.');
    assert.doesNotMatch(error.message, /sensitive/);
    return true;
  });
  assert.deepEqual(teardown, ['admission-opened', 'pause', 'cleanup', 'restore non-paid', 'restore admission']);
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
    /Service commit does not match the qualification tuple revisions\.service\.sha/,
  );
});

function drillEnvironment(directory) {
  const env = {
    ...process.env,
    E2E_STAGE: 'beta',
    AWS_ACCOUNT_ID: '650880818323',
    AWS_REGION: 'ap-east-1',
    E2E_CLIENT_URL: environment.E2E_CLIENT_URL,
    E2E_SERVICE_URL: environment.E2E_SERVICE_URL,
    RUNTIME_DRILL_PLAN_PATH: path.join(directory, 'runtime-drill-plan.json'),
  };
  delete env.RUNTIME_DRILL_TUPLE;
  delete env.RUNTIME_DRILL_EVIDENCE_PATH;
  return env;
}

async function runDrill(args, env) {
  try {
    const { stdout, stderr } = await exec('node', ['scripts/runtime-drill.mjs', ...args], { cwd: repositoryRoot, env });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

test('tuple-required drill modes refuse without a qualification record while --plan stays offline', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'anywear-runtime-drill-'));
  try {
    const env = drillEnvironment(directory);
    for (const args of [
      ['--verify', path.join(directory, 'absent-evidence.json')],
      ['--execute'],
      ['--recover', path.join(directory, 'absent-recovery.json')],
    ]) {
      const result = await runDrill(args, env);
      assert.equal(result.code, 1, `${args[0]} exits non-zero`);
      // The tuple refusal precedes any evidence read or environment assertion: the named
      // error is the only thing reported and no absent input file is opened.
      assert.match(result.stderr, /requires the expected deployed tuple from a qualification-record\.json v3/);
      assert.match(result.stderr, /--tuple <qualification-record\.json>/);
      assert.match(result.stderr, /RUNTIME_DRILL_TUPLE/);
      assert.doesNotMatch(result.stderr, /absent-(evidence|recovery)|Evidence path|Recovery path/);
    }
    // `--plan` needs no tuple and ignores a set-but-unused one: it never opens a file by that name.
    const plan = await runDrill(['--plan'], { ...env, RUNTIME_DRILL_TUPLE: path.join(directory, 'absent-tuple.json') });
    assert.equal(plan.code, 0, plan.stderr);
    const written = JSON.parse(await readFile(env.RUNTIME_DRILL_PLAN_PATH, 'utf8'));
    assert.equal(written.record_type, 'anywear_beta_runtime_drill_plan');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('drill arguments keep the documented positional paths while accepting --tuple alongside them', () => {
  assert.deepEqual(parseRuntimeDrillArguments(['--verify', '--', 'evidence.json']),
    { mode: '--verify', tuple: undefined, positional: ['evidence.json'] });
  assert.deepEqual(parseRuntimeDrillArguments(['--verify', 'evidence.json', '--tuple', 'qualification-record.json']),
    { mode: '--verify', tuple: 'qualification-record.json', positional: ['evidence.json'] });
  assert.deepEqual(parseRuntimeDrillArguments(['--recover', '--tuple', 'qualification-record.json', 'recovery.json']),
    { mode: '--recover', tuple: 'qualification-record.json', positional: ['recovery.json'] });
  assert.throws(() => parseRuntimeDrillArguments(['--verify', 'evidence.json', '--tuple']), /--tuple requires a qualification-record\.json path/);
});

test('the qualification tuple reader refuses an absent, malformed, incomplete or non-commit record and names the field and file', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'anywear-qualification-tuple-'));
  const write = async (name, value) => {
    const file = path.join(directory, name);
    await writeFile(file, typeof value === 'string' ? value : JSON.stringify(value));
    return file;
  };
  const named = (file, detail) => new RegExp(`Qualification tuple ${escapeRegExp(file)} ${detail}`);
  try {
    const absent = path.join(directory, 'absent.json');
    await assert.rejects(readQualificationTuple(absent), named(absent, 'could not be read'));

    const invalid = await write('invalid.json', '{"revisions":');
    await assert.rejects(readQualificationTuple(invalid), named(invalid, 'is not valid JSON'));

    const noClient = await write('no-client.json', { revisions: { service: { sha: 'b'.repeat(40) } } });
    await assert.rejects(readQualificationTuple(noClient), named(noClient, 'is missing revisions\\.client'));
    const noClientSha = await write('no-client-sha.json', { revisions: { client: {}, service: { sha: 'b'.repeat(40) } } });
    await assert.rejects(readQualificationTuple(noClientSha), named(noClientSha, 'is missing revisions\\.client\\.sha'));

    const noService = await write('no-service.json', { revisions: { client: { sha: 'a'.repeat(40) } } });
    await assert.rejects(readQualificationTuple(noService), named(noService, 'is missing revisions\\.service'));

    const badClient = await write('bad-client.json', { revisions: { client: { sha: 'A'.repeat(40) }, service: { sha: 'b'.repeat(40) } } });
    await assert.rejects(readQualificationTuple(badClient), named(badClient, 'revisions\\.client\\.sha must be a full lowercase 40-character commit SHA'));
    const badService = await write('bad-service.json', { revisions: { client: { sha: 'a'.repeat(40) }, service: { sha: 'b'.repeat(39) } } });
    await assert.rejects(readQualificationTuple(badService), named(badService, 'revisions\\.service\\.sha must be a full lowercase 40-character commit SHA'));

    const valid = await write('valid.json', { schema_version: 3, revisions: { client: { sha: 'a'.repeat(40) }, service: { sha: 'b'.repeat(40) } } });
    assert.deepEqual(await readQualificationTuple(valid), { client: { sha: 'a'.repeat(40) }, service: { sha: 'b'.repeat(40) } });

    assert.throws(() => requireQualificationTuplePath({ tuple: undefined, environment: {}, label: 'Runtime drill --verify' }),
      /Runtime drill --verify requires the expected deployed tuple from a qualification-record\.json v3: pass --tuple <qualification-record\.json> or set RUNTIME_DRILL_TUPLE/);
    assert.equal(requireQualificationTuplePath({ environment: { RUNTIME_DRILL_TUPLE: 'qualification-record.json' }, label: 'Runtime drill --verify' }), 'qualification-record.json');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the qualification tuple becomes the {client_commit, service_commit} expectation that drives the live comparison', async () => {
  const tuple = { client: { sha: 'a'.repeat(40) }, service: { sha: 'b'.repeat(40) } };
  assert.deepEqual(qualificationTupleExpectation(tuple), { client_commit: 'a'.repeat(40), service_commit: 'b'.repeat(40) });
  assert.deepEqual(qualificationTupleExpectation(null), {});
  const config = { clientUrl: environment.E2E_CLIENT_URL, serviceUrl: environment.E2E_SERVICE_URL };
  const liveFetcher = (clientCommit, serviceCommit) => async (url) => new Response(JSON.stringify(
    url.pathname === '/build-metadata.json'
      ? { component: 'AnyWear-Client', schema_version: 3, source_commit: clientCommit, client_version: 0, built_at: '2026-10-07T00:00:00.000Z' }
      : { status: 'ok', service_commit: serviceCommit, image_digest: `sha256:${'c'.repeat(64)}`, minimum_client_version: 0 },
  ), { status: 200 });

  const collected = await collectPreflightDeployment(config, tuple, liveFetcher(tuple.client.sha, tuple.service.sha));
  assert.equal(collected.client.source_commit, tuple.client.sha);
  assert.equal(collected.service.service_commit, tuple.service.sha);

  // An absent tuple observes the same live identities without comparing them.
  await assert.doesNotReject(collectPreflightDeployment(config, null, liveFetcher('d'.repeat(40), 'e'.repeat(40))));

  await assert.rejects(collectPreflightDeployment(config, tuple, liveFetcher(tuple.client.sha, 'e'.repeat(40))),
    new RegExp(`Deployed Service service_commit mismatch[^\\n]*expected ${tuple.service.sha} \\(dispatch input\\), observed ${'e'.repeat(40)} \\(live\\)`));
  await assert.rejects(collectPreflightDeployment(config, tuple, liveFetcher('d'.repeat(40), tuple.service.sha)),
    new RegExp(`Deployed Client source_commit mismatch[^\\n]*expected ${tuple.client.sha} \\(dispatch input\\), observed ${'d'.repeat(40)} \\(live\\)`));
});

test('runtime evidence rejects an explicitly failed rollback drill', () => {
  const evidence = validEvidence();
  evidence.drills.push({ id: 'rollback', status: 'failed', evidence: {} });
  assert.throws(
    () => verifyRuntimeDrillEvidence(evidence, compatibility),
    /Optional rollback drill is marked failed/,
  );
});

test('runtime verifier refuses foreign run/user/family, reused task/item, missing restoration and uncommitted cleanup', () => {
  for (const mutate of [
    (record) => { record.run_scope = '124-1-aaaaaaaaaaaaaaaa'; record.synthetic_owner.email = 'e2e-beta-124-1-aaaaaaaaaaaaaaaa-0-01234567@anywear.local'; },
    (record) => { record.synthetic_owner.sub = '123e4567-e89b-12d3-a456-426614174099'; },
    (record) => { delete record.window_control; },
    (record) => { record.window_control.restored = false; },
    (record) => { delete record.cleanup_evidence; },
    (record) => { record.cleanup_evidence.committed.transaction_committed = false; },
    (record) => { record.cleanup_evidence.deletion.known_message.taskId = 'foreign'; },
    (record) => { record.window_control.write_ledger[0].run_scope = 'foreign'; },
    (record) => { record.drills[0].evidence.terminal_audit.before.extraction.task_definition_arn = 'arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-lifecycle:1'; },
    (record) => { record.drills[2].evidence.terminal_audit.before.binding.itemId = record.drills[0].evidence.terminal_audit.before.binding.itemId; },
    (record) => { record.drills[1].evidence.terminal_observers[1].version = 4; },
    (record) => { record.drills[1].evidence.reconnected_request_ids = ['r3', 'r3']; },
    (record) => { record.drills[1].evidence.api_task_arns_after = [record.drills[1].evidence.api_task_arns[0]]; },
  ]) {
    const evidence = structuredClone(validEvidence());
    mutate(evidence);
    assert.throws(() => verifyRuntimeDrillEvidence(evidence, compatibility));
  }
});

test('complete mocked executor retains mode-only audit/window/cleanup evidence and refuses an unreadable admission record before account creation', async () => {
  const record = validEvidence();
  const runEnvironment = { ...environment, GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_SHA: 'a'.repeat(40),
    RUNTIME_DRILL_CONCURRENCY: 'anywear-beta-runtime', RUNTIME_DRILL_CONFIRM: 'beta-runtime-drill', RUNTIME_DRILL_ID: record.drill_id,
    RUNTIME_DRILL_E2E_SHA: 'a'.repeat(40), RUNTIME_DRILL_CLIENT_SHA: compatibility.client.sha, RUNTIME_DRILL_SERVICE_SHA: compatibility.service.sha,
    RUNTIME_DRILL_RUN_SCOPE: record.run_scope };
  const scope = scopeFixture(record.drills[0].evidence.terminal_audit.before.binding);
  const calls = [];
  const adapter = Object.fromEntries(['prepareNonPaidRuntime', 'pauseRuntimeWindow', 'restoreNonPaidRuntime', 'restoreRuntimeWindow'].map((name) => [name, async () => calls.push(name)]));
  adapter.createSyntheticAccount = async ({ deployment }) => { assert.equal(deployment.service.source_commit, compatibility.service.sha); calls.push('account'); return scope; };
  adapter.runWardrobeApiFlow = async () => record.drills[0].evidence;
  adapter.replaceAndRestoreEcs = async () => ({ restart_evidence: record.drills[0].evidence });
  adapter.captureReplicaAttribution = async () => record.drills[1].evidence;
  adapter.runProviderFailureFixture = async () => ({});
  adapter.collectRetryEvidence = async () => record.drills[2].evidence;
  adapter.cleanupOwnedResources = async () => {
    scope.runtimeControl = record.runtime_control;
    scope.cleanupEvidence = record.cleanup_evidence;
    scope.runtimeWindow = { ...record.window_control,
      baseline: Object.fromEntries(Object.entries(record.window_control.baseline_versions).map(([key, version]) => [key, { version }])),
      expected: Object.fromEntries(Object.entries(record.window_control.final_versions).map(([key, version]) => [key, { version }])) };
  };
  const options = { fixtureReader: async () => ({}), fencingReader: async () => record.fencing_ci,
    preflightCollector: async () => ({ admission_mode: 'closed', stack: {}, deployment: { client: { source_commit: compatibility.client.sha }, service: scope.deployment.service } }) };
  assert.equal(verifyRuntimeDrillEvidence(await executeRuntimeDrill(runEnvironment, compatibility, adapter, options), compatibility).passed, true);
  calls.length = 0;
  for (const preflight of [{}, { admission_mode: 'open' }, { admission_mode: undefined }]) {
    await assert.rejects(executeRuntimeDrill(runEnvironment, compatibility, adapter, { ...options,
      preflightCollector: async () => preflight }), /reader-valid \/anywear\/beta\/admission_mode/);
  }
  assert.deepEqual(calls, []);
});
