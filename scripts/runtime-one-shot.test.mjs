import assert from 'node:assert/strict';
import test from 'node:test';
import { oneShotHarness } from './fixtures/runtime-one-shot-harness.mjs';
import { cleanupOneShotDefinitions, recoverOneShotRegistrations, runOwnedOneShot, verifyOneShotTask } from './runtime-one-shot.mjs';
import { readOneShotLog, validateCleanupEvidence } from './runtime-one-shot-logs.mjs';
import { cleanupFixture } from './fixtures/runtime-evidence.mjs';

test('one-shot persists intent and metadata before execution, verifies actual task, and reads back INACTIVE', async () => {
  const h = oneShotHarness();
  const { operation } = await runOwnedOneShot(h.io, h.scope, 'task-audit', '', JSON.stringify(h.request), h.runner);
  assert.equal(h.snapshots[0].oneShots[0].task_arn, undefined);
  assert.equal(operation.proof.run_scope, h.scope.runScope);
  await cleanupOneShotDefinitions(h.io, h.scope);
  assert.equal(operation.deregistered, true);
  assert.equal(h.definitions.get(operation.task_definition_arn).taskDefinition.status, 'INACTIVE');
  h.definitions.get(operation.task_definition_arn).taskDefinition.status = 'ACTIVE';
  await assert.rejects(cleanupOneShotDefinitions(h.io, h.scope), /not confirmed/);
});

test('foreign family, run tag, command, secret, execution override, and exit cannot pass actual helper verification', async () => {
  for (const mutate of [
    (response) => { response.taskDefinition.family = 'beta-anywear-lifecycle'; },
    (response) => { response.tags[0].value = 'foreign'; },
    (response) => { response.taskDefinition.taskRoleArn = 'foreign-role'; },
    (response) => { response.taskDefinition.containerDefinitions[0].command[2] = '{}'; },
    (response) => { response.taskDefinition.containerDefinitions[0].secrets = [{ name: 'KEY', valueFrom: 'secret' }]; },
    (_response, task) => { task.overrides = { containerOverrides: [{ name: 'OneShot', command: ['bad'] }] }; },
    (_response, task) => { task.containers[0].exitCode = 1; },
  ]) {
    const h = oneShotHarness();
    const { operation } = await runOwnedOneShot(h.io, h.scope, 'task-audit', '', JSON.stringify(h.request), h.runner);
    mutate(h.definitions.get(operation.task_definition_arn), h.tasks.get(operation.task_arn));
    await assert.rejects(verifyOneShotTask(h.io, h.scope, operation));
  }
});

test('orphan registration recovers one exact tagged task, excludes other owned registrations, and rejects ambiguity/pagination', async () => {
  const h = oneShotHarness();
  await runOwnedOneShot(h.io, h.scope, 'task-audit', '', JSON.stringify(h.request), h.runner);
  const { operation } = await runOwnedOneShot(h.io, h.scope, 'task-audit', '', JSON.stringify(h.request), h.runner);
  const expected = operation.task_arn;
  delete operation.task_arn;
  delete operation.task_definition_arn;
  await recoverOneShotRegistrations(h.io, h.scope);
  assert.equal(operation.task_arn, expected);
  const owned = h.tasks.get(expected);
  h.tasks.set(`${expected.slice(0, -1)}f`, { ...owned, taskArn: `${expected.slice(0, -1)}f` });
  delete operation.task_arn;
  await assert.rejects(recoverOneShotRegistrations(h.io, h.scope), /ambiguous/);
  const original = h.io.aws;
  h.io.aws = async (args) => args[1] === 'list-task-definitions' ? { nextToken: 'more' } : original(args);
  await assert.rejects(recoverOneShotRegistrations(h.io, h.scope), /incomplete/);
});

test('duplicate/foreign metadata fails without losing owned registration intent', async () => {
  const h = oneShotHarness();
  await assert.rejects(runOwnedOneShot(h.io, h.scope, 'task-audit', '', JSON.stringify(h.request), async (args) => {
    const result = await h.runner(args);
    await args.onLine(result.stdout.split('\n')[0]);
  }), /Duplicate/);
  assert.equal(h.scope.oneShots.length, 1);
  assert.ok(h.scope.oneShots[0].task_definition_arn);
});

test('paginated one-shot logs retry eventual absence, refuse duplicates and incomplete paging', async () => {
  let calls = 0;
  const proof = { log_group: '/anywear/beta/one-shot', log_stream: 'exact' };
  const io = { async sleep() {}, async aws(args) {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error('not visible'), { name: 'ResourceNotFoundException' });
    if (calls === 2) return { events: [] };
    if (!args.includes('--next-token')) return { events: [], nextForwardToken: 'end' };
    return { events: [{ message: '{"source":"audit"}' }], nextForwardToken: 'end' };
  } };
  assert.equal((await readOneShotLog(io, proof, 'audit')).event.source, 'audit');
  assert.equal(calls, 4);
  await assert.rejects(readOneShotLog({ async aws() { return { events: [{ message: '{"source":"audit"}' }, { message: '{"source":"audit"}' }] }; } }, proof, 'audit'), /duplicate/);
  await assert.rejects(readOneShotLog({ async aws() { return { events: [], nextForwardToken: String(++calls) }; } }, proof, 'audit'), /pagination/);
});

test('irreversible DLQ deletion followed by rollback never qualifies as committed cleanup', () => {
  const h = oneShotHarness();
  h.scope.knownDLQMessageId = { taskId: h.request.taskId, messageId: h.request.itemId };
  const evidence = cleanupFixture(h.scope);
  evidence.committed.transaction_committed = false;
  assert.throws(() => validateCleanupEvidence(evidence, h.scope), /committed/);
  delete evidence.committed;
  assert.throws(() => validateCleanupEvidence(evidence, h.scope), /committed/);
});

test('actual Service-approved helper blueprint accepts all owned purposes and documented ECS defaults', async () => {
  for (const [purpose, action, payload] of [['task-audit', '', undefined], ['lifecycle', 'close', ''],
    ['lifecycle', 'open', ''], ['lifecycle', 'configure-testers', '[]'], ['tester-cleanup', '', undefined]]) {
    const h = oneShotHarness();
    const request = purpose === 'tester-cleanup' ? JSON.stringify({ runScope: h.scope.runScope, users: [{ sub: h.scope.subject, email: h.scope.email }] })
      : JSON.stringify({ runScope: h.scope.runScope, mode: 'window-preflight' });
    const { operation } = await runOwnedOneShot(h.io, h.scope, purpose, action, payload ?? request, h.runner);
    const definition = h.definitions.get(operation.task_definition_arn).taskDefinition;
    Object.assign(definition, { revision: 1, registeredBy: 'aws', registeredAt: new Date(), requiresAttributes: [],
      compatibilities: ['FARGATE', 'EC2'], volumes: [], placementConstraints: [], enableFaultInjection: false });
    Object.assign(definition.containerDefinitions[0], { cpu: 0, essential: true, privileged: false, readonlyRootFilesystem: false,
      mountPoints: [], volumesFrom: [], portMappings: [], systemControls: [], environmentFiles: [], secrets: [] });
    definition.containerDefinitions[0].environment.reverse();
    await verifyOneShotTask(h.io, h.scope, operation);
    definition.status = 'INACTIVE';
    definition.deregisteredAt = new Date();
    definition.deleteRequestedAt = new Date();
    await verifyOneShotTask(h.io, h.scope, operation);
  }
});

test('all one-shot behavioral fields and environment values are exact, including duplicate names', async () => {
  for (const mutate of [
    (d) => { d.cpu = '1024'; }, (d) => { d.memory = '2048'; },
    (d) => { d.runtimePlatform = { cpuArchitecture: 'ARM64' }; }, (d) => { d.volumes = [{ name: 'host-volume' }]; },
    (d) => { d.unknownFutureBehavior = true; },
    (d) => { d.containerDefinitions[0].environment.push({ name: 'STAGE', value: 'beta' }); },
    (d) => { d.containerDefinitions[0].environment.unshift({ name: 'STAGE', value: 'prod' }); },
    (d) => { d.containerDefinitions[0].environment.push({ name: 'DATABASE_URL', value: 'foreign' }); },
    (d) => { d.containerDefinitions[0].environment.find(({ name }) => name === 'DB_HOST').value = 'foreign'; },
    (d) => { d.containerDefinitions[0].environment.find(({ name }) => name === 'SQS_VTO_QUEUE_URL').value = 'foreign'; },
    (d) => { d.containerDefinitions[0].privileged = true; }, (d) => { d.containerDefinitions[0].readonlyRootFilesystem = true; },
    (d) => { d.containerDefinitions[0].environmentFiles = [{ value: 'foreign', type: 's3' }]; },
    (d) => { d.containerDefinitions[0].mountPoints = [{ sourceVolume: 'host-volume', containerPath: '/host' }]; },
    (d) => { d.containerDefinitions[0].linuxParameters = { capabilities: { add: ['SYS_ADMIN'] } }; },
    (d) => { d.containerDefinitions[0].healthCheck = { command: ['CMD', 'false'] }; },
    (d) => { d.containerDefinitions[0].dependsOn = [{ containerName: 'foreign', condition: 'START' }]; },
    (d) => { d.containerDefinitions[0].user = 'root'; }, (d) => { d.containerDefinitions[0].workingDirectory = '/foreign'; },
    (d) => { d.containerDefinitions[0].logConfiguration.options['awslogs-group'] = '/foreign'; },
    (d) => { d.containerDefinitions[0].unknownFutureBehavior = true; },
  ]) {
    const h = oneShotHarness();
    const { operation } = await runOwnedOneShot(h.io, h.scope, 'task-audit', '', JSON.stringify(h.request), h.runner);
    mutate(h.definitions.get(operation.task_definition_arn).taskDefinition);
    await assert.rejects(verifyOneShotTask(h.io, h.scope, operation));
  }
});

test('actual tasks accept only absent or inert name-only override readback, never resource or command overrides', async () => {
  for (const overrides of [undefined, {}, { containerOverrides: [] }, { containerOverrides: [{ name: 'OneShot' }] },
    { inferenceAcceleratorOverrides: [] }, { containerOverrides: [], inferenceAcceleratorOverrides: [] },
    { containerOverrides: [{ name: 'OneShot' }], inferenceAcceleratorOverrides: [] }]) {
    const h = oneShotHarness();
    const { operation } = await runOwnedOneShot(h.io, h.scope, 'task-audit', '', JSON.stringify(h.request), h.runner);
    h.tasks.get(operation.task_arn).overrides = overrides;
    await verifyOneShotTask(h.io, h.scope, operation);
  }
  for (const overrides of [
    { cpu: '4096' }, { memory: '8192' }, { taskRoleArn: 'foreign' }, { executionRoleArn: 'foreign' },
    { ephemeralStorage: { sizeInGiB: 200 } }, { unknownFutureBehavior: true },
    { containerOverrides: [{ name: 'foreign' }] }, { containerOverrides: [{ name: 'OneShot' }, { name: 'OneShot' }] },
    ...['cpu', 'memory', 'memoryReservation', 'resourceRequirements', 'environment', 'environmentFiles', 'command', 'unknownFutureBehavior']
      .map((key) => ({ containerOverrides: [{ name: 'OneShot', [key]: key === 'command' ? ['node'] : 'unexpected' }] })),
  ]) {
    const h = oneShotHarness();
    const { operation } = await runOwnedOneShot(h.io, h.scope, 'task-audit', '', JSON.stringify(h.request), h.runner);
    h.tasks.get(operation.task_arn).overrides = overrides;
    await assert.rejects(verifyOneShotTask(h.io, h.scope, operation), /verification failed/);
  }
});
