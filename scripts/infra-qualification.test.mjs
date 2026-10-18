import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertEqual, byteHash, canonicalJson, parseStrictJson, payloadDigest, validateCompatibility,
} from './evidence-contract.mjs';
import { qualificationFixture } from './fixtures/infra-qualification.mjs';
import { assertE2EExecution } from './execution-guard.mjs';
import {
  assertDeploymentBinding, assertSealedRelease, assertTrustedArtifact, assertTrustedRun, validateHistoricalV2Record,
} from './trusted-deployment-inputs.mjs';
import {
  buildQualificationRecord, collectDeploymentEvidence, verifyQualificationForPromotion, verifyQualificationRecord,
} from './qualification-record.mjs';
import { assertRecoveryArtifact, prepareAccountRecovery } from './account-recovery-inputs.mjs';
import { stageContractSchemaHash } from './vendor/deployment-contract.mjs';

const now = new Date('2026-10-08T00:20:00.000Z');
const qualify = (f) => buildQualificationRecord(f.input, f.compatibility, f.evidence, now, f.environment, f.report);

function historicalV2Record() {
  const f = qualificationFixture();
  return {
    schema_version: 2, record_type: 'anywear_infra_deployment',
    infra: { repository: 'git-malu/AnyWear-Infra', sha: f.compatibility.infra.sha, workflow_path: '.github/workflows/runtime.yml',
      workflow_ref: 'git-malu/AnyWear-Infra/.github/workflows/runtime.yml@refs/heads/main', run_id: 30, run_attempt: 2 },
    selection: { file: 'selections/old.json', sha256: 'a'.repeat(64),
      release: { repository: 'git-malu/AnyWear-Service', id: 1, manifest_asset_id: 2, manifest_sha256: 'b'.repeat(64) }, components: {} },
    stacks: Array.from({ length: 4 }, (_, index) => ({ stack_name: ['AnyWearFoundationStack', 'AnyWearPlatformStack-beta', 'AnyWearWorkloadStack-beta', 'AnyWearBillingStack-beta'][index], region: 'ap-east-1', source_repository: 'git-malu/AnyWear-Infra', source_sha: 'c'.repeat(40), template_sha256: 'd'.repeat(64) })),
    observed: { client_sha: f.compatibility.client.sha, service_sha: f.compatibility.service.sha },
    schema: {},
  };
}

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

test('historical v1/v2 pins are readable offline but cannot authorize qualification', () => {
  const f = qualificationFixture();
  const v1 = { version: 1, client: f.compatibility.client, service: f.compatibility.service };
  const v2 = {
    version: 2, client: f.compatibility.client, service: f.compatibility.service, infra: f.compatibility.infra,
    service_artifacts: f.compatibility.service_artifacts,
    deployment: { repository: 'git-malu/AnyWear-Infra', workflow_path: '.github/workflows/runtime.yml',
      run_id: 30, run_attempt: 2, artifact_id: 40, record_sha256: 'a'.repeat(64) },
  };
  assert.doesNotThrow(() => validateCompatibility(v1, { allowLegacy: true }));
  assert.doesNotThrow(() => validateCompatibility(v2, { allowLegacy: true }));
  assert.throws(() => validateCompatibility(v1), /version must be 3/);
  assert.throws(() => validateCompatibility(v2), /version must be 3/);
  assert.throws(() => verifyQualificationRecord({ schema_version: 1, record_type: 'anywear_beta_qualification' }), /Unsupported/);
  for (const mutate of [
    (c) => { c.infra.sha = 'main'; },
    (c) => { c.service_artifacts.release_id = '10'; },
    (c) => { c.deployment.record_sha256 = 'a'.repeat(63); },
    (c) => { c.platform.producer = 'other/Infra'; },
    (c) => { c.workload.producer = 'other/Service'; },
    (c) => { c.platform.record = { ...c.platform.record, status: 'deferred', run_id: 1 }; },
    (c) => { c.deployment = { producer: c.deployment.producer, workflow_path: c.deployment.workflow_path, status: 'recorded' }; },
    (c) => { c.infra.repository = 'other/Infra'; },
    (c) => { c.future = true; },
  ]) {
    const c = structuredClone(f.compatibility); mutate(c); assert.throws(() => validateCompatibility(c));
  }
});

test('the minimum Client pin is optional, strictly shaped, and bound to the workload record floor', () => {
  const f = qualificationFixture();
  assert.doesNotThrow(() => validateCompatibility(f.compatibility));
  const withoutFloor = structuredClone(f.compatibility);
  delete withoutFloor.minimum_supported_client;
  // The committed pre-deployment pin has no member and must stay valid for `pnpm check`.
  assert.doesNotThrow(() => validateCompatibility(withoutFloor));
  for (const mutate of [
    (c) => { c.minimum_supported_client = {}; },
    (c) => { delete c.minimum_supported_client.sha; },
    (c) => { c.minimum_supported_client.version = -1; },
    (c) => { c.minimum_supported_client.version = 1.5; },
    (c) => { c.minimum_supported_client.version = '1'; },
    (c) => { c.minimum_supported_client.version = Number.MAX_SAFE_INTEGER + 1; },
    (c) => { c.minimum_supported_client.sha = 'main'; },
    (c) => { c.minimum_supported_client.sha = 'a'.repeat(39); },
    (c) => { c.minimum_supported_client.extra = true; },
  ]) {
    const c = structuredClone(f.compatibility);
    mutate(c);
    assert.throws(() => validateCompatibility(c));
  }
  // The shipped pin binds the deployed Service record's observed floor, and `full` refuses
  // to issue a record until the pin carries the member.
  assert.doesNotThrow(() => assertDeploymentBinding(f.workloadRecord, f.compatibility));
  const wrongFloor = structuredClone(f.compatibility);
  wrongFloor.minimum_supported_client.version = 1;
  assert.throws(() => assertDeploymentBinding(f.workloadRecord, wrongFloor),
    /observed minimum_client_version 0 differs from compatibility\.minimum_supported_client\.version 1/);
  const missingObservedFloor = structuredClone(f.workloadRecord);
  delete missingObservedFloor.observed.minimum_client_version;
  assert.throws(() => assertDeploymentBinding(missingObservedFloor, f.compatibility),
    /Invalid workload observed tuple fields/);
  const noPinFloor = structuredClone(f.compatibility);
  delete noPinFloor.minimum_supported_client;
  assert.throws(() => buildQualificationRecord(f.input, noPinFloor, f.evidence, now, f.environment, f.report),
    /Qualification requires compatibility\.minimum_supported_client/);
});

test('qualification accepts an independently observed stable v3 tuple', () => {
  const record = qualify(qualificationFixture());
  assert.equal(record.schema_version, 2);
  assert.equal(verifyQualificationRecord(record), true);
  assert.equal(record.observations.after.authenticated.schema.content_sha256,
    stageContractSchemaHash(record.observations.after.platform.record.inputs));
});

test('changed template, Lambda config, Client URL or Service image prevents qualification', () => {
  for (const mutate of [
    (f) => { f.evidence.after.authenticated.stacks[0].template_sha256 = 'a'.repeat(64); },
    (f) => { f.evidence.after.authenticated.observed.lambdas['pre-sign-up'].configuration_sha256 = 'a'.repeat(64); },
    (f) => { f.evidence.after.service.image_digest = `sha256:${'b'.repeat(64)}`; },
    (f) => { f.evidence.after.client.url = 'https://other.cloudfront.net'; },
    (f) => { f.evidence.after.authenticated.observed.client_sha = 'b'.repeat(40); },
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
    (f) => { f.evidence.after.workload.record.observed.ecs.api.extra = true; },
  ]) {
    const f = qualificationFixture(); mutate(f); assert.throws(() => qualify(f));
  }
});

test('deployment, release and run metadata bind exact repositories, source, path, IDs and attempt', () => {
  const f = qualificationFixture();
  assert.doesNotThrow(() => assertDeploymentBinding(f.platformRecord, f.compatibility));
  assert.doesNotThrow(() => assertDeploymentBinding(f.workloadRecord, f.compatibility));
  const platformRun = { id: 30, run_attempt: 2, repository: { full_name: 'git-malu/AnyWear-Infra' }, path: '.github/workflows/runtime.yml',
    head_sha: f.compatibility.platform.producer_sha, head_branch: 'main', event: 'workflow_dispatch', status: 'completed', conclusion: 'success',
    run_started_at: '2026-10-08T00:00:00Z', updated_at: '2026-10-08T00:10:00Z' };
  const expected = { repository: 'git-malu/AnyWear-Infra', workflow_path: '.github/workflows/runtime.yml',
    run_id: 30, run_attempt: 2, sha: f.compatibility.platform.producer_sha };
  assert.doesNotThrow(() => assertTrustedRun(platformRun, expected));
  for (const patch of [{ conclusion: 'failure' }, { status: 'in_progress' }, { run_attempt: 1 }, { head_branch: 'topic' }, { path: '.github/workflows/other.yml' }, { repository: { full_name: 'other/Infra' } }]) {
    assert.throws(() => assertTrustedRun({ ...platformRun, ...patch }, expected));
  }
  const artifact = { id: 40, name: 'infra-deployment-30-2', expired: false, expires_at: '2026-10-09T00:00:00Z',
    created_at: '2026-10-08T00:05:00Z', workflow_run: { id: 30, head_sha: platformRun.head_sha } };
  const artifactExpected = { ...expected, artifact_id: 40, artifact_name: 'infra-deployment-30-2' };
  assert.doesNotThrow(() => assertTrustedArtifact(artifact, artifactExpected, platformRun, now.getTime()));
  for (const patch of [{ expired: true }, { id: 41 }, { name: 'infra-deployment-30-1' }, { expires_at: now.toISOString() }, { created_at: '2026-10-07T00:00:00Z' }]) {
    assert.throws(() => assertTrustedArtifact({ ...artifact, ...patch }, artifactExpected, platformRun, now.getTime()));
  }
  const missing = { schema_version: 1, record_type: 'anywear_service_artifacts', kind: 'source-build',
    producer: { repository: 'git-malu/AnyWear-Service' }, components: { image: { service_sha: f.compatibility.service.sha, digest: f.workloadRecord.observed.image_digest } } };
  assert.throws(() => assertSealedRelease({}, {}, missing, f.compatibility));
});

test('the two producer records cannot be swapped or claim another producer stack', () => {
  const f = qualificationFixture();
  const platformAsWorkload = structuredClone(f.platformRecord);
  platformAsWorkload.producer.repository = 'git-malu/AnyWear-Service';
  assert.throws(() => assertDeploymentBinding(platformAsWorkload, f.compatibility));
  const workloadAsPlatform = structuredClone(f.workloadRecord);
  workloadAsPlatform.producer.repository = 'git-malu/AnyWear-Infra';
  assert.throws(() => assertDeploymentBinding(workloadAsPlatform, f.compatibility));
  const extraStack = structuredClone(f.workloadRecord);
  extraStack.stacks.push({ ...extraStack.stacks[0], name: 'AnyWearPlatformStack-beta' });
  assert.throws(() => assertDeploymentBinding(extraStack, f.compatibility));
  const wrongRun = structuredClone(f.platformRecord);
  wrongRun.producer.run_attempt = 1;
  assert.throws(() => assertDeploymentBinding(wrongRun, f.compatibility), /producer attempt/);
  const deferred = qualificationFixture({ deferred: true }).compatibility;
  assert.throws(() => assertDeploymentBinding(f.platformRecord, deferred), /Deployment evidence deferred/);
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
    E2E_STAGE: 'beta', ENABLE_BETA_MUTATION: 'true', E2E_OPERATION: 'full', AWS_ACCOUNT_ID: '650880818323', AWS_REGION: 'ap-east-1',
    E2E_CLEANUP_SERVICE_SHA: 'b'.repeat(40), E2E_AWS_ACCOUNT: '650880818323',
    E2E_AWS_PRINCIPAL_ARN: 'arn:aws:sts::650880818323:assumed-role/beta-e2e-qualification-role/qualification-123' };
  assert.equal(assertE2EExecution(env, { sourceSha }), true);
  for (const operation of ['full', 'smoke', 'measure', 'recover']) {
    assert.equal(assertE2EExecution({ ...env, E2E_OPERATION: operation }, { sourceSha }), true);
  }
  for (const patch of [{ ENABLE_BETA_MUTATION: 'false' }, { GITHUB_REPOSITORY: 'other/E2E' }, { GITHUB_REPOSITORY_ID: '1' },
    { GITHUB_REPOSITORY_OWNER: 'other' }, { GITHUB_REPOSITORY_OWNER_ID: '1' }, { GITHUB_REF: 'refs/heads/topic' },
    { GITHUB_EVENT_NAME: 'pull_request' }, { E2E_STAGE: 'dev' }, { GITHUB_WORKFLOW_SHA: 'b'.repeat(40) },
    { GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-E2E/.github/workflows/integration.yml@refs/heads/main' },
    { GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-E2E/.github/workflows/account-recovery.yml@refs/heads/main' },
    { GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-E2E/.github/workflows/runtime-drill.yml@refs/heads/main' },
    { E2E_OPERATION: undefined }, { E2E_OPERATION: '' }, { E2E_OPERATION: 'instrumentation' },
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

// AnyWear #138: identity is content, never an ECS task-definition revision. The
// v3 record pins exact bytes and template/input content hashes; the revision is
// audit information inside the Service record.
test('#138 a new ECS task-definition revision with unchanged content still binds', () => {
  const f = qualificationFixture();
  const bumped = structuredClone(f.workloadRecord);
  for (const purpose of ['api', 'worker']) {
    bumped.observed.ecs[purpose].task_definition_arn = bumped.observed.ecs[purpose].task_definition_arn.replace(/:\d+$/, ':99');
  }
  assert.doesNotThrow(() => assertDeploymentBinding(bumped, f.compatibility));
});

test('#138 changed deployment content is refused and the error names the differing field', () => {
  const f = qualificationFixture();
  // The shared comparison names the first differing path with both values.
  assert.throws(() => assertEqual({ record: { template_sha256: 'a'.repeat(64) } }, { record: { template_sha256: 'b'.repeat(64) } }, 'Record'),
    /Record mismatch at <root>\.record\.template_sha256: expected "b{64}", observed "a{64}"/);
  // A changed ECS image is refused by the producer-owned content validator and the
  // error names the ECS field that differs.
  const changed = structuredClone(f.workloadRecord);
  changed.observed.ecs.api.image_digest = `sha256:${'f'.repeat(64)}`;
  assert.throws(() => assertDeploymentBinding(changed, f.compatibility), /ECS api image_digest differs from the deployed image/);
  // The live HTTP identity is bound to the pinned Service record; a changed image
  // digest in the evidence is refused by name.
  const evidence = structuredClone(f.evidence.after);
  evidence.service.image_digest = `sha256:${'f'.repeat(64)}`;
  assert.throws(() => qualify({ ...f, evidence: { before: f.evidence.before, after: evidence } }),
    /HTTP and authenticated deployment identities disagree/);
});

test('#138 the unchanged tuple still passes', () => {
  const f = qualificationFixture();
  assert.doesNotThrow(() => assertDeploymentBinding(f.platformRecord, f.compatibility));
  assert.doesNotThrow(() => assertDeploymentBinding(f.workloadRecord, f.compatibility));
  assert.equal(verifyQualificationRecord(qualify(f)), true);
});

test('#138 the historical v2 record remains readable for the audit path only', () => {
  const v2 = historicalV2Record();
  assert.doesNotThrow(() => validateHistoricalV2Record(v2));
  assert.throws(() => validateHistoricalV2Record(qualificationFixture().platformRecord), /not a live v3 input/);
});

test('the stage-contract schema hash is content identity derived from the inputs', () => {
  const f = qualificationFixture();
  const inputs = structuredClone(f.platformRecord.inputs);
  assert.equal(stageContractSchemaHash(inputs), f.platformRecord.schema.content_sha256);
  // A value hash is not part of the schema surface; a parameter name/version is.
  const valueChanged = structuredClone(inputs);
  valueChanged[0].value_sha256 = 'a'.repeat(64);
  assert.equal(stageContractSchemaHash(valueChanged), stageContractSchemaHash(inputs));
  const versionChanged = structuredClone(inputs);
  versionChanged[0].version = String(Number(versionChanged[0].version) + 1);
  assert.notEqual(stageContractSchemaHash(versionChanged), stageContractSchemaHash(inputs));
});

test('a deferred record identity is refused by name on every live path', () => {
  const f = qualificationFixture({ deferred: true });
  assert.throws(() => assertDeploymentBinding(f.platformRecord, f.compatibility), /Deployment evidence deferred for git-malu\/AnyWear-Infra/);
  assert.throws(() => assertDeploymentBinding(f.workloadRecord, f.compatibility), /Deployment evidence deferred for git-malu\/AnyWear-Service/);
  assert.throws(() => buildQualificationRecord(f.input, f.compatibility, f.evidence, now, f.environment, f.report), /Deployment evidence deferred/);
});
