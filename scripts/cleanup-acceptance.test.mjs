import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createCleanupOperationEnvelope, cleanupExecutionArn, deterministicCleanupExecutionName } from '../tests/support/service-cleanup-operation.ts';
import { byteHash } from './evidence-contract.mjs';
import { assertBootstrap, assertBudget, assertBudgetLeaseChain, assertFixtureRecord, assertIntent, assertOrigin, assertPhaseState, parsePhaseInputs } from './cleanup-acceptance-contract.mjs';
import { assertAcceptanceArtifact, loadAcceptanceOrigin, readAcceptanceArchive } from './cleanup-acceptance-origin.mjs';
import { assertAcceptanceExecution, assertFixtureAfter, assertSameCompletedOperation, assertTeardownApplicationProof, capturedIdentity, cognitoCreationInput,
  createCapturedIdentities, deleteAcceptanceIdentities } from './cleanup-acceptance.mjs';
import { cleanupAcceptanceFixture } from './fixtures/cleanup-acceptance.mjs';

test('bootstrap binds immutable intent, exact slots, leases, request bytes and fixed tuple', () => {
  const f = cleanupAcceptanceFixture();
  assertIntent(f.intent, f.intentOrigin);
  assertBootstrap(f.bootstrap, f.origin, f.intent, '2026-10-10T00:00:30Z', f.metadataArtifact.created_at);
  assertBudget(f.intentBudget, f.intent, { intent: true }); assertBudget(f.budget, f.bootstrap);
  assertBudgetLeaseChain(f.intentBudget, f.budget);
  for (const change of [b => b.identities[0].slot = 0, b => b.identities[1].sub = b.identities[0].sub,
    b => b.fixture_request += ' ', b => b.cleanup_requests.primary.json = b.cleanup_requests.sentinel.json,
    b => b.identities[0].lease_generation = '5', b => b.identities[0].create_started_at = '2026-10-10T00:00:29Z',
    b => b.identities[0].captured_at = '2026-10-10T00:01:01Z', b => b.frozen_tuple.state_machine_version_arn = b.frozen_tuple.state_machine_version_arn.replace(':7', ''),
    b => b.extra = true]) {
    const b = structuredClone(f.bootstrap); change(b);
    assert.throws(() => assertBootstrap(b, f.origin, f.intent, '2026-10-10T00:00:30Z', f.metadataArtifact.created_at));
  }
});

test('budget rejects expanded pools, unknown nested fields, changed leases and pre-captured provisioning', () => {
  const f = cleanupAcceptanceFixture();
  for (const change of [b => b.accounts[0].email = 'e2e-beta-worker-0-chromium@anywear.local', b => b.accounts.push(b.accounts[0]),
    b => b.accounts[0].status = 'deleted', b => b.accounts[0].leaseGeneration = b.accounts[1].leaseGeneration,
    b => b.accounts[0].extra = true, b => b.config.maxNewAccountsPerRun = 4]) {
    const b = structuredClone(f.budget); change(b); assert.throws(() => assertBudget(b, f.bootstrap));
  }
  const intent = structuredClone(f.intentBudget); intent.accounts[0].subject = f.bootstrap.identities[0].sub;
  assert.throws(() => assertBudget(intent, f.intent, { intent: true }));
  const changed = structuredClone(f.budget); changed.accounts[0].leaseId = '50000000-0000-4000-8000-000000000000';
  assert.throws(() => assertBudgetLeaseChain(f.intentBudget, changed));
});

test('phase routes require exact fixture evidence and reject imported bootstrap authority', () => {
  const f = cleanupAcceptanceFixture();
  assert.equal(parsePhaseInputs({ ACCEPTANCE_PHASE: 'bootstrap', ACCEPTANCE_FROZEN_TUPLE: JSON.stringify(f.bootstrap.frozen_tuple) }).phase, 'bootstrap');
  assert.throws(() => parsePhaseInputs({ ACCEPTANCE_PHASE: 'bootstrap', ACCEPTANCE_BOOTSTRAP_ORIGIN: JSON.stringify(f.origin), ACCEPTANCE_FROZEN_TUPLE: JSON.stringify(f.bootstrap.frozen_tuple) }));
  assert.throws(() => parsePhaseInputs({ ACCEPTANCE_PHASE: 'refusals', ACCEPTANCE_BOOTSTRAP_ORIGIN: JSON.stringify(f.origin), ACCEPTANCE_FIXTURE_ORIGINS: '[]' }));
  assert.throws(() => assertOrigin({ ...f.origin, workflow_path: '.github/workflows/account-recovery.yml' }));
  const state = { schema_version: 1, record_type: 'anywear_e2e_cleanup_acceptance_phase', issue: 86, phase: 'refusals', producer: f.bootstrap.producer,
    bootstrap_origin: f.origin, previous_origin: null, fixture_origins: [], result: 'in-progress', operations: {}, cognito: [], checkpoint: 'complete' };
  assert.throws(() => assertPhaseState(state, f.origin, f.bootstrap, f.origin, 'refusals'));
});

function refusalState(f, combined = false) {
  const activeOrigin = { ...f.origin, run_id: 43, artifact_id: 201 };
  const origin = combined ? { ...f.origin, run_id: 44, artifact_id: 202 } : activeOrigin;
  const inspector = id => ({ ...f.origin, repository: 'git-malu/AnyWear-Infra', run_id: id, artifact_id: id, source_sha: 'd'.repeat(40) });
  const baseline = f.bootstrap.identities.map((identity, index) => ({ role: index ? 'sentinel' : 'primary', slot: identity.slot, user_id: identity.sub,
    email: identity.email, absent: false, user: { snapshot_sha256: '1'.repeat(64), daily_credits: 0 },
    item: { id: `50000000-0000-4000-8000-00000000000${index}`, status: index ? 'ready' : 'processing', snapshot_sha256: '2'.repeat(64) },
    task: index ? null : { id: '60000000-0000-4000-8000-000000000000', status: 'pending', snapshot_sha256: '3'.repeat(64),
      available_at: '2100-01-01T00:00:00.000Z', execution_token: 0, attempt_count: 0, unclaimed: true }, outbox: 0 }));
  const refusal = (request, producerOrigin) => {
    const input = createCleanupOperationEnvelope({ action: 'cleanup', emails: '[]', cleanup_json: f.bootstrap.cleanup_requests[request].json },
      { E2E_CLEANUP_SERVICE_SOURCE_SHA: f.bootstrap.frozen_tuple.service_source_sha, E2E_CLEANUP_SERVICE_IMAGE_DIGEST: f.bootstrap.frozen_tuple.service_image_digest });
    const name = deterministicCleanupExecutionName(input), arn = cleanupExecutionArn(f.bootstrap.frozen_tuple.state_machine_version_arn, name);
    const tasks = ['verification', 'cleanup'].map((kind, index) => {
      const prefix = kind === 'verification' ? 'beta-anywear-cleanup-verify' : 'beta-anywear-cleanup';
      return { task_arn: `arn:aws:ecs:ap-east-1:650880818323:task/beta-anywear/${String(index + 1).repeat(32)}`,
        task_definition_arn: `arn:aws:ecs:ap-east-1:650880818323:task-definition/${prefix}:7`, kind, status: 'STOPPED', exit_code: index,
        image_digest: input.service_image_digest, service_commit_sha: input.service_commit_sha, log_group: '/anywear/beta/one-shot',
        log_stream: `${prefix}/OneShot/${String(index + 1).repeat(32)}`, ...(index ? { envelope_sha256: byteHash(JSON.stringify(input)) } : {}) };
    });
    return { producer: Object.fromEntries(['repository', 'workflow_path', 'source_sha', 'run_id', 'run_attempt'].map(key => [key, producerOrigin[key]])),
      evidence: { schema_version: 3, record_type: 'anywear_e2e_service_cleanup_operation', operation: { operation_mode: 'normal', state_machine_version_arn: f.bootstrap.frozen_tuple.state_machine_version_arn,
        execution_arn: arn, execution_name: name, status: 'FAILED', proof_status: 'refused', input_sha256: byteHash(JSON.stringify(input)), input } },
      failure_proof: { schema_version: 1, record_type: 'anywear_e2e_cleanup_refusal_proof', execution_arn: arn, started_at: '2026-10-10T00:03:00Z', stopped_at: '2026-10-10T00:04:00Z',
        status: 'FAILED', input_sha256: byteHash(JSON.stringify(input)), tasks, committed_marker_observed: false, log_snapshot_sha256: '4'.repeat(64) } };
  };
  const state = { schema_version: 1, record_type: 'anywear_e2e_cleanup_acceptance_phase', issue: 86, phase: 'refusals',
    producer: Object.fromEntries(['repository', 'workflow_path', 'source_sha', 'run_id', 'run_attempt'].map(key => [key, origin[key]])),
    bootstrap_origin: f.origin, previous_origin: combined ? activeOrigin : null,
    fixture_origins: combined ? [{ action: 'inspect', origin: inspector(302) }] : [{ action: 'prepare', origin: inspector(300) }, { action: 'inspect', origin: inspector(301) }],
    result: combined ? 'exact-refusals-observed-identities-retained' : 'active-refusal-observed-identities-retained', checkpoint: 'complete', cognito: [],
    operations: { refusal_stage: combined ? 'combined' : 'active', fixture_baseline: baseline,
      inspections: { before_active: { origin: inspector(301), snapshot: structuredClone(baseline) }, ...(combined ? { after_active: { origin: inspector(302), snapshot: structuredClone(baseline) } } : {}) },
      active: refusal('primary', activeOrigin), ...(combined ? { mismatch: refusal('mismatch', origin) } : {}) } };
  return { origin, state };
}

test('ordered refusal states require two exact proofs and a fresh unchanged fixture inspection', () => {
  const f = cleanupAcceptanceFixture(), active = refusalState(f), combined = refusalState(f, true);
  assertPhaseState(active.state, active.origin, f.bootstrap, f.origin, 'refusals', { refusalStage: 'active' });
  assertPhaseState(combined.state, combined.origin, f.bootstrap, f.origin, 'refusals');
  assert.throws(() => assertPhaseState(active.state, active.origin, f.bootstrap, f.origin, 'refusals'));
  for (const change of [s => delete s.operations.active, s => delete s.operations.mismatch,
    s => s.operations.mismatch = s.operations.active, s => s.operations.active.producer.source_sha = 'e'.repeat(40),
    s => s.operations.inspections.after_active.snapshot[1].item.snapshot_sha256 = '5'.repeat(64),
    s => s.operations.inspections.after_active.origin = s.operations.inspections.before_active.origin,
    s => s.operations.active.failure_proof.committed_marker_observed = true, s => s.cognito.push({ status: 'deleted' })]) {
    const changed = structuredClone(combined.state); change(changed);
    assert.throws(() => assertPhaseState(changed, combined.origin, f.bootstrap, f.origin, 'refusals'));
  }
  const input = { ACCEPTANCE_PHASE: 'refusals', ACCEPTANCE_BOOTSTRAP_ORIGIN: JSON.stringify(f.origin), ACCEPTANCE_PREVIOUS_ORIGIN: JSON.stringify(active.origin),
    ACCEPTANCE_FIXTURE_ORIGINS: JSON.stringify(combined.state.fixture_origins) };
  assert.equal(parsePhaseInputs(input).previousOrigin.run_id, 43);
  assert.throws(() => parsePhaseInputs({ ...input, ACCEPTANCE_FIXTURE_ORIGINS: JSON.stringify(active.state.fixture_origins) }));
});

function fixtureRecord(f) {
  const origin = { ...f.origin, repository: 'git-malu/AnyWear-Infra', source_sha: '9'.repeat(40), run_id: 300, artifact_id: 300 };
  const tuple = f.bootstrap.frozen_tuple, snapshots = refusalState(f).state.operations.fixture_baseline;
  const taskArn = `arn:aws:ecs:ap-east-1:650880818323:task/beta-anywear/${'6'.repeat(32)}`;
  const environment = { admission: { admission_suspended: true, intake_open: false }, definition: { taskDefinitionArn: tuple.fixture_task_definition_arn } };
  const record = { schema_version: 1, record_type: 'anywear_beta_cleanup_acceptance_operation', result: 'committed-result-and-preserved-state-verified',
    executor: { repository: origin.repository, source_sha: origin.source_sha, workflow_ref: `${origin.repository}/${origin.workflow_path}@refs/heads/main`,
      run_id: String(origin.run_id), run_attempt: String(origin.run_attempt) }, fixture_source_sha: tuple.fixture_source_sha,
    task_definition_arn: tuple.fixture_task_definition_arn, action: 'inspect', run_scope: f.bootstrap.run_scope,
    request_sha256: f.bootstrap.fixture_request_sha256, selection: { file: 'selections/fixture.json', sha256: tuple.selection_sha256,
      service_sha: tuple.service_source_sha, image_digest: tuple.service_image_digest }, stack_sources: { file: 'stack-sources/fixture.json', sha256: tuple.stack_sources_sha256 },
    stack_manifest: ['AnyWearPlatformStack-beta', 'AnyWearWorkloadStack-beta', 'AnyWearFoundationStack', 'AnyWearBillingStack-beta'].map(stack_name => ({
      stack_name, region: stack_name.includes('Billing') ? 'us-east-1' : 'ap-east-1', source_repository: 'git-malu/AnyWear-Infra', source_sha: tuple.fixture_source_sha })),
    bootstrap: { origin: f.origin, manifest: f.bootstrap }, original: environment, launch_attempted: true, launch_input_sha256: '8'.repeat(64),
    launch_response: { task_arns: [taskArn], task_count: 1, failure_count: 0, unidentified_task_count: 0, identities_truncated: false }, task_arn: taskArn,
    task_observation: { task_arn: taskArn, cluster_arn: 'arn:aws:ecs:ap-east-1:650880818323:cluster/beta-anywear', task_definition_arn: tuple.fixture_task_definition_arn,
      status: 'STOPPED', container: { name: 'OneShot', status: 'STOPPED', exit_code: 0, image_digest: tuple.service_image_digest },
      overrides: { containerOverrides: [{ name: 'OneShot', command: ['node', 'dist/ops/beta-cleanup-acceptance-fixture.js', 'inspect', f.bootstrap.fixture_request] }] } },
    service_result: { schema_version: 1, record_type: 'anywear_beta_cleanup_acceptance_result', action: 'inspect', run_scope: f.bootstrap.run_scope,
      request_sha256: f.bootstrap.fixture_request_sha256, service_commit_sha: tuple.service_source_sha, service_image_digest: tuple.service_image_digest,
      transaction_committed: true, queue_calls: 0, provider_calls: 0, lifecycle_changes: 0, before: snapshots, after: snapshots }, final: environment };
  return { origin, record };
}

test('fixture records bind raw stack source hash, all explicit producers and actual stopped launch/command/image proof', () => {
  const f = cleanupAcceptanceFixture(), { origin, record } = fixtureRecord(f);
  assertFixtureRecord(record, origin, f.bootstrap, f.origin, 'inspect');
  // Dual run: the historical v2 carrier stays interpretable alongside stack_manifest.
  const historical = structuredClone(record);
  historical.reviewed_stack_sources = structuredClone(record.stack_manifest);
  delete historical.stack_manifest;
  assertFixtureRecord(historical, origin, f.bootstrap, f.origin, 'inspect');
  const both = structuredClone(record);
  both.reviewed_stack_sources = structuredClone(record.stack_manifest);
  assert.throws(() => assertFixtureRecord(both, origin, f.bootstrap, f.origin, 'inspect'));
  const dropped = structuredClone(record);
  delete dropped.stack_manifest;
  assert.throws(() => assertFixtureRecord(dropped, origin, f.bootstrap, f.origin, 'inspect'));
  const inert = structuredClone(record);
  inert.task_observation.overrides.inferenceAcceleratorOverrides = [];
  assertFixtureRecord(inert, origin, f.bootstrap, f.origin, 'inspect');
  for (const change of [r => delete r.stack_sources, r => r.stack_sources.sha256 = '0'.repeat(64), r => r.stack_sources.file = '../fixture.json',
    r => r.stack_manifest[1].source_sha = '0'.repeat(40), r => r.stack_manifest[1].source_repository = 'git-malu/AnyWear-Service',
    r => r.stack_manifest[0] = r.stack_manifest[1], r => r.stack_manifest[3].region = 'ap-east-1',
    r => r.stack_manifest[0].extra = true, r => r.launch_response.task_count = 2, r => r.launch_response.failure_count = 1,
    r => r.launch_response.unidentified_task_count = 1, r => r.launch_response.identities_truncated = true,
    r => r.task_observation.status = 'RUNNING', r => r.task_observation.task_definition_arn = r.task_observation.task_definition_arn.replace(':7', ':8'),
    r => r.task_observation.container.image_digest = `sha256:${'0'.repeat(64)}`, r => r.task_observation.container.exit_code = 1,
    r => r.task_observation.overrides.containerOverrides[0].command[2] = 'cleanup',
    r => r.task_observation.overrides.containerOverrides[0].command[3] += ' ', r => r.task_observation.overrides.taskRoleArn = 'foreign',
    r => r.task_observation.overrides.inferenceAcceleratorOverrides = ['foreign']]) {
    const changed = structuredClone(record); change(changed);
    assert.throws(() => assertFixtureRecord(changed, origin, f.bootstrap, f.origin, 'inspect'));
  }
});

test('fixture actions must start after the previous completed operation, not concurrently or with unknown time', () => {
  const prior = { updated_at: '2026-10-10T00:01:00Z' };
  assertFixtureAfter({ run_started_at: '2026-10-10T00:02:00Z' }, prior);
  for (const time of ['2026-10-10T00:00:00Z', prior.updated_at, 'unknown']) assert.throws(() => assertFixtureAfter({ run_started_at: time }, prior));
  assert.throws(() => assertFixtureAfter({ run_started_at: '2026-10-10T00:02:00Z' }, { updated_at: 'unknown' }));
});

test('artifact provenance rejects fork/numeric owner drift, wrong source/attempt and legacy names', () => {
  const f = cleanupAcceptanceFixture();
  const verify = (run = f.metadataRun, artifact = f.metadataArtifact) => assertAcceptanceArtifact(f.origin, run, artifact, f.metadataArtifact.name, { now: Date.parse('2026-10-10T00:03:00Z') });
  verify();
  assertAcceptanceArtifact(f.origin, { ...f.metadataRun, status: 'in_progress', conclusion: null }, f.metadataArtifact, f.metadataArtifact.name, { inProgress: true, now: Date.parse('2026-10-10T00:03:00Z') });
  for (const conclusion of ['success', 'failure', 'cancelled']) assert.throws(() => assertAcceptanceArtifact(f.origin,
    { ...f.metadataRun, status: 'completed', conclusion }, f.metadataArtifact, f.metadataArtifact.name, { inProgress: true }));
  for (const change of [r => r.repository.id++, r => r.head_repository = { ...r.head_repository, id: 1 }, r => r.repository.owner.login = 'other',
    r => r.repository.owner.id++, r => r.run_attempt++, r => r.head_sha = 'e'.repeat(40), r => r.conclusion = 'failure', r => r.head_branch = 'other']) {
    const run = structuredClone(f.metadataRun); change(run); assert.throws(() => verify(run));
  }
  for (const change of [a => a.workflow_run.head_branch = 'other', a => a.workflow_run.head_repository_id++, a => a.id++, a => a.name = 'beta-account-lifecycle-42-1',
    a => a.digest = `sha256:${'1'.repeat(64)}`, a => a.expired = true]) {
    const artifact = structuredClone(f.metadataArtifact); change(artifact); assert.throws(() => verify(f.metadataRun, artifact));
  }
});

test('origin loader authenticates before and after bounded archive reads with scoped read token', async () => {
  const f = cleanupAcceptanceFixture(), calls = [];
  const directory = await mkdtemp(join(tmpdir(), 'acceptance-origin-'));
  const api = (path, binary, environment) => {
    assert.equal(environment.GH_TOKEN, 'read-only'); assert.equal(environment.GITHUB_TOKEN, undefined); calls.push(path);
    if (binary) return Buffer.from('bootstrap-zip');
    return JSON.stringify(path.includes('/runs/') ? f.metadataRun : f.metadataArtifact);
  };
  try {
    await assert.rejects(() => loadAcceptanceOrigin(f.origin, { name: f.metadataArtifact.name, file: 'bootstrap-manifest.json', inProgress: true,
      environment: { E2E_EVIDENCE_READ_TOKEN: 'read-only', GITHUB_REPOSITORY: f.origin.repository, GITHUB_SHA: f.origin.source_sha,
        GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '1' }, api: () => assert.fail('foreign in-progress read must stop before API') }));
    await loadAcceptanceOrigin(f.origin, { name: f.metadataArtifact.name, file: 'bootstrap-manifest.json', directory,
      environment: { E2E_EVIDENCE_READ_TOKEN: 'read-only', GITHUB_TOKEN: 'do-not-use' }, api,
      extract: () => ({ 'bootstrap-manifest.json': Buffer.from(JSON.stringify(f.bootstrap)) }) });
    assert.equal(calls.filter(path => path.includes('/runs/')).length, 2);
    assert.equal(calls.filter(path => /artifacts\/200$/.test(path)).length, 2);
    let artifactReads = 0;
    await assert.rejects(() => loadAcceptanceOrigin(f.origin, { name: f.metadataArtifact.name, file: 'bootstrap-manifest.json', directory,
      environment: { E2E_EVIDENCE_READ_TOKEN: 'read-only' }, api: (path, binary, environment) => {
        if (/artifacts\/200$/.test(path) && ++artifactReads === 2) return JSON.stringify({ ...f.metadataArtifact, expired: true });
        return api(path, binary, environment);
      }, extract: () => ({ 'bootstrap-manifest.json': Buffer.from(JSON.stringify(f.bootstrap)) }) }));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('ZIP reads reject symlinks, directories, duplicate names, path traversal and excessive files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'acceptance-zip-'));
  try {
    for (const kind of ['regular', 'symlink', 'directory', 'duplicate', 'traversal', 'oversize']) {
      const path = join(directory, `${kind}.zip`);
      execFileSync('python3', ['-c', [
        'import sys,zipfile', 'kind=sys.argv[2]', 'with zipfile.ZipFile(sys.argv[1],"w") as z:',
        ' info=zipfile.ZipInfo("safe.json" if kind!="traversal" else "../safe.json")',
        ' info.external_attr=(0o120777 if kind=="symlink" else 0o40755 if kind=="directory" else 0o100600)<<16',
        ' z.writestr(info, "x"*1048577 if kind=="oversize" else "{}")',
        ' if kind=="duplicate": z.writestr("safe.json","{}")',
      ].join('\n'), path, kind], { stdio: 'pipe' });
      if (kind === 'regular') assert.deepEqual(readAcceptanceArchive(path, ['safe.json'])['safe.json'], Buffer.from('{}'));
      else assert.throws(() => readAcceptanceArchive(path, ['safe.json']));
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('bootstrap creates only SUPPRESS unconfirmed identities after freshness and never reuses an existing user', async () => {
  const f = cleanupAcceptanceFixture(), calls = [];
  assert.deepEqual(Object.keys(cognitoCreationInput(f.bootstrap.identities[0].email, 'pool')), ['UserPoolId', 'Username', 'MessageAction', 'UserAttributes']);
  const created = new Set();
  const user = identity => ({ Username: identity.username, UserStatus: 'FORCE_CHANGE_PASSWORD', UserAttributes: [
    { Name: 'email', Value: identity.email }, { Name: 'sub', Value: identity.sub }, { Name: 'custom:e2e_bootstrap', Value: 'true' }, { Name: 'email_verified', Value: 'true' },
  ] });
  const io = { get: async email => { calls.push(['get', email]); if (!created.has(email)) throw Object.assign(new Error(), { name: 'UserNotFoundException' }); return user(f.bootstrap.identities.find(identity => identity.email === email)); },
    create: async email => { calls.push(['create', email]); created.add(email); } };
  const result = await createCapturedIdentities(f.intent, io, { before: async () => calls.push(['intent']), captured: async () => calls.push(['capture']) });
  assert.deepEqual(result.map(row => row.sub), f.bootstrap.identities.map(row => row.sub));
  assert.deepEqual(calls.map(row => row[0]), ['get', 'intent', 'create', 'get', 'capture', 'get', 'intent', 'create', 'get', 'capture']);
  await assert.rejects(() => createCapturedIdentities(f.intent, { get: async () => user(f.bootstrap.identities[0]), create: async () => assert.fail('must not reuse') }, { before: async () => {}, captured: async () => {} }));
  await assert.rejects(() => createCapturedIdentities(f.intent, { get: async () => { throw Object.assign(new Error(), { name: 'UserNotFoundException' }); },
    create: async () => { throw Object.assign(new Error(), { name: 'UsernameExistsException' }); } }, { before: async () => {}, captured: async () => assert.fail('must not infer capture') }));
  assert.throws(() => capturedIdentity({ ...user(f.bootstrap.identities[0]), UserStatus: 'CONFIRMED' }, f.bootstrap.identities[0]));
});

test('teardown refuses changed immutable usernames/subjects and reads back exact absence', async () => {
  const f = cleanupAcceptanceFixture(), deleted = [];
  const identity = f.bootstrap.identities[0];
  const user = { Username: identity.username, UserStatus: 'FORCE_CHANGE_PASSWORD', UserAttributes: [
    { Name: 'email', Value: identity.email }, { Name: 'sub', Value: identity.sub }, { Name: 'custom:e2e_bootstrap', Value: 'true' }, { Name: 'email_verified', Value: 'true' },
  ] };
  for (const changed of [{ ...user, Username: 'changed' }, { ...user, UserAttributes: user.UserAttributes.map(row => row.Name === 'sub' ? { ...row, Value: '10000000-0000-4000-8000-000000000009' } : row) }]) {
    await assert.rejects(() => deleteAcceptanceIdentities([identity], { get: async () => changed, delete: async () => assert.fail('must retain') }, async () => {}, async () => assert.fail('must not mark deleted')));
  }
  let missing = false;
  await deleteAcceptanceIdentities([identity], { get: async username => { assert.equal(username, identity.username); if (missing) throw Object.assign(new Error(), { name: 'UserNotFoundException' }); return user; },
    delete: async username => { deleted.push(username); missing = true; } }, async () => {}, async () => {});
  assert.deepEqual(deleted, [identity.username]);
});

test('missing mutable email alias never marks a retained immutable Cognito identity deleted', async () => {
  const identity = cleanupAcceptanceFixture().bootstrap.identities[0], lookups = [];
  const changed = { Username: identity.username, UserStatus: 'FORCE_CHANGE_PASSWORD', UserAttributes: [
    { Name: 'email', Value: 'changed@anywear.local' }, { Name: 'sub', Value: identity.sub },
    { Name: 'custom:e2e_bootstrap', Value: 'true' }, { Name: 'email_verified', Value: 'true' },
  ] };
  await assert.rejects(() => deleteAcceptanceIdentities([identity], {
    get: async username => { lookups.push(username); if (username === identity.email) throw Object.assign(new Error(), { name: 'UserNotFoundException' }); return changed; },
    delete: async () => assert.fail('changed captured email must retain identity'),
  }, async () => assert.fail('changed capture must refuse before deletion'), async () => assert.fail('retained immutable user must not be marked deleted')));
  assert.deepEqual(lookups, [identity.username]);
});

test('post-delete alias mutation cannot replace exact immutable username absence read-back', async () => {
  const identity = cleanupAcceptanceFixture().bootstrap.identities[0], lookups = [];
  const user = { Username: identity.username, UserStatus: 'FORCE_CHANGE_PASSWORD', UserAttributes: [
    { Name: 'email', Value: identity.email }, { Name: 'sub', Value: identity.sub },
    { Name: 'custom:e2e_bootstrap', Value: 'true' }, { Name: 'email_verified', Value: 'true' },
  ] };
  let attempted = false;
  await assert.rejects(() => deleteAcceptanceIdentities([identity], {
    get: async username => {
      lookups.push(username);
      if (username === identity.email) throw Object.assign(new Error(), { name: 'UserNotFoundException' });
      return attempted ? { ...user, UserAttributes: user.UserAttributes.map(row => row.Name === 'email' ? { ...row, Value: 'changed@anywear.local' } : row) } : user;
    }, delete: async username => { assert.equal(username, identity.username); attempted = true; },
  }, async () => {}, async () => assert.fail('retained immutable user must not be marked deleted')), /immutable identity remains/);
  assert.equal(attempted, true); assert.deepEqual(lookups, [identity.username, identity.username]);
});

test('already absent captured immutable user reconciles without reading or deleting a replacement email alias', async () => {
  const identity = cleanupAcceptanceFixture().bootstrap.identities[0], lookups = [], reconciled = [];
  await deleteAcceptanceIdentities([identity], {
    get: async username => { assert.equal(username, identity.username); lookups.push(username); throw Object.assign(new Error(), { name: 'UserNotFoundException' }); },
    delete: async () => assert.fail('already absent captured identity needs no deletion'),
  }, async () => assert.fail('absent identity has no deletion intent'), async actual => reconciled.push(actual));
  assert.deepEqual(lookups, [identity.username, identity.username]); assert.deepEqual(reconciled, [identity]);
  await assert.rejects(() => deleteAcceptanceIdentities([{ ...identity, username: identity.email }], {
    get: async () => assert.fail('mutable aliases must refuse before lookup'), delete: async () => assert.fail('must not delete'),
  }, async () => {}, async () => assert.fail('must not mark deleted')));
});

test('Cognito teardown is gated by verified exact primary and sentinel application proof', () => {
  const f = cleanupAcceptanceFixture();
  const refusal = refusalState(f, true).state.operations;
  const verified = (request, retry) => {
    const source = structuredClone(request === 'primary' ? refusal.active.evidence : refusal.mismatch.evidence);
    const input = createCleanupOperationEnvelope({ action: 'cleanup', emails: '[]', cleanup_json: f.bootstrap.cleanup_requests[request].json },
      { E2E_CLEANUP_SERVICE_SOURCE_SHA: f.bootstrap.frozen_tuple.service_source_sha, E2E_CLEANUP_SERVICE_IMAGE_DIGEST: f.bootstrap.frozen_tuple.service_image_digest });
    const base = deterministicCleanupExecutionName(input), name = retry ? `${base.slice(0, 72)}-retry1` : base;
    const tasks = structuredClone(refusal.active.failure_proof.tasks); tasks[1].exit_code = 0; tasks[1].envelope_sha256 = byteHash(JSON.stringify(input));
    Object.assign(source.operation, { input, input_sha256: byteHash(JSON.stringify(input)), execution_name: name,
      execution_arn: cleanupExecutionArn(f.bootstrap.frozen_tuple.state_machine_version_arn, name), status: 'SUCCEEDED', proof_status: 'verified',
      started_at: '2026-10-10T00:03:00Z', stopped_at: '2026-10-10T00:04:00Z', tasks,
      committed_result: { schema_version: 1, record_type: 'anywear_beta_cleanup_result', source: 'beta-tester-cleanup', cleanup: 'beta-testers',
        transaction_committed: true, operation_mode: input.operation_mode, operation_id: input.operation_id, request_sha256: input.request_sha256, run_scope: input.run_scope,
        service_commit_sha: input.service_commit_sha, service_image_digest: input.service_image_digest, envelope_sha256: byteHash(JSON.stringify(input)),
        users: 1, items: 1, tasks: request === 'primary' ? 1 : 0, missingUsers: 0, outbox: 0, idempotency: 0, generations: 0, relations: 0, outfits: 0, photos: 0 } });
    return source;
  };
  const primary = verified('primary', true), sentinel = verified('sentinel', false);
  assertTeardownApplicationProof(primary, sentinel, f.bootstrap);
  for (const change of [s => s.operation.proof_status = 'pending', s => s.operation.tasks[1].status = 'RUNNING',
    s => s.operation.committed_result.users = 2, s => s.operation.committed_result.transaction_committed = false,
    s => s.operation.committed_result.photos = 1, s => s.operation.input = primary.operation.input]) {
    const changed = structuredClone(sentinel); change(changed); assert.throws(() => assertTeardownApplicationProof(primary, changed, f.bootstrap));
  }
});

test('replay rejects changed execution, start, task or committed-result identity', () => {
  const first = { operation: { execution_arn: 'exact', execution_name: 'exact', started_at: 'start', stopped_at: 'stop', input_sha256: 'hash', output: {}, tasks: [{ task_arn: 'first' }], committed_result: {} } };
  assertSameCompletedOperation(first, structuredClone(first));
  for (const change of [o => o.execution_arn = 'new', o => o.started_at = 'new', o => o.tasks[0].task_arn = 'new', o => o.committed_result.changed = true]) {
    const other = structuredClone(first); change(other.operation); assert.throws(() => assertSameCompletedOperation(first, other));
  }
});

test('workflow/runner contain only the bounded identity and SFN path with no fixture or lifecycle writer', async () => {
  const workflow = await readFile(new URL('../.github/workflows/beta-cleanup-acceptance.yml', import.meta.url), 'utf8');
  const source = await readFile(new URL('./cleanup-acceptance.mjs', import.meta.url), 'utf8');
  assert.match(workflow, /group: beta-e2e-account-pool/); assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /permission-actions: read/); assert.doesNotMatch(workflow, /actions: write|permission-actions: write|ENABLE_BETA_DEPLOY|workflow run|aws ecs run-task|PassRole|RegisterTaskDefinition/);
  assert.doesNotMatch(source, /AdminSetUserPassword|AdminConfirmSignUp|InitiateAuth|cleanupWorkerAccounts|fetch\(|\.goto\(/);
  const f = cleanupAcceptanceFixture();
  const env = { GITHUB_REPOSITORY: 'git-malu/AnyWear-E2E', GITHUB_REPOSITORY_ID: '1317091305', GITHUB_REPOSITORY_OWNER: 'git-malu', GITHUB_REPOSITORY_OWNER_ID: '11473072',
    GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch', E2E_STAGE: 'beta', ENABLE_INFRA_E2E: 'true', GITHUB_SHA: f.origin.source_sha, GITHUB_WORKFLOW_SHA: f.origin.source_sha,
    GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-E2E/.github/workflows/beta-cleanup-acceptance.yml@refs/heads/main', GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '1',
    AWS_ACCOUNT_ID: '650880818323', AWS_REGION: 'ap-east-1', E2E_CLEANUP_SERVICE_SHA: f.bootstrap.frozen_tuple.service_source_sha,
    E2E_WORKERS: '2', E2E_WORKER_SLOT_OFFSET: '2', E2E_MAX_ACTIVE_ACCOUNTS: '2', E2E_MAX_NEW_ACCOUNTS_PER_RUN: '2', E2E_MAX_QUARANTINED_ACCOUNTS: '2' };
  assertAcceptanceExecution(env, { sourceOnly: true, sourceSha: f.origin.source_sha });
  assert.throws(() => assertAcceptanceExecution({ ...env, E2E_WORKER_SLOT_OFFSET: '0' }, { sourceOnly: true, sourceSha: f.origin.source_sha }));
});
