import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { byteHash, canonicalJson, owner, parseStrictJson, repositories, repositoryIds, requireOwnedRepository } from './evidence-contract.mjs';
import { validateDeploymentRecord } from './vendor/deployment-contract.mjs';
import {
  DIAGNOSTIC_EXPECTED,
  assertDiagnosticRun,
  loadDiagnosticEvidence,
  resolveDiagnosticServiceRelease,
  validateDiagnosticRecord,
} from './beta-cleanup-diagnostic.mjs';

const sha = letter => letter.repeat(40);
const hash = letter => letter.repeat(64);
const image = DIAGNOSTIC_EXPECTED.service.image_digest;

function diagnosticRun() {
  const repository = { id: repositoryIds[repositories.infra], full_name: repositories.infra, fork: false, owner: { ...owner } };
  return { id: DIAGNOSTIC_EXPECTED.infra.run_id, run_attempt: DIAGNOSTIC_EXPECTED.infra.run_attempt,
    head_sha: DIAGNOSTIC_EXPECTED.infra.sha, head_branch: 'main', path: DIAGNOSTIC_EXPECTED.infra.workflow_path,
    event: 'workflow_dispatch', status: 'completed', conclusion: 'success',
    repository, head_repository: structuredClone(repository) };
}

test('run owner identity comes from the repository owner field and never from an environment value', () => {
  const run = diagnosticRun();
  assert.strictEqual(assertDiagnosticRun(run, expectedFixture()), run);
  // An unset owner field is refused rather than defaulted or inferred.
  for (const change of [r => { delete r.repository.owner; }, r => { r.repository.owner = undefined; },
    r => { r.repository.owner.login = 'other'; }, r => { r.repository.owner.id = 1; },
    r => { r.repository.full_name = 'other/AnyWear-Infra'; }, r => { r.repository.id = 1; },
    r => { r.head_repository = { ...r.repository, owner: { ...r.repository.owner, login: 'other' } }; },
    r => { r.head_repository = { ...r.repository, owner: { ...r.repository.owner, id: 1 } }; }]) {
    const candidate = diagnosticRun(); change(candidate);
    assert.throws(() => assertDiagnosticRun(candidate, expectedFixture()));
  }
});

test('owned repository identity is declared once for every AnyWear repository', () => {
  for (const [repository, id] of Object.entries(repositoryIds)) {
    const value = { id, full_name: repository, fork: false, owner: { ...owner } };
    assert.strictEqual(requireOwnedRepository(value, repository, 'Owned repository'), value);
    assert.throws(() => requireOwnedRepository({ id, full_name: repository }, repository, 'Owned repository'), /owner is required/);
    assert.throws(() => requireOwnedRepository({ ...value, fork: true }, repository, 'Owned repository'), /not the protected/);
  }
  assert.throws(() => requireOwnedRepository({ id: 1, full_name: 'other/AnyWear-Infra', fork: false, owner: { ...owner } }, 'other/AnyWear-Infra', 'Foreign repository'), /not a known AnyWear repository/);
});

test('owner identity tolerates the unrelated fields the GitHub API returns', () => {
  const value = { id: repositoryIds[repositories.infra], full_name: repositories.infra, node_id: 'R_1', fork: false,
    owner: { id: owner.id, login: owner.login, type: 'User', node_id: 'U_1', avatar_url: 'https://example.invalid/a' } };
  assert.strictEqual(requireOwnedRepository(value, repositories.infra, 'Owned repository'), value);
});

function expectedFixture() {
  const expected = structuredClone(DIAGNOSTIC_EXPECTED);
  expected.artifacts.deployment.zip_sha256 = byteHash(Buffer.from('deployment zip fixture'));
  expected.artifacts.deployment.record_sha256 = hash('d');
  expected.artifacts.operation.zip_sha256 = byteHash(Buffer.from('operation zip fixture'));
  expected.artifacts.operation.record_sha256 = hash('e');
  expected.selection.blob_sha256 = sha('f');
  expected.selection.raw_sha256 = hash('a');
  expected.selection.stack_map_sha256 = hash('b');
  expected.selection.release.manifest_sha256 = hash('c');
  return expected;
}

function selectionFixture(expected) {
  const components = {
    image: { repository_uri: '650880818323.dkr.ecr.ap-east-1.amazonaws.com/beta-anywear-service', digest: image, service_sha: expected.service.source_sha },
    lambdas: {
      pre_sign_up: { asset_id: 10, service_sha: expected.service.source_sha, file: 'pre-sign-up.zip', sha256: hash('1'), code_sha256: Buffer.from(hash('1'), 'hex').toString('base64'), handler: 'index.handler', runtime: 'nodejs24.x', source_lock_sha256: hash('2'), bundler_version: 'esbuild@0.28.0', build_options: { bundle: true, external: [], format: 'cjs', minify: true, packages: 'bundle', platform: 'node', sourcemap: 'external', target: 'node24' } },
      post_confirmation: { asset_id: 11, service_sha: expected.service.source_sha, file: 'post-confirmation.zip', sha256: hash('3'), code_sha256: Buffer.from(hash('3'), 'hex').toString('base64'), handler: 'index.handler', runtime: 'nodejs24.x', source_lock_sha256: hash('2'), bundler_version: 'esbuild@0.28.0', build_options: { bundle: true, external: [], format: 'cjs', minify: true, packages: 'bundle', platform: 'node', sourcemap: 'external', target: 'node24' } },
    },
    runtime_policy: { asset_id: 12, service_sha: expected.service.source_sha, file: 'runtime-policy.json', sha256: hash('4'), content_sha256: hash('5') },
    schema: { asset_id: 13, service_sha: expected.service.source_sha, file: 'service-schema.json', sha256: hash('6'), journal_sha256: hash('7'), current_version: expected.service.schema_version, minimum_version: expected.service.schema_version },
  };
  return { schema_version: 2, record_type: 'anywear_infra_selection', release: expected.selection.release, ...components };
}

function observationFixture(expected, selector) {
  const stacks = ['AnyWearFoundationStack', 'AnyWearPlatformStack-beta', 'AnyWearWorkloadStack-beta', 'AnyWearBillingStack-beta'].map(stack_name => ({
    region: stack_name === 'AnyWearBillingStack-beta' ? 'us-east-1' : expected.region,
    source_repository: stack_name === 'AnyWearBillingStack-beta' ? 'git-malu/AnyWear-Service' : 'git-malu/AnyWear-Infra',
    source_sha: stack_name === 'AnyWearFoundationStack' ? sha('1') : stack_name === 'AnyWearBillingStack-beta' ? sha('2') : expected.infra.sha,
    stack_name, template_sha256: hash('8'),
  }));
  const task = (role, definition) => ({ image_digest: image, service_arn: `arn:aws:ecs:ap-east-1:650880818323:service/beta-anywear/beta-anywear-${role}`, task_definition_arn: definition });
  const taskArn = 'arn:aws:ecs:ap-east-1:650880818323:task/beta-anywear/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  return {
    schema_version: 2, record_type: 'anywear_infra_family_observation',
    infra: expected.infra,
    selection: { file: expected.selection.file, sha256: expected.selection.raw_sha256, release: selector.release, components: { image: selector.image, lambdas: selector.lambdas, runtime_policy: selector.runtime_policy, schema: selector.schema } },
    stacks,
    observed: { client_sha: expected.runtime.client_sha, ecs: { api: task('api', expected.runtime.api_task_definition), worker: task('worker', expected.runtime.worker_task_definition) }, endpoints: { api: expected.runtime.api_endpoint, client: expected.runtime.client_endpoint }, image_digest: image,
      lambdas: { 'post-confirmation': { code_sha256: selector.lambdas.post_confirmation.code_sha256, configuration_sha256: hash('9') }, 'pre-sign-up': { code_sha256: selector.lambdas.pre_sign_up.code_sha256, configuration_sha256: hash('0') } }, policy_content_sha256: selector.runtime_policy.content_sha256, queue_config_sha256: hash('1'), service_sha: expected.service.source_sha },
    schema: { applied_migration_ids: [{ created_at: 1, id: hash('1') }], applied_schema_version: expected.service.schema_version, compatibility_result: 'compatible', minimum_migration_count: 1, minimum_schema_version: expected.service.schema_version, observed_applied_journal_sha256: hash('2'), selected_current_version: expected.service.schema_version, selected_journal_sha256: selector.schema.journal_sha256, selected_migration_ids: [{ created_at: 1, id: hash('1') }], verification: {
      command_sha256: hash('3'), executor: { repository: expected.infra.repository, run_attempt: expected.infra.run_attempt, run_id: expected.infra.run_id, sha: expected.infra.sha, workflow_path: expected.infra.workflow_path }, image_digest: image, service_sha: expected.service.source_sha, source_repository: expected.infra.repository, source_sha: expected.infra.sha, task_arn: `${taskArn}`, task_definition_arn: 'arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-artifact-verify:155',
    } },
  };
}

function operationFixture(expected, observation) {
  const selection = observation.selection;
  const taskArn = observation.schema.verification.task_arn;
  return {
    schema_version: 3, record_type: 'anywear_infra_operation', family: 'beta-deploy', operation: 'deploy-workload', result: 'succeeded', recovery: 'not-required', final_observation: 'success',
    context: { account: expected.account_id, identity_phase: 'retired', region: expected.region, retention_protection: true },
    executor: { repository: expected.infra.repository, run_attempt: expected.infra.run_attempt, run_id: expected.infra.run_id, sha: expected.infra.sha, workflow_path: expected.infra.workflow_path },
    lifecycle_implementation_origin: { path: '.github/scripts/beta-lifecycle.mjs', repository: 'git-malu/AnyWear-Service', sha: sha('1') },
    original_runtime: { image_digest: `sha256:${'1'.repeat(64)}`, service_sha: sha('2') },
    original_stack_templates: observation.stacks.map(({ region, stack_name, template_sha256 }) => ({ region, stack_name, template_sha256 })),
    stack_manifest: observation.stacks.map(({ region, source_repository, source_sha, stack_name }) => ({ region, source_repository, source_sha, stack_name })),
    changed_stack_names: ['AnyWearWorkloadStack-beta'],
    selection,
    events: [
      { platform_active: true, type: 'observed-beta-activity', workload_active: true },
      { task_definition_arn: 'arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-artifact-verify:154', type: 'runtime-task-definition' },
      { result: 'observed', task_arns: [expected.runtime.prior_verify_task], type: 'runtime-task-started' },
      { cleanup_task_count: 0, execution_count: 8, inventory_sha256: hash('4'), machine_arn: 'arn:aws:states:ap-east-1:650880818323:stateMachine:beta-anywear-tester-cleanup', manager_result_reconciliation_required: true, terminal_failed_execution_arns: ['one', 'two', 'three', 'four', 'five'], type: 'cleanup-capability-cessation' },
      { beta_api_sizing_profile: 's1', beta_sizing_telemetry: 'false', image_digest: image, service_sha: expected.service.source_sha, stack_name: 'AnyWearWorkloadStack-beta', stack_status: 'UPDATE_COMPLETE', type: 'workload-parameter-readback' },
      { action: expected.runtime.api_endpoint, command_sha256: hash('5'), image_digest: image, result: 'stopped-success', role: 'verify', service_sha: expected.service.source_sha, task_arn: expected.runtime.verify_task, task_definition_arn: expected.runtime.verify_task_definition, type: 'one-shot' },
      { platform_active: 'true', platform_status: 'UPDATE_COMPLETE', type: 'final-beta-activity', workload_active: 'true', workload_status: 'UPDATE_COMPLETE' },
      { task_definition_arn: 'arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-artifact-verify:155', type: 'runtime-task-definition' },
      { result: 'observed', task_arns: [taskArn], type: 'runtime-task-started' },
      { beta_api_sizing_profile: 's1', beta_sizing_telemetry: 'false', ecs: { api: { beta_sizing_telemetry: 'false', cpu: '512', memory: '1024', task_definition_arn: expected.runtime.api_task_definition }, worker: { beta_sizing_telemetry: 'false', cpu: '1024', memory: '2048', task_definition_arn: expected.runtime.worker_task_definition } }, type: 'beta-sizing-state' },
    ],
  };
}

function diagnosticFixture(expected = expectedFixture()) {
  const selector = selectionFixture(expected);
  const observation = observationFixture(expected, selector);
  const operation = operationFixture(expected, observation);
  const health = { client: { schema_version: 1, component: 'AnyWear-Client', source_commit: expected.runtime.client_sha, built_at: '2026-10-12T22:00:00.000Z' }, service: { status: 'ok', service_commit: expected.service.source_sha, image_digest: image, minimum_schema_version: expected.service.schema_version, minimum_client_version: 0 } };
  const record = { schema_version: 1, record_type: 'anywear_beta_cleanup_diagnostic', producer: { account_id: expected.account_id, region: expected.region, ...expected.infra, operation: 'deploy-workload' }, artifacts: expected.artifacts,
    selection: { file: expected.selection.file, blob_sha256: expected.selection.blob_sha256, raw_sha256: expected.selection.raw_sha256, stack_map_file: expected.selection.stack_map_file, stack_map_sha256: expected.selection.stack_map_sha256 },
    service: { source_sha: expected.service.source_sha, release: expected.selection.release.id, manifest_sha256: expected.selection.release.manifest_sha256, image_digest: expected.service.image_digest },
    runtime: { account_id: expected.account_id, region: expected.region, client_sha: expected.runtime.client_sha, api_endpoint: expected.runtime.api_endpoint, client_endpoint: expected.runtime.client_endpoint, api_task_definition: expected.runtime.api_task_definition, worker_task_definition: expected.runtime.worker_task_definition, rollout_state: expected.runtime.rollout_state, schema_version: expected.runtime.schema_version, health },
    capability: { account_id: expected.account_id, region: expected.region, ...expected.capability, service_sha: expected.service.source_sha, image_digest: expected.service.image_digest }, observation, operation };
  return { expected, selector, observation, operation, record, health };
}

test('validates the diagnostic envelope and keeps formal deployment contracts closed', () => {
  const fixture = diagnosticFixture();
  assert.strictEqual(validateDiagnosticRecord(fixture.record, fixture.expected), fixture.record);
  // The historical cleanup diagnostic is never a formal deployment record. #180 retired
  // the compatibility-pin binding this test used to assert, so the closed-contract check
  // is now the live contract itself: the diagnostic body is refused as one of its records.
  assert.throws(() => validateDeploymentRecord(fixture.record), /Unknown deployment schema|Invalid deployment record fields|Unsupported/);
});

// AnyWear-Client#21 released build-metadata schema 2: the four schema-1 identity fields are
// unchanged and one `interface` object is added. #160 released schema 3: the same shape with
// the built `client_version` added. The diagnostic must accept all three released shapes
// strictly, keep the source revision binding exact, and refuse a partial or unknown shape
// rather than ignoring it.
test('accepts Client build-metadata schema 1, 2 and 3 and refuses every other shape', () => {
  const fixture = diagnosticFixture();
  const identity = {
    schema_version: 1,
    component: 'AnyWear-Client',
    source_commit: fixture.expected.runtime.client_sha,
    built_at: '2026-10-12T22:00:00.000Z',
  };
  const interfaceFixture = { api_base_url: 'https://api.example.invalid', cognito_user_pool_id: 'pool-id', cognito_client_id: 'client-id' };
  const schema2 = {
    ...identity,
    schema_version: 2,
    interface: interfaceFixture,
  };
  const schema3 = {
    ...schema2,
    schema_version: 3,
    client_version: 1,
  };
  const schema3WithoutInterface = { ...schema3 };
  delete schema3WithoutInterface.interface;
  const withClient = (client) => {
    const candidate = structuredClone(fixture);
    candidate.record.runtime.health.client = client;
    return candidate;
  };
  for (const [label, client] of [['schema 1', identity], ['schema 2', schema2], ['schema 3', schema3]]) {
    const candidate = withClient(client);
    assert.strictEqual(validateDiagnosticRecord(candidate.record, fixture.expected), candidate.record, label);
  }
  for (const [label, client, expected] of [
    ['schema 2 missing interface', { ...identity, schema_version: 2 }, /Diagnostic Client health\.interface is required/],
    ['schema 2 extra top-level key', { ...schema2, extra: true }, /Diagnostic Client health\.extra is unknown/],
    ['schema 3 missing interface', schema3WithoutInterface, /Diagnostic Client health\.interface is required/],
    ['schema 3 missing client_version', { schema_version: 3, component: schema3.component, source_commit: schema3.source_commit, built_at: schema3.built_at, interface: interfaceFixture }, /Diagnostic Client health\.client_version is required/],
    ['schema 3 string client_version', { ...schema3, client_version: '1' }, /Diagnostic Client client_version must be a non-negative safe integer/],
    ['schema 3 negative client_version', { ...schema3, client_version: -1 }, /Diagnostic Client client_version must be a non-negative safe integer/],
    ['schema 3 fractional client_version', { ...schema3, client_version: 1.5 }, /Diagnostic Client client_version must be a non-negative safe integer/],
    ['schema 3 extra top-level key', { ...schema3, extra: true }, /Diagnostic Client health\.extra is unknown/],
    ['unknown schema version', { ...schema3, schema_version: 4 }, /schema version is unsupported/],
    ['schema 2 missing interface member', { ...schema2, interface: { api_base_url: schema2.interface.api_base_url, cognito_user_pool_id: schema2.interface.cognito_user_pool_id } }, /Diagnostic Client interface\.cognito_client_id is required/],
    ['schema 2 unknown interface member', { ...schema2, interface: { ...schema2.interface, extra: 'x' } }, /Diagnostic Client interface\.extra is unknown/],
    ['schema 2 empty interface member', { ...schema2, interface: { ...schema2.interface, cognito_client_id: '' } }, /Diagnostic Client interface\.cognito_client_id must be a non-empty string/],
    ['schema 2 non-string interface member', { ...schema2, interface: { ...schema2.interface, api_base_url: 7 } }, /Diagnostic Client interface\.api_base_url must be a non-empty string/],
    ['schema 2 foreign client source', { ...schema2, source_commit: sha('f') }, /Diagnostic Client health identity mismatch/],
    ['schema 1 carrying the schema 2 interface', { ...identity, interface: schema2.interface }, /Diagnostic Client health\.interface is unknown/],
    ['schema 2 carrying the schema 3 client_version', { ...schema2, client_version: 1 }, /Diagnostic Client health\.client_version is unknown/],
  ]) {
    const candidate = withClient(client);
    assert.throws(() => validateDiagnosticRecord(candidate.record, fixture.expected), expected, label);
  }
});

// #160: the deployed Service /health now states the minimum Client version floor beside the
// historical identity and schema fields. The diagnostic accepts the new shape and the
// historical shape without the member, and still validates that any recorded floor is a
// non-negative safe integer rather than ignoring an arbitrary value.
test('accepts the new Service health floor and validates it when present', () => {
  const fixture = diagnosticFixture();
  const serviceHealth = fixture.record.runtime.health.service;
  assert.equal(serviceHealth.minimum_client_version, 0);
  assert.strictEqual(validateDiagnosticRecord(fixture.record, fixture.expected), fixture.record);
  const withoutFloor = structuredClone(fixture);
  delete withoutFloor.record.runtime.health.service.minimum_client_version;
  assert.strictEqual(validateDiagnosticRecord(withoutFloor.record, fixture.expected), withoutFloor.record);
  for (const [label, value, expected] of [
    ['negative', -1, /minimum_client_version must be a non-negative safe integer/],
    ['fractional', 0.5, /minimum_client_version must be a non-negative safe integer/],
    ['string', '0', /minimum_client_version must be a non-negative safe integer/],
    ['unsafe', Number.MAX_SAFE_INTEGER + 1, /minimum_client_version must be a non-negative safe integer/],
  ]) {
    const candidate = structuredClone(fixture);
    candidate.record.runtime.health.service.minimum_client_version = value;
    assert.throws(() => validateDiagnosticRecord(candidate.record, fixture.expected), expected, label);
  }
});

test('rejects unknown, duplicate and every producer/runtime binding drift', () => {
  const base = diagnosticFixture();
  const mutations = [
    record => { record.extra = true; }, record => { record.producer.workflow_path = '.github/workflows/runtime.yml'; }, record => { record.producer.run_attempt = 2; },
    record => { record.artifacts.deployment.zip_sha256 = hash('f'); }, record => { record.selection.stack_map_sha256 = hash('f'); }, record => { record.service.image_digest = `sha256:${'f'.repeat(64)}`; },
    record => { record.runtime.health.service.status = 'not_ready'; }, record => { record.runtime.api_task_definition = base.expected.runtime.worker_task_definition; }, record => { record.capability.log_group = '/foreign'; },
    record => { record.operation.events.find(event => event.type === 'one-shot').result = 'failed'; }, record => { record.operation.events.find(event => event.type === 'runtime-task-started').task_arns = []; },
    record => { record.operation.events.find(event => event.type === 'one-shot').task_arn = 'arn:aws:ecs:ap-east-1:650880818323:task/beta-anywear/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'; },
  ];
  for (const [index, mutate] of mutations.entries()) { const candidate = structuredClone(base.record); mutate(candidate); assert.throws(() => validateDiagnosticRecord(candidate, base.expected), `mutation ${index} must fail`); }
  const duplicate = JSON.stringify(base.record).replace('{"schema_version":1,', '{"schema_version":1,"schema_version":1,');
  assert.throws(() => parseStrictJson(Buffer.from(duplicate)), /Duplicate JSON key/);
});

// #163: Infra replaces `beta-deploy.yml` with `mutate.yml` but deliberately keeps the
// operation record's family name `beta-deploy`. The diagnostic accepts both producer paths,
// keeps the historical evidence readable, and refuses a record that mixes them or names a
// path outside the transition allow-list.
test('#163 accepts the historical beta-deploy path and the new mutate path, but no mix', () => {
  const historical = diagnosticFixture();
  assert.strictEqual(validateDiagnosticRecord(historical.record, historical.expected), historical.record);

  const expected = expectedFixture();
  expected.infra.workflow_path = '.github/workflows/mutate.yml';
  expected.infra.workflow_ref = `git-malu/AnyWear-Infra/.github/workflows/mutate.yml@refs/heads/main`;
  const replacement = diagnosticFixture(expected);
  assert.equal(replacement.operation.family, 'beta-deploy');
  assert.strictEqual(validateDiagnosticRecord(replacement.record, replacement.expected), replacement.record);
  assert.strictEqual(assertDiagnosticRun({ ...diagnosticRun(), path: expected.infra.workflow_path }, replacement.expected).path,
    '.github/workflows/mutate.yml');

  const mixed = structuredClone(replacement.record);
  mixed.observation.schema.verification.executor.workflow_path = '.github/workflows/beta-deploy.yml';
  assert.throws(() => validateDiagnosticRecord(mixed, replacement.expected), /does not match the diagnostic producer/);

  const foreign = expectedFixture();
  foreign.infra.workflow_path = '.github/workflows/runtime.yml';
  assert.throws(() => validateDiagnosticRecord(diagnosticFixture(foreign).record, foreign), /transition allow-list/);
});

// #193: the diagnostic resolves the recorded Service release identity from the release
// itself. The release must be published and immutable, its tag must name the recorded
// Service source, and that tag must resolve to the same commit (following an annotated
// tag). No manifest and no release asset is read.
const diagnosticTag = `service-artifacts-${DIAGNOSTIC_EXPECTED.service.source_sha}`;
const diagnosticReleasePath = `repos/git-malu/AnyWear-Service/releases/${DIAGNOSTIC_EXPECTED.selection.release.id}`;
const diagnosticRefPath = `repos/git-malu/AnyWear-Service/git/ref/tags/${diagnosticTag}`;
const diagnosticRelease = {
  id: DIAGNOSTIC_EXPECTED.selection.release.id, tag_name: diagnosticTag, draft: false, immutable: true, assets: [],
};
const diagnosticRef = { object: { type: 'commit', sha: DIAGNOSTIC_EXPECTED.service.source_sha } };

function releaseApi({
  releaseRecord = diagnosticRelease, refRecord = diagnosticRef, tagObjects = {}, fail = () => false, seen = [],
} = {}) {
  return async (path, binary) => {
    seen.push({ path, binary });
    if (fail(path)) throw new Error('gh: Not Found (HTTP 404)');
    if (path === diagnosticReleasePath) return JSON.stringify(releaseRecord);
    if (path === diagnosticRefPath) return JSON.stringify(refRecord);
    const annotated = /^repos\/git-malu\/AnyWear-Service\/git\/tags\/([0-9a-f]{40})$/.exec(path);
    if (annotated && Object.hasOwn(tagObjects, annotated[1])) return JSON.stringify(tagObjects[annotated[1]]);
    if (path.includes('/releases/assets/')) throw new Error(`release asset must not be read (${path})`);
    throw new Error(`Unexpected API path: ${path}`);
  };
}

const resolveRelease = (overrides = {}) => resolveDiagnosticServiceRelease({
  expected: expectedFixture(),
  api: releaseApi(overrides),
  environment: { SERVICE_ARTIFACT_READ_TOKEN: 'read-only', GH_TOKEN: 'infra-read' },
});

test('#193 resolves the recorded Service release by tag→commit and immutability, reading no asset', async () => {
  const seen = [];
  const expected = expectedFixture();
  const resolved = await resolveDiagnosticServiceRelease({
    expected, api: releaseApi({ seen }), environment: { SERVICE_ARTIFACT_READ_TOKEN: 'read-only', GH_TOKEN: 'infra-read' },
  });
  assert.equal(resolved.release.id, expected.selection.release.id);
  assert.equal(resolved.targetCommit, expected.service.source_sha);
  assert.deepEqual(seen.map(({ path }) => path), [diagnosticReleasePath, diagnosticRefPath]);
  assert.ok(seen.every(({ binary }) => binary === false));
  await assert.rejects(resolveDiagnosticServiceRelease({ expected, api: releaseApi(), environment: {} }),
    /SERVICE_ARTIFACT_READ_TOKEN required for git-malu\/AnyWear-Service read access/);

  // An annotated tag is followed to its commit with one extra read.
  const annotatedSha = 'a'.repeat(40);
  const annotatedSeen = [];
  const annotated = await resolveDiagnosticServiceRelease({
    expected,
    api: releaseApi({
      seen: annotatedSeen,
      refRecord: { object: { type: 'tag', sha: annotatedSha } },
      tagObjects: { [annotatedSha]: { object: { type: 'commit', sha: expected.service.source_sha } } },
    }),
    environment: { SERVICE_ARTIFACT_READ_TOKEN: 'read-only' },
  });
  assert.equal(annotated.targetCommit, expected.service.source_sha);
  assert.equal(annotatedSeen.length, 3);
});

test('#193 refuses a draft, mutable, mis-tagged or wrong-source Service release', async () => {
  await assert.rejects(resolveRelease({ fail: (path) => path === diagnosticReleasePath }), /Not Found/);
  await assert.rejects(resolveRelease({ releaseRecord: { ...diagnosticRelease, id: 1 } }),
    /Diagnostic Service release identity mismatch/);
  await assert.rejects(resolveRelease({ releaseRecord: { ...diagnosticRelease, draft: true } }),
    /must be published \(draft true\)/);
  for (const immutable of [false, undefined, 'true']) {
    await assert.rejects(resolveRelease({ releaseRecord: { ...diagnosticRelease, immutable } }),
      /must be immutable/);
  }
  await assert.rejects(resolveRelease({ releaseRecord: { ...diagnosticRelease, tag_name: `service-artifacts-${sha('f')}` } }),
    /release tag mismatch/);
  await assert.rejects(resolveRelease({ refRecord: { object: { type: 'commit', sha: sha('f') } } }),
    /resolves to f{40}, not the recorded Service source/);
});

test('loader reads only pinned bytes, release metadata and HTTP health', async () => {
  const fixture = diagnosticFixture();
  const selectionBytes = Buffer.from(canonicalJson(fixture.selector)); fixture.expected.selection.raw_sha256 = byteHash(selectionBytes); fixture.expected.selection.blob_sha256 = sha('f'); fixture.record.selection.raw_sha256 = fixture.expected.selection.raw_sha256; fixture.observation.selection.sha256 = fixture.expected.selection.raw_sha256; fixture.operation.selection.sha256 = fixture.expected.selection.raw_sha256;
  const stackMapBytes = Buffer.from('[]'); fixture.expected.selection.stack_map_sha256 = byteHash(stackMapBytes); fixture.record.selection.stack_map_sha256 = fixture.expected.selection.stack_map_sha256;
  const deploymentBytes = Buffer.from(JSON.stringify(fixture.observation));
  const operationBytes = Buffer.from(JSON.stringify(fixture.operation));
  fixture.expected.artifacts.deployment.record_sha256 = byteHash(deploymentBytes);
  fixture.expected.artifacts.operation.record_sha256 = byteHash(operationBytes);
  const run = { ...diagnosticRun(), name: 'Beta deploy-workload', run_attempt: 1, run_started_at: '2026-10-12T22:41:19Z', updated_at: '2026-10-12T22:52:17Z' };
  run.id = fixture.expected.infra.run_id; run.head_sha = fixture.expected.infra.sha;
  const metadata = (id, name, zip) => ({ id, node_id: `node-${id}`, name, size_in_bytes: zip.length, url: 'https://api.github.com', archive_download_url: 'https://api.github.com', expired: false, digest: `sha256:${byteHash(zip)}`, created_at: '2026-10-12T22:52:13Z', updated_at: '2026-10-12T22:52:13Z', expires_at: '2027-01-10T22:41:20Z', workflow_run: { id: run.id, repository_id: 1409047265, head_repository_id: 1409047265, head_branch: 'main', head_sha: run.head_sha } });
  const api = async (path, binary = false) => {
    if (path.includes('/actions/runs/')) return JSON.stringify(run);
    if (path.endsWith(`/artifacts/${fixture.expected.artifacts.deployment.id}`)) return JSON.stringify(metadata(fixture.expected.artifacts.deployment.id, fixture.expected.artifacts.deployment.name, Buffer.from('deployment zip fixture')));
    if (path.endsWith(`/artifacts/${fixture.expected.artifacts.operation.id}`)) return JSON.stringify(metadata(fixture.expected.artifacts.operation.id, fixture.expected.artifacts.operation.name, Buffer.from('operation zip fixture')));
    if (path.includes(`/artifacts/${fixture.expected.artifacts.deployment.id}/zip`)) return Buffer.from('deployment zip fixture');
    if (path.includes(`/artifacts/${fixture.expected.artifacts.operation.id}/zip`)) return Buffer.from('operation zip fixture');
    if (path.includes('/contents/')) {
      const isStack = path.includes(fixture.expected.selection.stack_map_file); const raw = isStack ? stackMapBytes : selectionBytes; const selected = isStack ? fixture.expected.selection.stack_map_sha256 : fixture.expected.selection.blob_sha256;
      return binary ? raw : JSON.stringify({ type: 'file', encoding: 'base64', size: raw.length, name: path.split('/').at(-1).split('?')[0], path: isStack ? fixture.expected.selection.stack_map_file : fixture.expected.selection.file, content: raw.toString('base64'), sha: selected, url: 'https://api.github.com', git_url: 'https://api.github.com', html_url: 'https://github.com', download_url: 'https://raw.githubusercontent.com' });
    }
    if (path === diagnosticReleasePath) return JSON.stringify({ ...diagnosticRelease, tag_name: diagnosticTag });
    if (path === diagnosticRefPath) return JSON.stringify({ object: { type: 'commit', sha: fixture.expected.service.source_sha } });
    if (path.includes('/releases/assets/')) throw new Error(`release asset must not be read (${path})`);
    throw new Error(`Unexpected API path: ${path}`);
  };
  const directory = await mkdtemp(join(tmpdir(), 'anywear-diagnostic-'));
  try {
    const loaded = await loadDiagnosticEvidence({ directory, expected: fixture.expected, api, extract: async (path, member) => member === 'deployment-record.json' ? deploymentBytes : operationBytes, environment: { GH_TOKEN: 'read-only', SERVICE_ARTIFACT_READ_TOKEN: 'read-only' }, fetcher: async url => new Response(JSON.stringify(url.includes('build-metadata') ? fixture.health.client : fixture.health.service), { status: 200 }) });
    assert.equal(loaded.record.record_type, 'anywear_beta_cleanup_diagnostic');
    assert.equal(loaded.artifacts.deployment.id, fixture.expected.artifacts.deployment.id);
    assert.equal(loaded.releaseTargetCommit, fixture.expected.service.source_sha);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
