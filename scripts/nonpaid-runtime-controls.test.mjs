import assert from 'node:assert/strict';
import test from 'node:test';
import { cloneFixtureDefinition, prepareNonPaidRuntime, restoreNonPaidRuntime } from './nonpaid-runtime-controls.mjs';
import { testerHash } from './runtime-window-controls.mjs';

const sha = 'b'.repeat(40);
const digest = `sha256:${'c'.repeat(64)}`;
const runScope = '123-1-aaaaaaaaaaaaaaaa';
const definitionArn = 'arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-worker:1';
const apiDefinitionArn = 'arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-api:1';
const definition = {
  taskDefinitionArn: definitionArn, family: 'beta-anywear-worker', revision: 1, status: 'ACTIVE',
  taskRoleArn: 'arn:aws:iam::650880818323:role/beta-anywear-worker-role',
  executionRoleArn: 'arn:aws:iam::650880818323:role/beta-anywear-worker-execution-role',
  networkMode: 'awsvpc', cpu: '512', memory: '1024', requiresCompatibilities: ['FARGATE'],
  containerDefinitions: [{ name: 'WorkerContainer', image: `650880818323.dkr.ecr.ap-east-1.amazonaws.com/anywear-service@${digest}`,
    command: ['node', 'dist/worker.js'], environment: [{ name: 'SERVICE_COMMIT_SHA', value: sha },
      { name: 'IMAGE_DIGEST', value: digest }, { name: 'DATABASE_URL', value: 'sensitive-baseline-value' }],
    secrets: [{ name: 'DOUBAO_VLM_API_KEY', valueFrom: 'arn:aws:ssm:ap-east-1:650880818323:parameter/anywear/beta/DOUBAO_VLM_API_KEY' },
      { name: 'DB_PASSWORD', valueFrom: 'baseline-db-secret-reference' }],
    logConfiguration: { logDriver: 'awslogs', options: { 'awslogs-group': '/anywear/beta/worker',
      'awslogs-region': 'ap-east-1', 'awslogs-stream-prefix': 'worker' } } }],
};

function clone(mode = 'success', source = definition) {
  return cloneFixtureDefinition(source, { runScope, imageDigest: digest, serviceCommit: sha, mode });
}

test('clone preserves immutable worker roles/image/config and replaces the real provider key with a sentinel', () => {
  const result = clone();
  assert.equal(result.family, `beta-anywear-nonpaid-${runScope}`);
  assert.equal(result.taskRoleArn, definition.taskRoleArn);
  assert.equal(result.executionRoleArn, definition.executionRoleArn);
  assert.ok(!('taskDefinitionArn' in result));
  const [worker, sidecar] = result.containerDefinitions;
  assert.equal(worker.image, definition.containerDefinitions[0].image);
  assert.ok(!worker.secrets.some(({ name }) => name === 'DOUBAO_VLM_API_KEY'));
  assert.deepEqual(worker.environment.find(({ name }) => name === 'DOUBAO_VLM_BASE_URL'),
    { name: 'DOUBAO_VLM_BASE_URL', value: 'http://127.0.0.1:18765/v1' });
  assert.equal(worker.environment.find(({ name }) => name === 'DOUBAO_VLM_API_KEY').value, 'anywear-nonpaid-loopback-only');
  assert.deepEqual(sidecar.secrets, []);
  assert.deepEqual(sidecar.environment, []);
  assert.deepEqual(sidecar.entryPoint, ['node']);
  assert.doesNotMatch(sidecar.command.join(' '), /sensitive-baseline-value|DB_PASSWORD|DATABASE_URL|process\.env/);
  assert.equal(clone('failure').containerDefinitions[0].environment.find(({ name }) => name === 'DOUBAO_VLM_BASE_URL').value,
    'http://127.0.0.1:18766/v1');
  assert.equal(definition.containerDefinitions[0].secrets[0].name, 'DOUBAO_VLM_API_KEY');
});

test('clone refuses unknown provider settings, incorrect pin/key, and non-shared-awsvpc network', () => {
  for (const mutate of [
    (value) => { value.containerDefinitions[0].environment.push({ name: 'OPENAI_API_KEY', value: 'unknown' }); },
    (value) => { value.containerDefinitions[0].secrets.shift(); },
    (value) => { value.containerDefinitions[0].environment[0].value = 'd'.repeat(40); },
    (value) => { value.containerDefinitions[0].environment[1].value = `sha256:${'d'.repeat(64)}`; },
    (value) => { value.networkMode = 'bridge'; },
  ]) {
    const source = structuredClone(definition);
    mutate(source);
    assert.throws(() => clone('success', source), /Unknown|Expected|pin|Unsupported/);
  }
});

function controlHarness({ dirtyQueue = false, foreignDrift = false, failStability = false } = {}) {
  const calls = [];
  const records = [];
  const definitions = new Map();
  const policy = { intake_open: { value: 'false', version: 1 }, admission_suspended: { value: 'true', version: 1 },
    tester_allowlist: { value: '[]', version: 1 } };
  let workerDefinition = definitionArn;
  let drift = false;
  const service = (name) => ({ serviceArn: `arn:aws:ecs:ap-east-1:650880818323:service/beta-anywear/${name}`,
    clusterArn: 'arn:aws:ecs:ap-east-1:650880818323:cluster/beta-anywear', serviceName: name,
    desiredCount: name === 'api' ? 2 : (drift && foreignDrift ? 2 : 1), runningCount: name === 'api' ? 2 : 1,
    pendingCount: 0, schedulingStrategy: 'REPLICA', taskDefinition: name === 'api' ? apiDefinitionArn : workerDefinition,
    networkConfiguration: { awsvpcConfiguration: { subnets: ['subnet-1'], securityGroups: ['sg-1'], assignPublicIp: 'DISABLED' } },
    deployments: [{ taskDefinition: name === 'api' ? apiDefinitionArn : workerDefinition, rolloutState: 'COMPLETED' }] });
  const io = {
    async saveRecovery(scope) { if (scope.runtimeControl) records.push(JSON.parse(JSON.stringify(scope.runtimeControl))); },
    async auditRuntimeWindow({ scope, request }) { return { schema_version: 1, source: 'durable-runtime-window-audit', binding: request,
      observed_at: '2026-10-05T01:00:00Z', current_rows: { active_tasks: 0, unpublished_outbox: 0, manual_intervention_outbox: 0 },
      policy: { intake_open: false, admission_suspended: policy.admission_suspended.value === 'true',
        tester_count: JSON.parse(policy.tester_allowlist.value).length, tester_allowlist_hash: testerHash(JSON.parse(policy.tester_allowlist.value)),
        updated_at: '2026-10-05T01:00:00Z' }, scope };
    },
    async runLifecycle({ action, payload }) {
      if (action === 'configure-testers') {
        policy.tester_allowlist.value = payload;
        policy.tester_allowlist.version += 1;
        policy.admission_suspended.value = 'false';
        policy.admission_suspended.version += 2;
      } else { policy.admission_suspended.value = 'true'; policy.admission_suspended.version += 1; }
    },
    async aws(args) {
      calls.push(args);
      if (args[0] === 'ssm') { const name = args.at(-1).split('/').at(-1); return { Parameter: { Value: policy[name].value, Version: policy[name].version } }; }
      if (args[0] === 'application-autoscaling') {
        const resource = args[args.indexOf(args.includes('--resource-ids') ? '--resource-ids' : '--resource-id') + 1];
        if (args[1] === 'describe-scalable-targets') return { ScalableTargets: [{ ResourceId: resource,
          MinCapacity: 1, MaxCapacity: 4, SuspendedState: { DynamicScalingInSuspended: true, DynamicScalingOutSuspended: true, ScheduledScalingSuspended: true } }] };
        return { ScalingPolicies: [], ScheduledActions: [] };
      }
      if (args[1] === 'get-queue-attributes') return { Attributes: { ApproximateNumberOfMessages: dirtyQueue ? '1' : '0',
        ApproximateNumberOfMessagesNotVisible: '0', ApproximateNumberOfMessagesDelayed: '0' } };
      if (args[1] === 'describe-services') return { services: [service(args[args.indexOf('--services') + 1])] };
      if (args[1] === 'describe-task-definition') {
        const arn = args[args.indexOf('--task-definition') + 1];
        return { taskDefinition: definitions.get(arn) ?? definition,
          tags: [{ key: 'anywear-runtime-run-scope', value: runScope }] };
      }
      if (args[1] === 'list-task-definitions') return { taskDefinitionArns: [...definitions.keys()] };
      if (args[1] === 'list-tasks') return { taskArns: args.includes('api') ? ['api-1', 'api-2'] : ['worker-1'] };
      if (args[1] === 'describe-tasks') return { tasks: args.slice(args.indexOf('--tasks') + 1).map((id) => ({
        taskArn: id, taskDefinitionArn: id.startsWith('api') ? apiDefinitionArn : workerDefinition,
        lastStatus: 'RUNNING', containers: [{ name: 'WorkerContainer', imageDigest: digest }] })) };
      if (args[1] === 'register-task-definition') {
        const arn = `arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-nonpaid-${runScope}:1`;
        const registered = { ...JSON.parse(args[args.indexOf('--cli-input-json') + 1]), taskDefinitionArn: arn };
        definitions.set(arn, registered);
        return { taskDefinition: registered };
      }
      if (args[1] === 'update-service') { workerDefinition = args[args.indexOf('--task-definition') + 1]; }
      return {};
    },
  };
  const scope = { runScope, email: `e2e-beta-${runScope}-0-01234567@anywear.local`, stack: { cluster: 'beta-anywear', workerService: 'worker', apiService: 'api',
    queues: { vto: 'vto', autoTagging: 'auto', vtoDlq: 'vto-dlq', autoTaggingDlq: 'auto-dlq' } },
  deployment: { service: { source_commit: sha, image_digest: digest } } };
  const fixture = { source: 'beta-provider-nonpaid-loopback', delay_ms: 45000, failure_status: 500, forwards_requests: false };
  const environment = { RUNTIME_DRILL_EXCLUSIVE_WINDOW: 'beta-exclusive-runtime' };
  const wait = async () => { if (failStability && drift) throw new Error('baseline did not become stable'); };
  return { io, scope, fixture, environment, wait, calls, records,
    drift() { drift = true; }, setBaseline() { workerDefinition = definitionArn; } };
}

test('non-paid control snapshots baseline before mutation and restores exact revisions, without leaking environment values', async () => {
  const harness = controlHarness();
  const { scope, fixture, io, environment, wait, calls, records } = harness;
  await prepareNonPaidRuntime({ scope, fixture }, io, environment, wait);
  assert.equal(records[0].phase, 'baseline-captured');
  assert.equal(records[0].shared_worker_iam_and_network, true);
  assert.doesNotMatch(JSON.stringify(records), /sensitive-baseline-value|DATABASE_URL|DB_PASSWORD/);
  scope.ownedCleanupCompleted = true;
  await restoreNonPaidRuntime({ scope }, io, wait);
  assert.equal(scope.runtimeControl.restored, true);
  assert.equal(scope.runtimeControl.phase, 'restored');
  assert.ok(calls.some((args) => args[1] === 'deregister-task-definition'));
  assert.equal(calls.filter((args) => args[1] === 'update-service').at(-1).at(-1), definitionArn);
});

test('control requires empty baseline queues before any registration and manager window acknowledgement', async () => {
  const dirty = controlHarness({ dirtyQueue: true });
  await assert.rejects(prepareNonPaidRuntime({ scope: dirty.scope, fixture: dirty.fixture }, dirty.io, dirty.environment, dirty.wait), /empty/);
  assert.ok(!dirty.calls.some((args) => args[1] === 'register-task-definition'));
  const other = controlHarness();
  await assert.rejects(prepareNonPaidRuntime({ scope: other.scope, fixture: other.fixture }, other.io, {}, other.wait), /exclusive window/);
  assert.deepEqual(other.calls, []);
});

test('cleanup refusal and foreign drift both withhold all baseline restoration mutations', async () => {
  for (const foreignDrift of [false, true]) {
    const harness = controlHarness({ foreignDrift });
    const { scope, fixture, io, environment, wait, calls } = harness;
    await prepareNonPaidRuntime({ scope, fixture }, io, environment, wait);
    const before = calls.filter((args) => args[1] === 'update-service').length;
    if (foreignDrift) { scope.ownedCleanupCompleted = true; harness.drift(); }
    await assert.rejects(restoreNonPaidRuntime({ scope }, io, wait), foreignDrift ? /Foreign/ : /cleanup succeeds/);
    assert.equal(calls.filter((args) => args[1] === 'update-service').length, before);
    assert.equal(scope.runtimeControl.restored, false);
  }
});

test('restoration stability failure propagates and recovery can resume an already selected baseline', async () => {
  const harness = controlHarness({ failStability: true });
  const { scope, fixture, io, environment, wait } = harness;
  await prepareNonPaidRuntime({ scope, fixture }, io, environment, wait);
  scope.ownedCleanupCompleted = true;
  harness.drift();
  await assert.rejects(restoreNonPaidRuntime({ scope }, io, wait), /did not become stable/);
  assert.equal(scope.runtimeControl.restored, false);
  assert.equal(scope.runtimeControl.phase, 'restoring');
  harness.setBaseline();
  await restoreNonPaidRuntime({ scope }, io, async () => {});
  assert.equal(scope.runtimeControl.restored, true);
});
