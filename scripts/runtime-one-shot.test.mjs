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
