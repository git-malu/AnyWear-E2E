import assert from 'node:assert/strict';
import test from 'node:test';
import { byteHash, canonicalJson, parseStrictJson, payloadDigest, validateCompatibility } from './evidence-contract.mjs';
import { qualificationFixture } from './fixtures/infra-qualification.mjs';
import { assertE2EExecution } from './execution-guard.mjs';
import { assertDeploymentBinding, assertSealedRelease, assertTrustedArtifact, assertTrustedRun } from './trusted-deployment-inputs.mjs';
import { buildQualificationRecord, collectDeploymentEvidence, verifyQualificationForPromotion, verifyQualificationRecord } from './qualification-record.mjs';
import { assertRecoveryArtifact, prepareAccountRecovery } from './account-recovery-inputs.mjs';
import { assertServiceCleanupRunSource } from '../tests/support/service-cleanup-dispatch.ts';

const now = new Date('2026-10-08T00:20:00.000Z');
const qualify = (f) => buildQualificationRecord(f.input, f.compatibility, f.evidence, now);

test('strict JSON rejects escaped duplicate keys, invalid UTF-8/Unicode and non-JSON values', () => {
  for (const source of ['{"a":1,"\\u0061":2}', '{"a":{"x":1,"x":2}}', '1e999', '"\\ud800"', '\u00a0{}', '{"a":1,}', '[1,]']) {
    assert.throws(() => parseStrictJson(source));
  }
  assert.throws(() => parseStrictJson(Buffer.from([0xc0, 0xaf])));
  const proto = parseStrictJson('{"__proto__":{"unexpected":true}}');
  assert.equal(Object.hasOwn(proto, '__proto__'), true);
  assert.equal({}.unexpected, undefined);
  assert.equal(canonicalJson(parseStrictJson('{"z":1,"a":2}')), '{"a":2,"z":1}');
});

test('v1 can pass offline source checks but cannot authorize Infra qualification', () => {
  const f = qualificationFixture();
  const v1 = { version: 1, client: f.compatibility.client, service: f.compatibility.service };
  assert.doesNotThrow(() => validateCompatibility(v1, { allowLegacy: true }));
  assert.throws(() => validateCompatibility(v1), /version must be 2/);
  assert.throws(() => verifyQualificationRecord({ schema_version: 1, record_type: 'anywear_beta_qualification' }), /Unsupported/);
  for (const mutate of [
    (c) => { c.infra.sha = 'main'; },
    (c) => { c.service_artifacts.release_id = '10'; },
    (c) => { c.deployment.record_sha256 = 'a'.repeat(63); },
    (c) => { c.infra.repository = 'other/Infra'; },
    (c) => { c.future = true; },
  ]) {
    const c = structuredClone(f.compatibility); mutate(c); assert.throws(() => validateCompatibility(c));
  }
});

test('qualification v2 accepts independently observed stable tuple and forward-compatible DB17/image16', () => {
  for (const forwardSchema of [false, true]) {
    const record = qualify(qualificationFixture({ forwardSchema }));
    assert.equal(record.schema_version, 2);
    assert.equal(record.observations.after.authenticated.schema.applied_schema_version, forwardSchema ? 17 : 16);
    assert.equal(verifyQualificationRecord(record), true);
  }
});

test('image17/minimum16 can qualify DB16 only with the reviewed minimum migration boundary', () => {
  const f = qualificationFixture({ imageAhead: true });
  const record = qualify(f);
  assert.equal(record.observations.after.authenticated.schema.selected_migration_ids.length, 18);
  assert.equal(record.observations.after.authenticated.schema.applied_migration_ids.length, 17);
  assert.equal(verifyQualificationRecord(record), true);
  const bad = qualificationFixture({ imageAhead: true });
  bad.evidence.after.authenticated.schema.minimum_migration_count = 18;
  assert.throws(() => qualify(bad));
});

test('changed template, Lambda config, policy, schema, source or endpoint prevents qualification', () => {
  for (const mutate of [
    (f) => { f.evidence.after.authenticated.stacks[0].template_sha256 = 'a'.repeat(64); },
    (f) => { f.evidence.after.authenticated.observed.lambdas['pre-sign-up'].configuration_sha256 = 'a'.repeat(64); },
    (f) => { f.evidence.after.authenticated.observed.ecs.api.task_definition_arn = 'arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-api:2'; },
    (f) => { f.evidence.after.authenticated.observed.policy_content_sha256 = 'b'.repeat(64); },
    (f) => { f.evidence.after.authenticated.schema.applied_schema_version = 15; },
    (f) => { f.evidence.after.authenticated.schema.applied_migration_ids[1].id = 'e'.repeat(64); },
    (f) => { f.evidence.after.service.image_digest = `sha256:${'b'.repeat(64)}`; },
    (f) => { f.evidence.after.client.url = 'https://other.cloudfront.net'; },
    (f) => { f.evidence.after.authenticated.schema.verification.executor.run_attempt = 2; },
  ]) {
    const f = qualificationFixture(); mutate(f); assert.throws(() => qualify(f));
  }
});

test('copied, reversed, future or unknown-field observations cannot issue a record', () => {
  for (const mutate of [
    (f) => { f.evidence.after = structuredClone(f.evidence.before); },
    (f) => { f.evidence.after.collected_at = '2026-10-07T23:00:00Z'; },
    (f) => { f.evidence.after.collected_at = '2026-10-08T00:30:00Z'; },
    (f) => { f.evidence.after.authenticated.schema.future = true; },
    (f) => { f.evidence.after.deployment.selection.components.runtime_policy.extra = true; },
  ]) {
    const f = qualificationFixture(); mutate(f); assert.throws(() => qualify(f));
  }
});

test('deployment, release and run metadata bind exact repositories, source, path, IDs and attempt', () => {
  const f = qualificationFixture();
  assert.doesNotThrow(() => assertDeploymentBinding(f.deployment, f.compatibility));
  const run = { id: 30, run_attempt: 2, repository: { full_name: 'git-malu/AnyWear-Infra' }, path: '.github/workflows/runtime.yml',
    head_sha: f.compatibility.infra.sha, head_branch: 'main', event: 'workflow_dispatch', status: 'completed', conclusion: 'success',
    run_started_at: '2026-10-08T00:00:00Z', updated_at: '2026-10-08T00:10:00Z' };
  const expected = { ...f.compatibility.deployment, sha: f.compatibility.infra.sha };
  assert.doesNotThrow(() => assertTrustedRun(run, expected));
  for (const patch of [{ conclusion: 'failure' }, { status: 'in_progress' }, { run_attempt: 1 }, { head_branch: 'topic' }, { path: '.github/workflows/other.yml' }, { repository: { full_name: 'other/Infra' } }]) {
    assert.throws(() => assertTrustedRun({ ...run, ...patch }, expected));
  }
  const artifact = { id: 40, name: 'infra-deployment-30-2', expired: false, expires_at: '2026-10-09T00:00:00Z',
    created_at: '2026-10-08T00:05:00Z', workflow_run: { id: 30, head_sha: run.head_sha } };
  assert.doesNotThrow(() => assertTrustedArtifact(artifact, f.compatibility, run, now.getTime()));
  for (const patch of [{ expired: true }, { id: 41 }, { name: 'infra-deployment-30-1' }, { expires_at: now.toISOString() }, { created_at: '2026-10-07T00:00:00Z' }]) assert.throws(() => assertTrustedArtifact({ ...artifact, ...patch }, f.compatibility, run, now.getTime()));
  const missing = { schema_version: 1, record_type: 'anywear_service_artifacts', kind: 'source-build',
    producer: { repository: 'git-malu/AnyWear-Service' }, components: { image: { service_sha: f.compatibility.service.sha } } };
  assert.throws(() => assertSealedRelease({}, {}, missing, f.compatibility));
});

test('promotion requires exact unexpired artifact and completed-success E2E attempt, beyond self-checksum', () => {
  const record = qualify(qualificationFixture());
  const recordBytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
  const trustedRun = { id: 123, run_attempt: 1, repository: { full_name: 'git-malu/AnyWear-E2E' }, path: '.github/workflows/beta-qualification.yml',
    head_sha: record.revisions.e2e.sha, head_branch: 'main', event: 'workflow_dispatch', status: 'completed', conclusion: 'success',
    run_started_at: '2026-10-07T23:59:00Z', updated_at: '2026-10-08T00:25:00Z' };
  const trustedArtifact = { id: 90, name: 'beta-qualification-123-1', expired: false, expires_at: '2026-10-09T00:00:00Z',
    created_at: '2026-10-08T00:21:00Z', workflow_run: { id: 123, head_sha: trustedRun.head_sha } };
  const expected = { artifact_id: 90, record_sha256: byteHash(recordBytes), e2e_sha: trustedRun.head_sha, run_id: 123, run_attempt: 1 };
  const context = { trustedRun, trustedArtifact, expected, recordBytes, now: now.getTime() };
  assert.equal(verifyQualificationForPromotion(record, context), true);
  assert.throws(() => verifyQualificationForPromotion(record), /authenticated/);
  assert.throws(() => verifyQualificationForPromotion(record, { ...context, trustedArtifact: { ...trustedArtifact, expired: true } }));
  assert.throws(() => verifyQualificationForPromotion(record, { ...context, trustedRun: { ...trustedRun, conclusion: 'failure' } }));
  assert.throws(() => verifyQualificationForPromotion(record, { ...context, expected: { ...expected, record_sha256: 'a'.repeat(64) } }));
  const tampered = structuredClone(record); tampered.observations.after.authenticated.observed.client_sha = 'b'.repeat(40);
  const { integrity: ignored, ...payload } = tampered; void ignored;
  tampered.integrity.payload_sha256 = payloadDigest(payload);
  assert.throws(() => verifyQualificationRecord(tampered));
});

test('duplicate HTTP metadata is rejected before qualification', async () => {
  const f = qualificationFixture();
  const fetcher = async () => new Response(`{"component":"AnyWear-Client","source_commit":"${f.compatibility.client.sha}","source_commit":"${f.compatibility.client.sha}","built_at":"2026-10-07T00:00:00Z"}`);
  await assert.rejects(collectDeploymentEvidence({ clientUrl: f.evidence.before.client.url, serviceUrl: f.evidence.before.service.url }, f.compatibility, fetcher), /Duplicate JSON key/);
});

test('execution guard binds protected dispatch/source and the captured dedicated principal', () => {
  const sourceSha = 'a'.repeat(40);
  const env = { GITHUB_REPOSITORY: 'git-malu/AnyWear-E2E', GITHUB_REPOSITORY_ID: '1317091305',
    GITHUB_REPOSITORY_OWNER: 'git-malu', GITHUB_REPOSITORY_OWNER_ID: '11473072',
    GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-E2E/.github/workflows/beta-qualification.yml@refs/heads/main',
    GITHUB_WORKFLOW_SHA: sourceSha, GITHUB_SHA: sourceSha, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1',
    E2E_STAGE: 'beta', ENABLE_INFRA_E2E: 'true', AWS_ACCOUNT_ID: '650880818323', AWS_REGION: 'ap-east-1',
    E2E_CLEANUP_SERVICE_SHA: 'b'.repeat(40), E2E_AWS_ACCOUNT: '650880818323',
    E2E_AWS_PRINCIPAL_ARN: 'arn:aws:sts::650880818323:assumed-role/beta-e2e-qualification-role/qualification-123' };
  assert.equal(assertE2EExecution(env, { sourceSha }), true);
  for (const name of ['integration', 'account-recovery']) {
    assert.equal(assertE2EExecution({ ...env, GITHUB_WORKFLOW_REF: `git-malu/AnyWear-E2E/.github/workflows/${name}.yml@refs/heads/main` }, { sourceSha }), true);
  }
  for (const patch of [{ ENABLE_INFRA_E2E: 'false' }, { GITHUB_REPOSITORY: 'other/E2E' }, { GITHUB_REPOSITORY_ID: '1' },
    { GITHUB_REPOSITORY_OWNER: 'other' }, { GITHUB_REPOSITORY_OWNER_ID: '1' }, { GITHUB_REF: 'refs/heads/topic' },
    { GITHUB_EVENT_NAME: 'pull_request' }, { E2E_STAGE: 'dev' }, { GITHUB_WORKFLOW_SHA: 'b'.repeat(40) },
    { GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-E2E/.github/workflows/runtime-drill.yml@refs/heads/main' },
    { GITHUB_RUN_ID: '0' }, { GITHUB_RUN_ID: '9007199254740992' }, { GITHUB_RUN_ATTEMPT: '0' },
    { AWS_ACCOUNT_ID: '1' }, { AWS_REGION: 'us-east-1' }, { E2E_CLEANUP_SERVICE_SHA: 'main' },
    { E2E_AWS_ACCOUNT: undefined }, { E2E_AWS_ACCOUNT: '1' }, { E2E_AWS_PRINCIPAL_ARN: undefined },
    { E2E_AWS_PRINCIPAL_ARN: 'arn:aws:sts::650880818323:assumed-role/beta-infra-role/123' },
    { E2E_AWS_PRINCIPAL_ARN: 'arn:aws:sts::111111111111:assumed-role/beta-e2e-qualification-role/123' }]) {
    assert.throws(() => assertE2EExecution({ ...env, ...patch }, { sourceSha }));
  }
  assert.throws(() => assertE2EExecution(env, { sourceSha: 'c'.repeat(40) }), /checkout/);
  const beforeCredentials = { ...env, E2E_AWS_ACCOUNT: undefined, E2E_AWS_PRINCIPAL_ARN: undefined };
  assert.equal(assertE2EExecution(beforeCredentials, { sourceSha, sourceOnly: true }), true);
  assert.throws(() => assertE2EExecution(beforeCredentials, { sourceSha }), /dedicated E2E principal/);
});

test('recovery binds the original completed owner and preserves unknown identities', () => {
  const run = { id: 123, run_attempt: 1, head_sha: 'a'.repeat(40), repository: { full_name: 'git-malu/AnyWear-E2E' },
    head_branch: 'main', event: 'workflow_dispatch', path: '.github/workflows/beta-qualification.yml', status: 'completed', conclusion: 'failure' };
  const manifest = { version: 1, runScope: '123-1-0000000000000000', config: { maxActiveAccounts: 2, maxNewAccountsPerRun: 4, maxQuarantinedAccounts: 2 },
    accounts: [{ mode: 'worker', status: 'in_use', subject: '00000000-0000-0000-0000-000000000001', email: 'e2e-beta-worker-0-chromium@anywear.local' },
      { mode: 'worker', status: 'quarantined', subject: '00000000-0000-0000-0000-000000000002', email: 'e2e-beta-worker-1-chromium@anywear.local' },
      { mode: 'worker', status: 'deleted', subject: 'already-gone' },
      { mode: 'worker', status: 'provisioning', subject: 'unknown', email: 'e2e-beta-worker-2-chromium@anywear.local' }] };
  const prepared = prepareAccountRecovery(structuredClone(manifest), run, 123, 1);
  assert.equal(prepared.accounts[0].status, 'cleanup_pending');
  assert.equal(prepared.accounts[1].status, 'quarantined');
  assert.equal(prepared.accounts[2].status, 'deleted');
  assert.equal(prepared.accounts[3].status, 'provisioning');
  for (const patch of [{ status: 'in_progress' }, { run_attempt: 2 }, { path: '.github/workflows/runtime-drill.yml' }, { repository: { full_name: 'other/E2E' } }]) assert.throws(() => prepareAccountRecovery(structuredClone(manifest), { ...run, ...patch }, 123, 1));
  assert.throws(() => prepareAccountRecovery({ ...manifest, runScope: '124-1-0000000000000000' }, run, 123, 1));
  assert.throws(() => prepareAccountRecovery({ ...manifest, config: { ...manifest.config, maxNewAccountsPerRun: 1 } }, run, 123, 1));
  assert.throws(() => prepareAccountRecovery({ ...manifest, config: { ...manifest.config, unknown: 1 } }, run, 123, 1));
  const reordered = prepareAccountRecovery({ ...structuredClone(manifest), config: { maxQuarantinedAccounts: 2, maxNewAccountsPerRun: 4, maxActiveAccounts: 2 } }, run, 123, 1);
  assert.equal(JSON.stringify(reordered.config), JSON.stringify(manifest.config));
});

test('recovery artifact binds unique original source/attempt times and lifetime', () => {
  const run = { id: 123, run_attempt: 2, head_sha: 'a'.repeat(40), run_started_at: '2026-10-08T00:00:00Z', updated_at: '2026-10-08T00:20:00Z' };
  const artifact = { id: 55, name: 'beta-account-lifecycle-123-2', expired: false, digest: `sha256:${'a'.repeat(64)}`,
    created_at: '2026-10-08T00:10:00Z', expires_at: '2099-01-01T00:00:00Z', workflow_run: { id: 123, head_sha: run.head_sha } };
  assert.equal(assertRecoveryArtifact(artifact, run), artifact);
  for (const patch of [{ name: 'beta-account-lifecycle-123-1' }, { expired: true }, { workflow_run: { id: 123, head_sha: 'b'.repeat(40) } },
    { created_at: '2026-10-07T23:59:00Z' }, { created_at: '2026-10-08T00:21:00Z' }, { expires_at: '2000-01-01T00:00:00Z' },
    { digest: undefined }, { digest: null }, { digest: '' }, { digest: 'invalid' }]) {
    assert.throws(() => assertRecoveryArtifact({ ...artifact, ...patch }, run));
  }
});

test('surviving Service data endpoint binds its operator source independently of image producer', () => {
  const run = { id: 500, run_attempt: 1, repository: { full_name: 'git-malu/AnyWear-Service' }, path: '.github/workflows/beta-testers.yml',
    head_sha: 'c'.repeat(40), head_branch: 'main', event: 'workflow_dispatch', status: 'completed', conclusion: 'success' };
  assert.equal(assertServiceCleanupRunSource(run, 'c'.repeat(40)), 1);
  assert.throws(() => assertServiceCleanupRunSource(run, 'b'.repeat(40)));
  assert.throws(() => assertServiceCleanupRunSource({ ...run, run_attempt: 2 }, 'c'.repeat(40), 1));
  assert.throws(() => assertServiceCleanupRunSource({ ...run, head_branch: 'other' }, 'c'.repeat(40)));
});

test('deployment v2 requires committed selection path/hash and rejects historical receipt runtime records', () => {
  for (const patch of [{ file: undefined }, { file: '/tmp/reconstructed.json' }, { file: 'selections/../unreviewed.json' },
    { sha256: 'invalid' }, { publication_acceptance: { file: 'publications/old.json', sha256: 'a'.repeat(64) } }]) {
    const f = qualificationFixture();
    Object.assign(f.deployment.selection, patch);
    assert.throws(() => qualify(f));
  }
  const historical = qualificationFixture(); historical.deployment.schema_version = 1;
  assert.throws(() => qualify(historical), /historical v1|Unsupported Infra/);
});
