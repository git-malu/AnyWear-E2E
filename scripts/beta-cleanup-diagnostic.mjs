import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  assertEqual, byteHash, exactKeys, parseStrictJson, repositories, requireCommit,
  requireHash, requireImageDigest, requireOwnedRepository, repositoryIds,
} from './evidence-contract.mjs';
import { ghApi, repositoryReadEnvironment, resolveTagCommit } from './github-read.mjs';
import { serviceArtifactsTag } from './qualification-record.mjs';

// #163 transition allow-list. Infra is replacing its `beta-deploy.yml` dispatch entry with
// `mutate.yml` while deliberately keeping the operation record's family name `beta-deploy`.
// A diagnostic record names the workflow path that produced it, so the historical path (for
// records already written) and the new path (for new records) are both accepted. Everything
// else about the path stays exact: it must be one of these two, the record's own producer,
// schema-verification and operation-executor paths must all agree, and the run must still be
// the reviewed main source. `family === 'beta-deploy'` is a record family name, not a path,
// and remains exact.
export const DIAGNOSTIC_WORKFLOW = '.github/workflows/beta-deploy.yml';
export const MUTATE_WORKFLOW = '.github/workflows/mutate.yml';
export const DIAGNOSTIC_WORKFLOWS = Object.freeze([DIAGNOSTIC_WORKFLOW, MUTATE_WORKFLOW]);
export const DIAGNOSTIC_OPERATION = 'deploy-workload';
export const DIAGNOSTIC_EXPECTED = Object.freeze({
  account_id: '650880818323',
  region: 'ap-east-1',
  infra: Object.freeze({
    repository: repositories.infra,
    sha: 'c7691379a37f242a57e65c3c37441fa4862faf9e',
    workflow_path: DIAGNOSTIC_WORKFLOW,
    workflow_ref: `${repositories.infra}/${DIAGNOSTIC_WORKFLOW}@refs/heads/main`,
    run_id: 38899879395,
    run_attempt: 1,
  }),
  artifacts: Object.freeze({
    deployment: Object.freeze({
      id: 12045719194,
      name: 'infra-deployment-38899879395-1',
      zip_sha256: '35ab1638ccccd58d6eeb0598c9cfe6209acabb0182303f4f8e0d8909f7c3b279',
      record_sha256: 'd8e2dc3644b07b7b3800e2de187586b8b4de18ffb0c6c32edcb1db63cbe18bc5',
      member: 'deployment-record.json',
    }),
    operation: Object.freeze({
      id: 12046615547,
      name: 'infra-operation-38899879395-1',
      zip_sha256: '4860a963fabc37deb44ce06005a5833bb661ab723d5f368783127e2dd3daffbe',
      record_sha256: 'c56d00c86da7bcc11328ce88671c7a2db7cc817d24c9da32e62e3513ff357fac',
      member: 'operation-record.json',
    }),
  }),
  selection: Object.freeze({
    file: 'selections/beta-cleanup-146-56387c30.json',
    blob_sha256: '15378b960119351f50271eb80c476db16919abfc',
    raw_sha256: '8adbc297f0d4eefcb4b61e213c61473364f1b0bf66ca46ad99a7d7995b5249ec',
    stack_map_file: 'stack-sources/beta-cleanup-86-recovery.json',
    stack_map_sha256: '592d911b56c3f200ce1d3c99e004712ae6bd291c31bad4b2202d0a33f6d1518b',
    release: Object.freeze({
      // Frozen historical fields: this is the release identity the 2026-01 deployment
      // observation recorded, including the manifest asset id and hash the release carried
      // at the time. They describe the preserved record and are never read as a live
      // expectation: the loader resolves the release by tag→commit and immutability and
      // downloads no asset (#193).
      repository: repositories.service,
      id: 414921320,
      manifest_asset_id: 647218560,
      manifest_sha256: 'ce09ddcb387fcec612cb4707ac9ee069a7025c094f0ab5c0231d914cb20488ce',
    }),
  }),
  service: Object.freeze({
    source_sha: '56387c30623a85249b0b714ff2c852a865f8ba3d',
    image_digest: 'sha256:4ad3ebe1b78c4cef1fd07c4850544f1c255e3a8aeff2a01d07a9c84d5786c6c3',
    schema_version: 17,
  }),
  runtime: Object.freeze({
    client_sha: '7b92ace1719b1ed53eb5a7cce2bfe32ef327410a',
    api_endpoint: 'https://d1pfqujqt29n11.cloudfront.net',
    client_endpoint: 'https://d2rztl7o0y7rf8.cloudfront.net',
    api_task_definition: 'arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-api:73',
    worker_task_definition: 'arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-worker:72',
    rollout_state: 'UPDATE_COMPLETE',
    schema_version: 17,
    prior_verify_task: 'arn:aws:ecs:ap-east-1:650880818323:task/beta-anywear/d91dd308201e44a58c695a883357e72d',
    verify_task: 'arn:aws:ecs:ap-east-1:650880818323:task/beta-anywear/92d4416c14974064935637cbb43cc53b',
    verify_task_definition: 'arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-verify:171',
  }),
  capability: Object.freeze({
    state_machine_version_arn: 'arn:aws:states:ap-east-1:650880818323:stateMachine:beta-anywear-tester-cleanup:6',
    definition_sha256: 'bf204191dc79822c030947c61d757b3c7c5bbe3e8ab17772b496de02665ed8a1',
    verification_task_definition: 'arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-cleanup-verify:6',
    cleanup_task_definition: 'arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-cleanup:6',
    cluster_arn: 'arn:aws:ecs:ap-east-1:650880818323:cluster/beta-anywear',
    log_group: '/anywear/beta/one-shot',
    schema_version: 17,
  }),
});

const SHA = /^[0-9a-f]{40}$/;
const HASH = /^[0-9a-f]{64}$/;
const TASK = /^arn:aws:ecs:ap-east-1:650880818323:task\/beta-anywear\/[a-f0-9]{32}$/;
const TASK_DEFINITION = /^arn:aws:ecs:ap-east-1:650880818323:task-definition\/[a-z0-9-]+:[1-9][0-9]*$/;

// The #163 transition allow-list check. It accepts the historical `beta-deploy.yml` path and
// the new `mutate.yml` path, and nothing else. `expectedPath` is the path the pinned
// diagnostic evidence names: a record may not mix the two.
function requireTransitionWorkflow(path, label = 'Diagnostic producer workflow path', expectedPath = path) {
  if (!DIAGNOSTIC_WORKFLOWS.includes(path)) throw new Error(`${label} is outside the #163 transition allow-list`);
  if (path !== expectedPath) throw new Error(`${label} does not match the diagnostic producer`);
  return path;
}

function equal(actual, expected, label) {
  assertEqual(actual, expected, label);
  return actual;
}

function assertArtifactMetadata(artifact, expected, run, now = Date.now()) {
  exactKeys(artifact, ['id', 'node_id', 'name', 'size_in_bytes', 'url', 'archive_download_url', 'expired', 'digest', 'created_at', 'updated_at', 'expires_at', 'workflow_run'], 'Artifact metadata');
  exactKeys(artifact.workflow_run, ['id', 'repository_id', 'head_repository_id', 'head_branch', 'head_sha'], 'Artifact workflow run');
  const dates = [artifact.created_at, artifact.updated_at, artifact.expires_at].map(Date.parse);
  if (artifact.id !== expected.id || artifact.name !== expected.name || artifact.expired !== false
    || artifact.digest !== `sha256:${expected.zip_sha256}` || artifact.workflow_run.id !== run.id
    || artifact.workflow_run.repository_id !== repositoryIds[repositories.infra]
    || artifact.workflow_run.head_repository_id !== repositoryIds[repositories.infra]
    || artifact.workflow_run.head_branch !== 'main' || artifact.workflow_run.head_sha !== expectedRunSha(run)
    || !Number.isSafeInteger(artifact.size_in_bytes) || artifact.size_in_bytes < 1
    || !dates.every(Number.isFinite) || dates[0] > dates[1] || dates[1] > dates[2] || dates[2] <= now) {
    throw new Error('Diagnostic artifact identity, source or lifetime mismatch');
  }
  return artifact;
}

function expectedRunSha(run) {
  if (run?.head_sha !== DIAGNOSTIC_EXPECTED.infra.sha) throw new Error('Diagnostic producer source mismatch');
  return run.head_sha;
}

export function assertDiagnosticRun(run, expected = DIAGNOSTIC_EXPECTED) {
  requireTransitionWorkflow(expected.infra.workflow_path);
  for (const repository of [run.repository, run.head_repository]) requireOwnedRepository(repository, repositories.infra, 'Diagnostic run repository');
  if (run.id !== expected.infra.run_id || run.run_attempt !== expected.infra.run_attempt || run.head_sha !== expected.infra.sha
    || run.head_branch !== 'main' || run.path !== expected.infra.workflow_path || run.event !== 'workflow_dispatch'
    || run.status !== 'completed' || run.conclusion !== 'success') {
    throw new Error('Diagnostic workflow run/source/owner/attempt binding mismatch');
  }
  return run;
}

function validateObservation(record, expected) {
  exactKeys(record, ['schema_version', 'record_type', 'infra', 'selection', 'stacks', 'observed', 'schema'], 'Diagnostic deployment observation');
  if (record.schema_version !== 2 || record.record_type !== 'anywear_infra_family_observation') throw new Error('Unexpected diagnostic deployment observation schema');
  exactKeys(record.infra, ['repository', 'run_attempt', 'run_id', 'sha', 'workflow_path', 'workflow_ref'], 'Diagnostic observation Infra');
  equal(record.infra, expected.infra, 'Diagnostic observation Infra');
  exactKeys(record.selection, ['file', 'sha256', 'release', 'components'], 'Diagnostic selection');
  if (record.selection.file !== expected.selection.file || record.selection.sha256 !== expected.selection.raw_sha256) throw new Error('Diagnostic selection path/hash mismatch');
  exactKeys(record.selection.release, ['repository', 'id', 'manifest_asset_id', 'manifest_sha256'], 'Diagnostic release');
  equal(record.selection.release, expected.selection.release, 'Diagnostic release');
  const selector = { schema_version: 2, record_type: 'anywear_infra_selection', release: record.selection.release, ...record.selection.components };
  // The retired v2 selection contract is not re-vendored. The historical record is
  // pinned by exact bytes and hashes, so this audit path checks the frozen shape it
  // was written with rather than parsing it through the removed consumer.
  if (selector.schema_version !== 2 || selector.record_type !== 'anywear_infra_selection'
    || !selector.image || !selector.lambdas || !selector.runtime_policy || !selector.schema) {
    throw new Error('Unexpected historical selection shape');
  }
  if (record.selection.components.image.service_sha !== expected.service.source_sha
    || record.selection.components.image.digest !== expected.service.image_digest) throw new Error('Diagnostic image source/digest mismatch');
  for (const component of [...Object.values(record.selection.components.lambdas), record.selection.components.runtime_policy, record.selection.components.schema]) {
    if (component.service_sha !== expected.service.source_sha) throw new Error('Diagnostic Service component source mismatch');
  }
  if (!Array.isArray(record.stacks) || record.stacks.length !== 4) throw new Error('Diagnostic stack observation is incomplete');
  const stackNames = new Set();
  for (const stack of record.stacks) {
    exactKeys(stack, ['region', 'source_repository', 'source_sha', 'stack_name', 'template_sha256'], 'Diagnostic stack');
    requireCommit(stack.source_sha, 'Diagnostic stack source'); requireHash(stack.template_sha256, 'Diagnostic stack template');
    if (stackNames.has(stack.stack_name) || !['AnyWearFoundationStack', 'AnyWearPlatformStack-beta', 'AnyWearWorkloadStack-beta', 'AnyWearBillingStack-beta'].includes(stack.stack_name)) throw new Error('Diagnostic stack identity mismatch');
    stackNames.add(stack.stack_name);
    if (stack.region !== (stack.stack_name === 'AnyWearBillingStack-beta' ? 'us-east-1' : expected.region)) throw new Error('Diagnostic stack region mismatch');
  }
  exactKeys(record.observed, ['client_sha', 'ecs', 'endpoints', 'image_digest', 'lambdas', 'policy_content_sha256', 'queue_config_sha256', 'service_sha'], 'Diagnostic observed tuple');
  if (record.observed.client_sha !== expected.runtime.client_sha || record.observed.service_sha !== expected.service.source_sha
    || record.observed.image_digest !== expected.service.image_digest || record.observed.endpoints.api !== expected.runtime.api_endpoint
    || record.observed.endpoints.client !== expected.runtime.client_endpoint) throw new Error('Diagnostic observed runtime identity mismatch');
  exactKeys(record.observed.endpoints, ['api', 'client'], 'Diagnostic endpoints');
  for (const value of Object.values(record.observed.endpoints)) if (typeof value !== 'string' || !value.startsWith('https://')) throw new Error('Diagnostic endpoint is not HTTPS');
  exactKeys(record.observed.ecs, ['api', 'worker'], 'Diagnostic ECS tuple');
  if (record.observed.ecs.api.task_definition_arn !== expected.runtime.api_task_definition
    || record.observed.ecs.worker.task_definition_arn !== expected.runtime.worker_task_definition) throw new Error('Diagnostic ECS task definition mismatch');
  for (const item of Object.values(record.observed.ecs)) {
    exactKeys(item, ['image_digest', 'service_arn', 'task_definition_arn'], 'Diagnostic ECS identity');
    if (item.image_digest !== expected.service.image_digest || !TASK_DEFINITION.test(item.task_definition_arn)) throw new Error('Diagnostic ECS image/definition mismatch');
  }
  exactKeys(record.schema, ['applied_migration_ids', 'applied_schema_version', 'compatibility_result', 'minimum_migration_count', 'minimum_schema_version', 'observed_applied_journal_sha256', 'selected_current_version', 'selected_journal_sha256', 'selected_migration_ids', 'verification'], 'Diagnostic schema observation');
  if (record.schema.applied_schema_version !== expected.service.schema_version || record.schema.selected_current_version !== expected.service.schema_version
    || record.schema.minimum_schema_version !== expected.service.schema_version || record.schema.compatibility_result !== 'compatible') throw new Error('Diagnostic schema/version mismatch');
  exactKeys(record.schema.verification, ['command_sha256', 'executor', 'image_digest', 'service_sha', 'source_repository', 'source_sha', 'task_arn', 'task_definition_arn'], 'Diagnostic schema verification');
  exactKeys(record.schema.verification.executor, ['repository', 'run_attempt', 'run_id', 'sha', 'workflow_path'], 'Diagnostic schema executor');
  requireTransitionWorkflow(record.schema.verification.executor.workflow_path,
    'Diagnostic schema executor workflow path', expected.infra.workflow_path);
  if (record.schema.verification.source_repository !== repositories.infra || record.schema.verification.source_sha !== expected.infra.sha
    || record.schema.verification.service_sha !== expected.service.source_sha || record.schema.verification.image_digest !== expected.service.image_digest
    || record.schema.verification.executor.repository !== expected.infra.repository || record.schema.verification.executor.run_attempt !== expected.infra.run_attempt
    || record.schema.verification.executor.run_id !== expected.infra.run_id || record.schema.verification.executor.sha !== expected.infra.sha
    || !TASK.test(record.schema.verification.task_arn)
    || record.schema.verification.task_definition_arn !== 'arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-artifact-verify:155') throw new Error('Diagnostic schema verification binding mismatch');
  return { selector, record };
}

function eventByType(events, type) {
  const rows = events.filter(event => event.type === type);
  if (rows.length !== 1) throw new Error(`Diagnostic operation requires exactly one ${type} event`);
  return rows[0];
}

function validateOperation(operation, expected, observation) {
  exactKeys(operation, ['changed_stack_names', 'context', 'events', 'executor', 'family', 'final_observation', 'lifecycle_implementation_origin', 'operation', 'original_runtime', 'original_stack_templates', 'record_type', 'recovery', 'result', 'stack_manifest', 'schema_version', 'selection'], 'Diagnostic operation record');
  if (operation.schema_version !== 3 || operation.record_type !== 'anywear_infra_operation' || operation.family !== 'beta-deploy'
    || operation.operation !== DIAGNOSTIC_OPERATION || operation.result !== 'succeeded' || operation.recovery !== 'not-required' || operation.final_observation !== 'success') throw new Error('Diagnostic operation result/schema mismatch');
  exactKeys(operation.context, ['account', 'identity_phase', 'region', 'retention_protection'], 'Diagnostic operation context');
  if (operation.context.account !== expected.account_id || operation.context.region !== expected.region || operation.context.identity_phase !== 'retired' || operation.context.retention_protection !== true) throw new Error('Diagnostic operation account/region/capability context mismatch');
  exactKeys(operation.executor, ['repository', 'run_attempt', 'run_id', 'sha', 'workflow_path'], 'Diagnostic operation executor');
  equal(operation.executor, { repository: expected.infra.repository, run_attempt: expected.infra.run_attempt, run_id: expected.infra.run_id, sha: expected.infra.sha, workflow_path: expected.infra.workflow_path }, 'Diagnostic operation executor');
  exactKeys(operation.lifecycle_implementation_origin, ['path', 'repository', 'sha'], 'Diagnostic lifecycle origin');
  if (operation.lifecycle_implementation_origin.repository !== repositories.service || !SHA.test(operation.lifecycle_implementation_origin.sha)) throw new Error('Diagnostic lifecycle source mismatch');
  exactKeys(operation.original_runtime, ['image_digest', 'service_sha'], 'Diagnostic original runtime');
  if (operation.original_runtime.image_digest === expected.service.image_digest || operation.original_runtime.service_sha === expected.service.source_sha) throw new Error('Diagnostic operation lost original runtime boundary');
  exactKeys(operation.selection, ['file', 'sha256', 'release', 'components'], 'Diagnostic operation selection');
  equal(operation.selection, observation.selection, 'Diagnostic operation selection');
  // Frozen historical stack set: the diagnostic record was written when the
  // Workload stack was still an Infra-configured stack. The current v3 configured
  // set no longer contains it, so the audit path must not use it.
  const configured = ['AnyWearFoundationStack', 'AnyWearPlatformStack-beta', 'AnyWearWorkloadStack-beta', 'AnyWearBillingStack-beta'];
  if (!Array.isArray(operation.original_stack_templates) || operation.original_stack_templates.length !== configured.length) throw new Error('Diagnostic operation stack maps are incomplete');
  for (const row of operation.original_stack_templates) exactKeys(row, ['region', 'stack_name', 'template_sha256'], 'Diagnostic original stack');
  const stackRows = (rows) => {
    if (!Array.isArray(rows) || rows.length !== configured.length) throw new Error('Diagnostic operation stack manifest is incomplete');
    const names = new Set();
    for (const row of rows) {
      if (!configured.includes(row?.stack_name) || names.has(row.stack_name)) throw new Error('Diagnostic stack identity mismatch');
      names.add(row.stack_name);
    }
    return rows;
  };
  stackRows(operation.stack_manifest);
  for (const row of operation.stack_manifest) exactKeys(row, ['region', 'source_repository', 'source_sha', 'stack_name'], 'Diagnostic stack manifest row');
  if (!Array.isArray(operation.changed_stack_names) || !operation.changed_stack_names.length
    || operation.changed_stack_names.some(name => !configured.includes(name))) throw new Error('Diagnostic changed stack names are outside the configured set');
  const final = eventByType(operation.events, 'final-beta-activity');
  exactKeys(final, ['platform_active', 'platform_status', 'type', 'workload_active', 'workload_status'], 'Diagnostic final activity');
  if (final.platform_active !== 'true' || final.workload_active !== 'true' || final.platform_status !== expected.runtime.rollout_state || final.workload_status !== expected.runtime.rollout_state) throw new Error('Diagnostic workload rollout is incomplete');
  const workload = eventByType(operation.events, 'workload-parameter-readback');
  exactKeys(workload, ['beta_api_sizing_profile', 'beta_sizing_telemetry', 'image_digest', 'service_sha', 'stack_name', 'stack_status', 'type'], 'Diagnostic workload readback');
  if (workload.image_digest !== expected.service.image_digest || workload.service_sha !== expected.service.source_sha || workload.stack_name !== 'AnyWearWorkloadStack-beta' || workload.stack_status !== expected.runtime.rollout_state) throw new Error('Diagnostic workload image/source/readback mismatch');
  const sizing = eventByType(operation.events, 'beta-sizing-state');
  exactKeys(sizing, ['beta_api_sizing_profile', 'beta_sizing_telemetry', 'ecs', 'type'], 'Diagnostic sizing state');
  exactKeys(sizing.ecs, ['api', 'worker'], 'Diagnostic sizing ECS');
  if (sizing.ecs.api.task_definition_arn !== expected.runtime.api_task_definition || sizing.ecs.worker.task_definition_arn !== expected.runtime.worker_task_definition) throw new Error('Diagnostic sizing task definition mismatch');
  const verify = eventByType(operation.events, 'one-shot');
  exactKeys(verify, ['action', 'command_sha256', 'image_digest', 'result', 'role', 'service_sha', 'task_arn', 'task_definition_arn', 'type'], 'Diagnostic verification task');
  if (verify.role !== 'verify' || verify.result !== 'stopped-success' || verify.action !== expected.runtime.api_endpoint || verify.service_sha !== expected.service.source_sha || verify.image_digest !== expected.service.image_digest || verify.task_arn !== expected.runtime.verify_task || verify.task_definition_arn !== expected.runtime.verify_task_definition || !HASH.test(verify.command_sha256)) throw new Error('Diagnostic verification task binding/status mismatch');
  const started = operation.events.filter(event => event.type === 'runtime-task-started');
  if (started.length !== 2) throw new Error('Diagnostic runtime task observations are incomplete');
  const definitions = operation.events.filter(event => event.type === 'runtime-task-definition');
  if (definitions.length !== 2) throw new Error('Diagnostic runtime task definitions are incomplete');
  definitions.forEach((definition, index) => {
    exactKeys(definition, ['task_definition_arn', 'type'], 'Diagnostic runtime task definition');
    if (definition.task_definition_arn !== `arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-artifact-verify:${index === 0 ? 154 : 155}`) throw new Error('Diagnostic runtime task definition is foreign');
  });
  for (const [index, task] of started.entries()) {
    exactKeys(task, ['result', 'task_arns', 'type'], 'Diagnostic runtime task');
    const expectedTask = index === 0 ? expected.runtime.prior_verify_task : observation.schema.verification.task_arn;
    if (task.result !== 'observed' || !Array.isArray(task.task_arns) || task.task_arns.length !== 1 || !TASK.test(task.task_arns[0]) || task.task_arns[0] !== expectedTask) throw new Error('Diagnostic runtime task is missing, foreign or malformed');
  }
  const cessation = eventByType(operation.events, 'cleanup-capability-cessation');
  exactKeys(cessation, ['cleanup_task_count', 'execution_count', 'inventory_sha256', 'machine_arn', 'manager_result_reconciliation_required', 'terminal_failed_execution_arns', 'type'], 'Diagnostic cleanup cessation');
  if (cessation.cleanup_task_count !== 0 || cessation.execution_count !== 8 || cessation.machine_arn !== expected.capability.state_machine_version_arn.replace(/:[1-9][0-9]*$/, '') || cessation.manager_result_reconciliation_required !== true || !HASH.test(cessation.inventory_sha256) || cessation.terminal_failed_execution_arns.length !== 5) throw new Error('Diagnostic cleanup cessation binding mismatch');
  return operation;
}

function validateCapability(capability, expected) {
  exactKeys(capability, ['account_id', 'region', 'state_machine_version_arn', 'definition_sha256', 'verification_task_definition', 'cleanup_task_definition', 'cluster_arn', 'log_group', 'service_sha', 'image_digest', 'schema_version'], 'Diagnostic capability');
  const expectedCapability = { account_id: expected.account_id, region: expected.region, ...expected.capability, service_sha: expected.service.source_sha, image_digest: expected.service.image_digest };
  equal(capability, expectedCapability, 'Diagnostic cleanup capability');
  requireHash(capability.definition_sha256, 'Cleanup state machine definition'); requireImageDigest(capability.image_digest);
  return capability;
}

const CLIENT_HEALTH_KEYS = Object.freeze(['schema_version', 'component', 'source_commit', 'built_at']);
const CLIENT_INTERFACE_KEYS = Object.freeze(['api_base_url', 'cognito_user_pool_id', 'cognito_client_id']);

// The deployed Client's build-metadata identity. Schema 1 is exactly the four identity
// fields. Schema 2 (AnyWear-Client#21) keeps those four unchanged and adds one `interface`
// object. Schema 3 (#160) keeps that shape and adds the `client_version` the Client build
// states, so every released shape is accepted strictly: no other version, no unknown key
// in any shape, no missing or empty interface member, and the `source_commit` binding to
// the observed Client revision unchanged across all three.
function validateClientHealth(health, expected) {
  if (!health || typeof health !== 'object' || Array.isArray(health)) throw new Error('Diagnostic Client health must be an object');
  if (health.schema_version === 3) {
    exactKeys(health, [...CLIENT_HEALTH_KEYS, 'client_version', 'interface'], 'Diagnostic Client health');
    exactKeys(health.interface, CLIENT_INTERFACE_KEYS, 'Diagnostic Client interface');
    for (const key of CLIENT_INTERFACE_KEYS) {
      if (typeof health.interface[key] !== 'string' || health.interface[key].length === 0) {
        throw new Error(`Diagnostic Client interface.${key} must be a non-empty string`);
      }
    }
    if (!Number.isSafeInteger(health.client_version) || health.client_version < 0) {
      throw new Error('Diagnostic Client client_version must be a non-negative safe integer');
    }
  } else if (health.schema_version === 2) {
    exactKeys(health, [...CLIENT_HEALTH_KEYS, 'interface'], 'Diagnostic Client health');
    exactKeys(health.interface, CLIENT_INTERFACE_KEYS, 'Diagnostic Client interface');
    for (const key of CLIENT_INTERFACE_KEYS) {
      if (typeof health.interface[key] !== 'string' || health.interface[key].length === 0) {
        throw new Error(`Diagnostic Client interface.${key} must be a non-empty string`);
      }
    }
  } else if (health.schema_version === 1) {
    exactKeys(health, CLIENT_HEALTH_KEYS, 'Diagnostic Client health');
  } else {
    throw new Error('Diagnostic Client health schema version is unsupported');
  }
  if (health.component !== 'AnyWear-Client' || health.source_commit !== expected.runtime.client_sha) {
    throw new Error('Diagnostic Client health identity mismatch');
  }
  return health;
}

export function validateDiagnosticRecord(record, expected = DIAGNOSTIC_EXPECTED) {
  requireTransitionWorkflow(expected.infra.workflow_path);
  exactKeys(record, ['schema_version', 'record_type', 'producer', 'artifacts', 'selection', 'service', 'runtime', 'capability', 'observation', 'operation'], 'Diagnostic record');
  if (record.schema_version !== 1 || record.record_type !== 'anywear_beta_cleanup_diagnostic') throw new Error('Unsupported diagnostic record schema');
  exactKeys(record.producer, ['account_id', 'region', 'repository', 'workflow_path', 'workflow_ref', 'run_id', 'run_attempt', 'sha', 'operation'], 'Diagnostic producer');
  equal(record.producer, { account_id: expected.account_id, region: expected.region, ...expected.infra, operation: DIAGNOSTIC_OPERATION }, 'Diagnostic producer');
  exactKeys(record.artifacts, ['deployment', 'operation'], 'Diagnostic artifact bindings');
  equal(record.artifacts, expected.artifacts, 'Diagnostic artifact bindings');
  validateObservation(record.observation, expected);
  exactKeys(record.selection, ['file', 'blob_sha256', 'raw_sha256', 'stack_map_file', 'stack_map_sha256'], 'Diagnostic committed selection');
  equal(record.selection, { file: expected.selection.file, blob_sha256: expected.selection.blob_sha256, raw_sha256: expected.selection.raw_sha256, stack_map_file: expected.selection.stack_map_file, stack_map_sha256: expected.selection.stack_map_sha256 }, 'Diagnostic committed selection');
  exactKeys(record.service, ['source_sha', 'release', 'manifest_sha256', 'image_digest'], 'Diagnostic Service binding');
  equal(record.service, { source_sha: expected.service.source_sha, release: expected.selection.release.id, manifest_sha256: expected.selection.release.manifest_sha256, image_digest: expected.service.image_digest }, 'Diagnostic Service binding');
  exactKeys(record.runtime, ['account_id', 'region', 'client_sha', 'api_endpoint', 'client_endpoint', 'api_task_definition', 'worker_task_definition', 'rollout_state', 'schema_version', 'health'], 'Diagnostic runtime binding');
  if (record.runtime.account_id !== expected.account_id || record.runtime.region !== expected.region || record.runtime.client_sha !== expected.runtime.client_sha
    || record.runtime.api_endpoint !== expected.runtime.api_endpoint || record.runtime.client_endpoint !== expected.runtime.client_endpoint || record.runtime.api_task_definition !== expected.runtime.api_task_definition
    || record.runtime.worker_task_definition !== expected.runtime.worker_task_definition || record.runtime.rollout_state !== expected.runtime.rollout_state || record.runtime.schema_version !== expected.runtime.schema_version) throw new Error('Diagnostic runtime binding mismatch');
  exactKeys(record.runtime.health, ['client', 'service'], 'Diagnostic health');
  validateClientHealth(record.runtime.health.client, expected);
  exactKeys(record.runtime.health.service, ['status', 'service_commit', 'image_digest', 'minimum_schema_version'], 'Diagnostic Service health', ['minimum_client_version']);
  if (Object.hasOwn(record.runtime.health.service, 'minimum_client_version')
    && (!Number.isSafeInteger(record.runtime.health.service.minimum_client_version)
      || record.runtime.health.service.minimum_client_version < 0)) {
    throw new Error('Diagnostic Service minimum_client_version must be a non-negative safe integer');
  }
  if (record.runtime.health.service.status !== 'ok'
    || record.runtime.health.service.service_commit !== expected.service.source_sha || record.runtime.health.service.image_digest !== expected.service.image_digest
    || record.runtime.health.service.minimum_schema_version !== expected.service.schema_version) throw new Error('Diagnostic HTTP health mismatch');
  validateCapability(record.capability, expected);
  validateOperation(record.operation, expected, record.observation);
  return record;
}

function extractArchiveMember(archivePath, member) {
  return execFileSync('python3', ['-c', [
    'import sys, zipfile',
    'with zipfile.ZipFile(sys.argv[1]) as z:',
    ' entries=z.infolist()',
    ' if len(entries)!=1 or entries[0].filename!=sys.argv[2] or entries[0].is_dir() or entries[0].file_size>1048576: raise ValueError("Unexpected diagnostic artifact contents")',
    ' sys.stdout.buffer.write(z.read(entries[0]))',
  ].join('\n'), archivePath, member], { timeout: 15_000, maxBuffer: 1048576, stdio: ['ignore', 'pipe', 'pipe'] });
}

async function readContent(api, path, environment, expectedRawHash, expectedBlobHash) {
  const metadata = parseStrictJson(await api(`repos/${repositories.infra}/contents/${path}?ref=${DIAGNOSTIC_EXPECTED.infra.sha}`, false, environment));
  exactKeys(metadata, ['type', 'encoding', 'size', 'name', 'path', 'content', 'sha', 'url', 'git_url', 'html_url', 'download_url'], 'Committed diagnostic file metadata', ['_links']);
  if (metadata.type !== 'file' || metadata.path !== path || metadata.name !== path.split('/').at(-1)
    || (expectedBlobHash !== undefined && metadata.sha !== expectedBlobHash)) throw new Error('Committed diagnostic file/blob binding mismatch');
  if (metadata.encoding !== 'base64' || typeof metadata.content !== 'string') throw new Error('Committed diagnostic file content encoding is not base64');
  const bytes = Buffer.from(metadata.content.replace(/\n/g, ''), 'base64');
  if (byteHash(bytes) !== expectedRawHash) throw new Error('Committed diagnostic file raw checksum mismatch');
  return bytes;
}

async function readHealth(fetcher, expected) {
  const get = async (url, label) => {
    const response = await fetcher(url, { headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`);
    return parseStrictJson(Buffer.from(await response.arrayBuffer()));
  };
  const [client, service] = await Promise.all([get(`${expected.runtime.client_endpoint}/build-metadata.json`, 'Client metadata'), get(`${expected.runtime.api_endpoint}/health`, 'Service health')]);
  return { client, service };
}

// #193: the recorded release identity is resolved from the release itself — the release
// is published and immutable, its tag names the recorded Service source, and that tag
// resolves to the same commit, following annotated tags. The historical record's manifest
// asset id/hash stay frozen evidence of what that release carried; they are not looked up,
// and no release asset (and no manifest body) is downloaded.
export async function resolveDiagnosticServiceRelease({ expected = DIAGNOSTIC_EXPECTED, api = ghApi, environment = process.env } = {}) {
  const serviceEnvironment = repositoryReadEnvironment(repositories.service, environment);
  const release = parseStrictJson(await api(`repos/${repositories.service}/releases/${expected.selection.release.id}`, false, serviceEnvironment));
  if (release?.id !== expected.selection.release.id) {
    throw new Error(`Diagnostic Service release identity mismatch: expected ${expected.selection.release.id}, observed ${JSON.stringify(release?.id)}`);
  }
  if (release.draft !== false) throw new Error(`Diagnostic Service release ${expected.selection.release.id} must be published (draft ${JSON.stringify(release.draft)})`);
  if (release.immutable !== true) throw new Error(`Diagnostic Service release ${expected.selection.release.id} must be immutable (immutable ${JSON.stringify(release.immutable)})`);
  const releaseTag = serviceArtifactsTag(expected.service.source_sha);
  if (release.tag_name !== releaseTag) {
    throw new Error(`Diagnostic Service release tag mismatch: expected ${releaseTag}, observed ${JSON.stringify(release.tag_name)}`);
  }
  const { commit: targetCommit } = await resolveTagCommit({
    repository: repositories.service, tag: releaseTag, api, environment: serviceEnvironment, label: 'Diagnostic Service release tag',
  });
  if (targetCommit !== expected.service.source_sha) {
    throw new Error(`Diagnostic Service release ${releaseTag} resolves to ${targetCommit}, not the recorded Service source ${expected.service.source_sha}`);
  }
  return { release, targetCommit };
}

export async function loadDiagnosticEvidence({ directory, api = ghApi, extract = extractArchiveMember, fetcher = fetch, environment = process.env, expected = DIAGNOSTIC_EXPECTED } = {}) {
  if (!directory) throw new Error('Diagnostic evidence directory is required');
  if (Object.keys(environment).some(key => /^(?:DELETE|PATCH|POST|PUT|MUTATION|WRITE)/i.test(key) && environment[key])) throw new Error('Diagnostic evidence loader accepts read-only inputs only');
  const infraEnvironment = repositoryReadEnvironment(repositories.infra, environment);
  const run = parseStrictJson(await api(`repos/${repositories.infra}/actions/runs/${expected.infra.run_id}/attempts/${expected.infra.run_attempt}`, false, infraEnvironment));
  assertDiagnosticRun(run, expected);
  const readArtifact = async (kind) => {
    const descriptor = expected.artifacts[kind];
    const artifact = parseStrictJson(await api(`repos/${repositories.infra}/actions/artifacts/${descriptor.id}`, false, infraEnvironment));
    assertArtifactMetadata(artifact, descriptor, run);
    const archive = await api(`repos/${repositories.infra}/actions/artifacts/${descriptor.id}/zip`, true, infraEnvironment);
    if (byteHash(archive) !== descriptor.zip_sha256) throw new Error(`${kind} diagnostic artifact ZIP checksum mismatch`);
    return { artifact, archive };
  };
  const deployment = await readArtifact('deployment'); const operation = await readArtifact('operation');
  await mkdir(directory, { recursive: true });
  const deploymentPath = resolve(directory, 'diagnostic-deployment.zip'); await writeFile(deploymentPath, deployment.archive);
  const operationPath = resolve(directory, 'diagnostic-operation.zip'); await writeFile(operationPath, operation.archive);
  const deploymentBytes = await extract(deploymentPath, expected.artifacts.deployment.member);
  const operationBytes = await extract(operationPath, expected.artifacts.operation.member);
  if (byteHash(deploymentBytes) !== expected.artifacts.deployment.record_sha256 || byteHash(operationBytes) !== expected.artifacts.operation.record_sha256) throw new Error('Diagnostic artifact record checksum mismatch');
  const observation = parseStrictJson(deploymentBytes); const operationRecord = parseStrictJson(operationBytes);
  const selectionBytes = await readContent(api, expected.selection.file, infraEnvironment, expected.selection.raw_sha256, expected.selection.blob_sha256);
  const stackMapBytes = await readContent(api, expected.selection.stack_map_file, infraEnvironment, expected.selection.stack_map_sha256);
  const selection = parseStrictJson(selectionBytes);
  if (selection.schema_version !== 2 || selection.record_type !== 'anywear_infra_selection'
    || !selection.release || !selection.image || !selection.lambdas || !selection.runtime_policy || !selection.schema) {
    throw new Error('Unexpected historical selection shape');
  }
  if (selectionBytes.toString('utf8') !== (await import('./evidence-contract.mjs')).canonicalJson(selection)) throw new Error('Diagnostic selection bytes are not canonical');
  const selected = selection;
  const health = await readHealth(fetcher, expected);
  const record = { schema_version: 1, record_type: 'anywear_beta_cleanup_diagnostic',
    producer: { account_id: expected.account_id, region: expected.region, ...expected.infra, operation: DIAGNOSTIC_OPERATION },
    artifacts: expected.artifacts,
    selection: { file: expected.selection.file, blob_sha256: expected.selection.blob_sha256, raw_sha256: expected.selection.raw_sha256, stack_map_file: expected.selection.stack_map_file, stack_map_sha256: expected.selection.stack_map_sha256 },
    service: { source_sha: expected.service.source_sha, release: expected.selection.release.id, manifest_sha256: expected.selection.release.manifest_sha256, image_digest: expected.service.image_digest },
    runtime: { account_id: expected.account_id, region: expected.region, client_sha: expected.runtime.client_sha, api_endpoint: expected.runtime.api_endpoint, client_endpoint: expected.runtime.client_endpoint,
      api_task_definition: expected.runtime.api_task_definition, worker_task_definition: expected.runtime.worker_task_definition, rollout_state: expected.runtime.rollout_state, schema_version: expected.runtime.schema_version, health },
    capability: { account_id: expected.account_id, region: expected.region, ...expected.capability, service_sha: expected.service.source_sha, image_digest: expected.service.image_digest },
    observation, operation: operationRecord };
  validateDiagnosticRecord(record, expected);
  assertEqual(selected, { schema_version: 2, record_type: 'anywear_infra_selection', release: observation.selection.release, ...observation.selection.components }, 'Diagnostic selection observation');
  const { release, targetCommit: releaseTargetCommit } = await resolveDiagnosticServiceRelease({ expected, api, environment });
  return { record, observation, operation: operationRecord, selection, stackMapBytes, release, releaseTargetCommit, health,
    artifacts: { deployment: deployment.artifact, operation: operation.artifact }, bytes: { deployment: deploymentBytes, operation: operationBytes, selection: selectionBytes } };
}

export { extractArchiveMember };
