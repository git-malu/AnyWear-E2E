import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { effectiveAdmissionMode } from './beta-admission-mode.mjs';
import { FIXTURE_DELAY_MS, FIXTURE_KEY, FIXTURE_PORTS, fixtureProcessSource } from './nonpaid-provider-fixture.mjs';
import { activateRuntimeWindow, captureRuntimeWindow, guardRuntimeWindow, pauseRuntimeWindow } from './runtime-window-controls.mjs';

const TASK_DEFINITION = /^arn:aws:ecs:ap-east-1:650880818323:task-definition\/[a-zA-Z0-9_-]+:[1-9][0-9]*$/;
const IMAGE = /^650880818323\.dkr\.ecr\.ap-east-1\.amazonaws\.com\/[^@:]+(?:[:@].+)?$/;
const DEFINITION_FIELDS = ['taskRoleArn', 'executionRoleArn', 'networkMode', 'containerDefinitions',
  'volumes', 'placementConstraints', 'requiresCompatibilities', 'cpu', 'memory', 'pidMode', 'ipcMode',
  'proxyConfiguration', 'inferenceAccelerators', 'ephemeralStorage', 'runtimePlatform', 'enableFaultInjection'];
const SERVICE_FIELDS = ['serviceArn', 'clusterArn', 'serviceName', 'desiredCount', 'launchType',
  'capacityProviderStrategy', 'platformVersion', 'platformFamily', 'deploymentConfiguration',
  'networkConfiguration', 'placementConstraints', 'placementStrategy', 'schedulingStrategy',
  'enableExecuteCommand', 'enableECSManagedTags', 'propagateTags', 'loadBalancers', 'serviceRegistries',
  'serviceConnectConfiguration', 'volumeConfigurations', 'vpcLatticeConfigurations'];
const TASK_DEFINITION_METADATA_FIELDS = new Set(['taskDefinitionArn', 'revision', 'status', 'registeredAt', 'registeredBy',
  'requiresAttributes', 'compatibilities', 'deregisteredAt', 'deleteRequestedAt']);
const TASK_DEFINITION_DEFAULTS = new Map([['volumes', []], ['placementConstraints', []], ['requiresCompatibilities', []],
  ['inferenceAccelerators', []], ['enableFaultInjection', false]]);
const CONTAINER_DEFAULTS = new Map([['essential', true], ['privileged', false], ['readonlyRootFilesystem', false],
  ['mountPoints', []], ['portMappings', []], ['systemControls', []], ['ulimits', []], ['resourceRequirements', []],
  ['dependsOn', []], ['environmentFiles', []], ['volumesFrom', []], ['links', []], ['credentialSpecs', []], ['cpu', 0], ['environment', []], ['secrets', []]]);
CONTAINER_DEFAULTS.set('dockerSecurityOptions', []);
CONTAINER_DEFAULTS.set('dockerLabels', {});

function assertCompleteAutoscalingPage(result, label) {
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || (result.NextToken !== undefined && result.NextToken !== null && result.NextToken !== '')
    || (result.nextToken !== undefined && result.nextToken !== null && result.nextToken !== '')) {
    throw new Error(`Autoscaling ${label} pagination was incomplete`);
  }
}

function compareStableKey(left, right) {
  const a = JSON.stringify(left);
  const b = JSON.stringify(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortKnownCollection(values, key) {
  return [...values].sort((left, right) => compareStableKey(key(left), key(right)));
}

function canonicalizeScalingPolicy(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new Error('Autoscaling policy response was invalid');
  }
  const canonical = structuredClone(policy);
  if (!Array.isArray(canonical.Alarms)) throw new Error('Autoscaling policy alarms response was incomplete');
  canonical.Alarms = sortKnownCollection(canonical.Alarms,
    (alarm) => [alarm?.AlarmARN ?? null, alarm?.AlarmName ?? null]);
  if (canonical.PolicyType === 'StepScaling') {
    const configuration = canonical.StepScalingPolicyConfiguration;
    if (!configuration || !Array.isArray(configuration.StepAdjustments)) {
      throw new Error('Autoscaling step adjustments response was incomplete');
    }
    configuration.StepAdjustments = sortKnownCollection(configuration.StepAdjustments,
      (step) => [step?.MetricIntervalLowerBound ?? null, step?.MetricIntervalUpperBound ?? null,
        step?.ScalingAdjustment ?? null]);
  }
  return canonical;
}

function canonicalizeAutoscalingSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)
    || typeof snapshot.resource_id !== 'string' || !snapshot.target
    || !Array.isArray(snapshot.policies) || !Array.isArray(snapshot.schedules)) {
    throw new Error('Autoscaling snapshot was incomplete');
  }
  return {
    resource_id: snapshot.resource_id,
    target: structuredClone(snapshot.target),
    policies: sortKnownCollection(snapshot.policies,
      (policy) => [policy?.PolicyARN ?? null, policy?.PolicyName ?? null]).map(canonicalizeScalingPolicy),
    schedules: sortKnownCollection(snapshot.schedules,
      (schedule) => [schedule?.ScheduledActionARN ?? null, schedule?.ScheduledActionName ?? null]),
  };
}

function hash(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function pick(value, keys) { return Object.fromEntries(keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]])); }
function withoutAwsDefaults(value, defaults) {
  return Object.fromEntries(Object.entries(value ?? {}).filter(([key, child]) => !defaults.has(key) || !isDeepStrictEqual(child, defaults.get(key))));
}
function normalizeNamedEntries(entries) {
  return [...(entries ?? [])].map((entry, index) => ({ entry, index }))
    .sort((left, right) => left.entry.name.localeCompare(right.entry.name) || left.index - right.index)
    .map(({ entry }) => entry);
}
export function normalizeFixtureDefinition(definition) {
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) throw new Error('Fixture task definition is not an object');
  const unknown = Object.keys(definition).filter((key) => !DEFINITION_FIELDS.includes(key) && key !== 'family' && !TASK_DEFINITION_METADATA_FIELDS.has(key));
  if (unknown.length) throw new Error(`Fixture task definition has unexpected fields: ${unknown.join(',')}`);
  if (!Array.isArray(definition.containerDefinitions) || definition.containerDefinitions.length !== 2) throw new Error('Fixture task definition must contain exactly worker and sidecar containers');
  const normalized = withoutAwsDefaults({ ...pick(definition, DEFINITION_FIELDS), family: definition.family }, TASK_DEFINITION_DEFAULTS);
  normalized.containerDefinitions = definition.containerDefinitions.map((container) => {
    const allowed = ['name', 'image', 'repositoryCredentials', 'cpu', 'memory', 'memoryReservation', 'links', 'portMappings', 'essential', 'entryPoint', 'command', 'environment', 'environmentFiles', 'mountPoints', 'volumesFrom', 'linuxParameters', 'secrets', 'dependsOn', 'startTimeout', 'stopTimeout', 'hostname', 'user', 'workingDirectory', 'disableNetworking', 'privileged', 'readonlyRootFilesystem', 'dnsServers', 'dnsSearchDomains', 'extraHosts', 'pseudoTerminal', 'systemControls', 'resourceRequirements', 'firelensConfiguration', 'credentialSpecs', 'ulimits', 'healthCheck', 'logConfiguration', 'dockerSecurityOptions', 'dockerLabels'];
    const unknownContainer = Object.keys(container).filter((key) => !allowed.includes(key));
    if (unknownContainer.length) throw new Error(`Fixture container has unexpected fields: ${unknownContainer.join(',')}`);
    const normalizedContainer = withoutAwsDefaults(structuredClone(container), CONTAINER_DEFAULTS);
    normalizedContainer.environment = normalizeNamedEntries(normalizedContainer.environment);
    normalizedContainer.secrets = normalizeNamedEntries(normalizedContainer.secrets);
    return normalizedContainer;
  });
  return normalized;
}

export async function exactService(io, stack, name) {
  const result = await io.aws(['ecs', 'describe-services', '--cluster', stack.cluster, '--services', name]);
  if (result.failures?.length || result.services?.length !== 1) throw new Error('Exact ECS service lookup failed');
  const service = result.services[0];
  if (!TASK_DEFINITION.test(service.taskDefinition ?? '') || !Number.isInteger(service.desiredCount)
    || service.desiredCount < 1 || service.schedulingStrategy !== 'REPLICA') throw new Error('Unsupported ECS service baseline');
  return service;
}

export async function assertQueuesEmpty(io, stack) {
  for (const url of Object.values(stack.queues ?? {})) {
    const result = await io.aws(['sqs', 'get-queue-attributes', '--queue-url', url, '--attribute-names',
      'ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible', 'ApproximateNumberOfMessagesDelayed']);
    for (const key of ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible', 'ApproximateNumberOfMessagesDelayed']) {
      if (result.Attributes?.[key] !== '0') throw new Error('Non-paid runtime requires empty visible/inflight/delayed baseline queues');
    }
  }
  if (Object.keys(stack.queues ?? {}).length !== 4) throw new Error('Non-paid runtime requires all four queue baselines');
}

export function cloneFixtureDefinition(definition, { runScope, imageDigest, serviceCommit, mode }) {
  if (!['success', 'failure'].includes(mode) || !/^[1-9][0-9]*-[1-9][0-9]*-[a-f0-9]{16}$/.test(runScope)
    || !/^sha256:[a-f0-9]{64}$/.test(imageDigest) || !/^[a-f0-9]{40}$/.test(serviceCommit)
    || definition.networkMode !== 'awsvpc' || definition.containerDefinitions?.length !== 1) {
    throw new Error('Unsupported non-paid worker clone inputs');
  }
  const worker = structuredClone(definition.containerDefinitions[0]);
  if (!IMAGE.test(worker.image ?? '') || !definition.taskRoleArn || !definition.executionRoleArn
    || !worker.logConfiguration?.options?.['awslogs-group']) throw new Error('Worker image/roles/log configuration are not captured');
  const env = worker.environment ?? [];
  const secrets = worker.secrets ?? [];
  const providerSettings = [...env, ...secrets].filter(({ name }) => /DOUBAO|OPENAI|ANTHROPIC|VLM.*(?:KEY|URL)/i.test(name));
  if (providerSettings.some(({ name }) => !['DOUBAO_VLM_API_KEY', 'DOUBAO_VLM_BASE_URL', 'DOUBAO_VLM_MODEL'].includes(name))) {
    throw new Error('Unknown provider setting in worker task definition; fixture refused');
  }
  if (secrets.filter(({ name }) => name === 'DOUBAO_VLM_API_KEY').length !== 1
    || env.some(({ name }) => name === 'DOUBAO_VLM_API_KEY')) throw new Error('Expected one real provider key secret to replace');
  const sourceCommit = env.find(({ name }) => name === 'SERVICE_COMMIT_SHA')?.value;
  if (sourceCommit !== serviceCommit || env.find(({ name }) => name === 'IMAGE_DIGEST')?.value !== imageDigest) {
    throw new Error('Worker source SHA/image digest do not match the deployed Service pin');
  }
  if (env.some(({ name, value }) => name === 'VLM_DEFAULT_PROVIDER' && value !== 'doubao')) {
    throw new Error('Non-paid runtime only supports the Doubao VLM provider');
  }
  worker.image = `${worker.image.split(/[:@](?=[^/]*$)/)[0]}@${imageDigest}`;
  worker.secrets = secrets.filter(({ name }) => !['DOUBAO_VLM_API_KEY', 'DOUBAO_VLM_BASE_URL'].includes(name));
  worker.environment = env.filter(({ name }) => !['DOUBAO_VLM_API_KEY', 'DOUBAO_VLM_BASE_URL'].includes(name));
  worker.environment.push({ name: 'DOUBAO_VLM_API_KEY', value: FIXTURE_KEY },
    { name: 'DOUBAO_VLM_BASE_URL', value: `http://127.0.0.1:${FIXTURE_PORTS[mode]}/v1` });
  worker.dependsOn = [{ containerName: 'NonPaidProvider', condition: 'HEALTHY' }];
  const fixture = { name: 'NonPaidProvider', image: worker.image, essential: true,
    entryPoint: ['node'], command: ['--input-type=module', '--eval', fixtureProcessSource()],
    cpu: 0, memoryReservation: 64, readonlyRootFilesystem: true, user: worker.user,
    environment: [], secrets: [], logConfiguration: structuredClone(worker.logConfiguration),
    healthCheck: { command: ['CMD', 'node', '--input-type=module', '--eval',
      `const r=await Promise.all([18765,18766].map(p=>fetch('http://127.0.0.1:'+p+'/health')));if(r.some(v=>!v.ok))process.exit(1);`],
    interval: 5, timeout: 3, retries: 3, startPeriod: 5 } };
  if (fixture.user === undefined) delete fixture.user;
  const clone = pick(structuredClone(definition), DEFINITION_FIELDS);
  clone.family = `beta-anywear-nonpaid-${runScope}`;
  clone.containerDefinitions = [worker, fixture];
  return clone;
}

export async function verifyRevision(io, stack, serviceName, taskDefinition, baseline) {
  const service = await exactService(io, stack, serviceName);
  if (service.taskDefinition !== taskDefinition || !isDeepStrictEqual(pick(service, SERVICE_FIELDS), baseline)
    || service.runningCount !== service.desiredCount || service.pendingCount !== 0
    || service.deployments?.length !== 1 || service.deployments[0].taskDefinition !== taskDefinition
    || !['COMPLETED', undefined].includes(service.deployments[0].rolloutState)) {
    throw new Error('Service revision/configuration/stability verification failed');
  }
  const listed = await io.aws(['ecs', 'list-tasks', '--cluster', stack.cluster, '--service-name', serviceName, '--desired-status', 'RUNNING']);
  if (listed.taskArns?.length !== service.desiredCount) throw new Error('Actual running task set does not match desired count');
  const described = await io.aws(['ecs', 'describe-tasks', '--cluster', stack.cluster, '--tasks', ...listed.taskArns]);
  if (described.failures?.length || described.tasks?.length !== service.desiredCount
    || described.tasks.some((task) => task.taskDefinitionArn !== taskDefinition || task.lastStatus !== 'RUNNING')) {
    throw new Error('Actual running tasks are not on the exact service revision');
  }
  return described.tasks;
}

export async function prepareNonPaidRuntime({ scope, fixture }, io, environment, waitStable) {
  if (environment.RUNTIME_DRILL_EXCLUSIVE_WINDOW !== 'beta-exclusive-runtime'
    || fixture.source !== 'beta-provider-nonpaid-loopback' || fixture.delay_ms !== FIXTURE_DELAY_MS
    || fixture.failure_status !== 500 || fixture.forwards_requests !== false) {
    throw new Error('Non-paid runtime requires an approved exclusive window and exact reviewed fixture');
  }
  await captureRuntimeWindow(io, scope);
  await pauseRuntimeWindow(io, scope);
  await guardRuntimeWindow(io, scope, { requireEmpty: true });
  const autoscaling = await captureAutoscaling(io, scope.stack);
  await assertQueuesEmpty(io, scope.stack);
  const worker = await exactService(io, scope.stack, scope.stack.workerService);
  const api = await exactService(io, scope.stack, scope.stack.apiService);
  if (api.desiredCount < 2) throw new Error('Runtime fixture requires two existing API replicas; scaling is not authorized');
  const definitionResponse = await io.aws(['ecs', 'describe-task-definition', '--task-definition', worker.taskDefinition, '--include', 'TAGS']);
  const definition = definitionResponse.taskDefinition;
  if (definition?.taskDefinitionArn !== worker.taskDefinition) throw new Error('Worker definition baseline is not exact');
  const deployment = scope.deployment.service;
  const clone = cloneFixtureDefinition(definition, { runScope: scope.runScope,
    imageDigest: deployment.image_digest, serviceCommit: deployment.source_commit, mode: 'success' });
  const tasks = await verifyRevision(io, scope.stack, scope.stack.workerService, worker.taskDefinition, pick(worker, SERVICE_FIELDS));
  if (tasks.some((task) => !task.containers?.some((container) => container.name === definition.containerDefinitions[0].name
    && container.imageDigest === deployment.image_digest))) throw new Error('Baseline running worker digest is not the pinned Service digest');
  scope.runtimeControl = { run_scope: scope.runScope, baseline_worker_task_definition: worker.taskDefinition,
    baseline_api_task_definition: api.taskDefinition, baseline_worker_config: pick(worker, SERVICE_FIELDS),
    baseline_api_config: pick(api, SERVICE_FIELDS), baseline_definition_hash: hash(pick(definition, DEFINITION_FIELDS)),
    baseline_roles: { task: definition.taskRoleArn, execution: definition.executionRoleArn },
    baseline_image: definition.containerDefinitions[0].image, service_source_commit: deployment.source_commit,
    service_image_digest: deployment.image_digest, fixture_source_sha256: hash(fixtureProcessSource()),
    fixture_task_definitions: [], registration_intents: [], autoscaling,
    expected_worker_task_definition: worker.taskDefinition,
    restored: false, shared_worker_iam_and_network: true, nonpaid_provider_only: true, phase: 'baseline-captured' };
  if (io.saveRecovery) await io.saveRecovery(scope);
  scope.runtimeDefinitions = { success: clone,
    failure: cloneFixtureDefinition(definition, { runScope: scope.runScope,
      imageDigest: deployment.image_digest, serviceCommit: deployment.source_commit, mode: 'failure' }) };
  await switchNonPaidMode(scope, 'success', io, waitStable);
  await activateRuntimeWindow(io, scope);
}

export async function captureAutoscaling(io, stack) {
  const snapshots = [];
  for (const service of [stack.apiService, stack.workerService]) {
    const resource = `service/${stack.cluster}/${service}`;
    const base = ['--service-namespace', 'ecs', '--resource-id', resource, '--scalable-dimension', 'ecs:service:DesiredCount'];
    const targetResult = await io.aws(['application-autoscaling', 'describe-scalable-targets',
      '--service-namespace', 'ecs', '--resource-ids', resource, '--scalable-dimension', 'ecs:service:DesiredCount']);
    assertCompleteAutoscalingPage(targetResult, 'scalable targets');
    const target = targetResult.ScalableTargets?.[0];
    if (targetResult.NextToken || targetResult.ScalableTargets?.length !== 1 || target.ResourceId !== resource
      || !['DynamicScalingInSuspended', 'DynamicScalingOutSuspended', 'ScheduledScalingSuspended'].every((key) => target.SuspendedState?.[key] === true)) {
      throw new Error('Protected window owner must suspend all desired-count autoscaling axes before the runtime drill');
    }
    const policies = await io.aws(['application-autoscaling', 'describe-scaling-policies', ...base]);
    const schedules = await io.aws(['application-autoscaling', 'describe-scheduled-actions', ...base]);
    assertCompleteAutoscalingPage(policies, 'scaling policies');
    assertCompleteAutoscalingPage(schedules, 'scheduled actions');
    if (!Array.isArray(policies.ScalingPolicies) || !Array.isArray(schedules.ScheduledActions)) {
      throw new Error('Autoscaling response collections were incomplete');
    }
    snapshots.push(canonicalizeAutoscalingSnapshot({ resource_id: resource, target,
      policies: policies.ScalingPolicies, schedules: schedules.ScheduledActions }));
  }
  return snapshots;
}

export async function guardAutoscaling(io, scope) {
  if (!isDeepStrictEqual(await captureAutoscaling(io, scope.stack), scope.runtimeControl.autoscaling)) {
    throw new Error('Foreign autoscaling configuration drift; restoration refused');
  }
}

export async function switchNonPaidMode(scope, mode, io, waitStable) {
  const control = scope.runtimeControl;
  if (!control || !scope.runtimeDefinitions?.[mode]) throw new Error('Non-paid runtime is not prepared');
  await guardRuntimeWindow(io, scope, { requireEmpty: true });
  // The worker fixture switch is safe only when admission is explicitly closed. A
  // `testers` record admits until an explicit close, so there is no expiry that could
  // have closed it for us.
  if (effectiveAdmissionMode(scope.runtimeWindow.expected.admission_mode.value).mode !== 'closed') throw new Error('Worker fixture switch requires admission paused');
  await guardAutoscaling(io, scope);
  await verifyRevision(io, scope.stack, scope.stack.workerService, control.expected_worker_task_definition, control.baseline_worker_config);
  const intent = { mode, definition_hash: hash(scope.runtimeDefinitions[mode]), registered: false };
  control.registration_intents.push(intent);
  if (io.saveRecovery) await io.saveRecovery(scope);
  const registered = await io.aws(['ecs', 'register-task-definition', '--cli-input-json', JSON.stringify(scope.runtimeDefinitions[mode]),
    '--tags', `key=anywear-runtime-run-scope,value=${scope.runScope}`]);
  const arn = registered.taskDefinition?.taskDefinitionArn;
  if (!TASK_DEFINITION.test(arn ?? '') || !arn.includes(`/beta-anywear-nonpaid-${scope.runScope}:`)) {
    throw new Error('Registered fixture task definition is not run-owned');
  }
  control.fixture_task_definitions.push(arn);
  intent.task_definition_arn = arn;
  intent.registered = true;
  control.pending_worker_task_definition = arn;
  control.phase = `switching-${mode}`;
  if (io.saveRecovery) await io.saveRecovery(scope);
  await io.aws(['ecs', 'update-service', '--cluster', scope.stack.cluster, '--service', scope.stack.workerService, '--task-definition', arn]);
  control.expected_worker_task_definition = arn;
  delete control.pending_worker_task_definition;
  if (io.saveRecovery) await io.saveRecovery(scope);
  await waitStable(io, scope.stack, scope.stack.workerService);
  await verifyRevision(io, scope.stack, scope.stack.workerService, arn, control.baseline_worker_config);
  control.phase = mode;
  if (io.saveRecovery) await io.saveRecovery(scope);
}

export async function restoreNonPaidRuntime({ scope }, io, waitStable) {
  const control = scope.runtimeControl;
  if (!control) return;
  if (!scope.ownedCleanupCompleted) throw new Error('Restoration withheld until run-owned task/queue cleanup succeeds; recovery record retained');
  await guardRuntimeWindow(io, scope, { requireEmpty: true });
  await guardAutoscaling(io, scope);
  await recoverFixtureRegistrations(io, scope);
  await assertQueuesEmpty(io, scope.stack);
  const worker = await exactService(io, scope.stack, scope.stack.workerService);
  const allowed = [control.expected_worker_task_definition, control.pending_worker_task_definition,
    control.baseline_worker_task_definition].filter(Boolean);
  const api = await exactService(io, scope.stack, scope.stack.apiService);
  if (!allowed.includes(worker.taskDefinition) || !isDeepStrictEqual(pick(worker, SERVICE_FIELDS), control.baseline_worker_config)
    || api.taskDefinition !== control.baseline_api_task_definition
    || !isDeepStrictEqual(pick(api, SERVICE_FIELDS), control.baseline_api_config)) {
    throw new Error('Foreign service drift detected; baseline restoration refused');
  }
  control.phase = 'restoring';
  if (io.saveRecovery) await io.saveRecovery(scope);
  if (worker.taskDefinition !== control.baseline_worker_task_definition) {
    await io.aws(['ecs', 'update-service', '--cluster', scope.stack.cluster, '--service', scope.stack.workerService,
      '--task-definition', control.baseline_worker_task_definition]);
  }
  await waitStable(io, scope.stack, scope.stack.workerService);
  await waitStable(io, scope.stack, scope.stack.apiService);
  await verifyRevision(io, scope.stack, scope.stack.workerService, control.baseline_worker_task_definition, control.baseline_worker_config);
  await verifyRevision(io, scope.stack, scope.stack.apiService, control.baseline_api_task_definition, control.baseline_api_config);
  await assertFixtureTasksStopped(io, scope);
  for (const arn of control.fixture_task_definitions) {
    await io.aws(['ecs', 'deregister-task-definition', '--task-definition', arn]);
    const response = await io.aws(['ecs', 'describe-task-definition', '--task-definition', arn, '--include', 'TAGS']);
    if (response.taskDefinition?.taskDefinitionArn !== arn || response.taskDefinition.status !== 'INACTIVE') throw new Error('Fixture deregistration not confirmed INACTIVE');
  }
  control.restored = true;
  control.phase = 'restored';
  if (io.saveRecovery) await io.saveRecovery(scope);
}

export async function recoverFixtureRegistrations(io, scope) {
  const control = scope.runtimeControl;
  const baselineResponse = await io.aws(['ecs', 'describe-task-definition', '--task-definition', control.baseline_worker_task_definition, '--include', 'TAGS']);
  const baseline = baselineResponse.taskDefinition;
  if (baseline?.taskDefinitionArn !== control.baseline_worker_task_definition
    || hash(pick(baseline, DEFINITION_FIELDS)) !== control.baseline_definition_hash) throw new Error('Immutable baseline task definition changed');
  const listed = await io.aws(['ecs', 'list-task-definitions', '--family-prefix', `beta-anywear-nonpaid-${scope.runScope}`, '--status', 'ACTIVE']);
  if (listed.nextToken || !Array.isArray(listed.taskDefinitionArns) || listed.taskDefinitionArns.length > 20) throw new Error('Fixture orphan definition search is incomplete or exceeds budget');
  const tasks = await listFixtureTasks(io, scope);
  for (const arn of new Set([...listed.taskDefinitionArns, ...control.fixture_task_definitions, ...tasks.map((task) => task.taskDefinitionArn)])) {
    if (!new RegExp(`^arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-nonpaid-${scope.runScope}:[1-9][0-9]*$`).test(arn)) throw new Error('Captured fixture definition is outside owned family');
    const response = await io.aws(['ecs', 'describe-task-definition', '--task-definition', arn, '--include', 'TAGS']);
    const definition = response.taskDefinition;
    const tags = Array.isArray(response.tags) ? response.tags : await listTaskDefinitionTags(io, arn);
    if (Object.fromEntries(tags.map(({ key, value }) => [key, value]))['anywear-runtime-run-scope'] !== scope.runScope) {
      throw new Error('Fixture family contains a foreign definition; recovery refused');
    }
    const matches = control.registration_intents.filter((intent) => {
      const expected = cloneFixtureDefinition(baseline, { runScope: scope.runScope, imageDigest: control.service_image_digest,
        serviceCommit: control.service_source_commit, mode: intent.mode });
      if (intent.definition_hash !== hash(expected)) return false;
      try { return isDeepStrictEqual(normalizeFixtureDefinition(definition), normalizeFixtureDefinition(expected)); }
      catch { return false; }
    });
    if (!matches.length) throw new Error('Tagged fixture definition does not match a saved reviewed registration intent');
    if (!control.fixture_task_definitions.includes(arn)) control.fixture_task_definitions.push(arn);
  }
  for (const intent of control.registration_intents) {
    if (!intent.registered && !control.fixture_task_definitions.length) intent.proven_no_active_definition = true;
  }
  if (io.saveRecovery) await io.saveRecovery(scope);
}

async function listTaskDefinitionTags(io, taskDefinitionArn) {
  const response = await io.aws(['ecs', 'list-tags-for-resource', '--resource-arn', taskDefinitionArn]);
  if (!Array.isArray(response.tags)) throw new Error('Fixture definition tag lookup is incomplete');
  return response.tags;
}

async function listFixtureTasks(io, scope) {
  const family = `beta-anywear-nonpaid-${scope.runScope}`;
  const tasks = new Map();
  for (const status of ['RUNNING', 'STOPPED']) {
    const listed = await io.aws(['ecs', 'list-tasks', '--cluster', scope.stack.cluster, '--family', family, '--desired-status', status]);
    if (listed.nextToken || !Array.isArray(listed.taskArns) || listed.taskArns.length > 100
      || new Set(listed.taskArns).size !== listed.taskArns.length
      || listed.taskArns.some((arn) => !/^arn:aws:ecs:ap-east-1:650880818323:task\/beta-anywear\/[a-f0-9]{32}$/.test(arn))) {
      throw new Error('Fixture task drain scan incomplete');
    }
    if (!listed.taskArns.length) continue;
    const described = await io.aws(['ecs', 'describe-tasks', '--cluster', scope.stack.cluster, '--tasks', ...listed.taskArns]);
    if (described.failures?.length || !Array.isArray(described.tasks) || described.tasks.length !== listed.taskArns.length
      || new Set(described.tasks.map((task) => task.taskArn)).size !== listed.taskArns.length
      || described.tasks.some((task) => !listed.taskArns.includes(task.taskArn)
        || !new RegExp(`^arn:aws:ecs:ap-east-1:650880818323:task-definition/${family}:[1-9][0-9]*$`).test(task.taskDefinitionArn ?? ''))) {
      throw new Error('Fixture task drain scan had unresolved or foreign tasks');
    }
    for (const task of described.tasks) tasks.set(task.taskArn, task);
  }
  return [...tasks.values()];
}

async function assertFixtureTasksStopped(io, scope) {
  const owned = new Set(scope.runtimeControl.fixture_task_definitions);
  for (let attempt = 0; attempt < 7; attempt++) {
    const tasks = await listFixtureTasks(io, scope);
    if (tasks.some((task) => !owned.has(task.taskDefinitionArn))) throw new Error('Fixture drain found an uncaptured definition');
    if (tasks.every((task) => task.lastStatus === 'STOPPED')) return;
    if (attempt < 6) await io.sleep(5_000);
  }
  throw new Error('Owned non-paid fixture tasks are not fully STOPPED; deregistration withheld');
}
