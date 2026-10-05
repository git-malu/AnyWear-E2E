import assert from 'node:assert/strict';
import test from 'node:test';
import { runtimeCloudHarness } from './fixtures/runtime-cloud-harness.mjs';
import { parseRuntimeRecovery } from './runtime-recovery.mjs';

test('restoration waits for all owned family tasks, including tasks outside the service set, before deregistration', async () => {
  for (const boundary of ['running', 'delayed-stop', 'pagination', 'missing-task', 'inactive-running']) {
    const h = runtimeCloudHarness();
    await h.execute();
    const record = parseRuntimeRecovery(h.writes.at(-1).json);
    record.runtime_control.restored = false;
    const definitionArn = record.runtime_control.fixture_task_definitions[0];
    if (boundary !== 'inactive-running') h.definitions.get(definitionArn).taskDefinition.status = 'ACTIVE';
    const taskArn = 'arn:aws:ecs:ap-east-1:650880818323:task/beta-anywear/ffffffffffffffffffffffffffffffff';
    h.tasks.set(taskArn, { taskArn, taskDefinitionArn: definitionArn, lastStatus: 'RUNNING', containers: [] });
    const fresh = h.makeAdapter({ ...h.environment, GITHUB_RUN_ID: '456' });
    const aws = fresh.io.aws;
    let sleeps = 0;
    fresh.io.sleep = async (ms) => {
      assert.equal(ms, 5_000);
      sleeps++;
      if (boundary === 'delayed-stop') h.tasks.get(taskArn).lastStatus = 'STOPPED';
    };
    fresh.io.aws = async (args) => {
      if (boundary === 'pagination' && args[1] === 'list-tasks' && args.includes('--family')
        && args.some((arg) => arg.startsWith('beta-anywear-nonpaid-'))) return { taskArns: [], nextToken: 'more' };
      if (boundary === 'missing-task' && args[1] === 'describe-tasks' && args.includes(taskArn)) return { tasks: [] };
      return aws(args);
    };
    const before = h.mutations.length;
    const result = fresh.adapter.restoreNonPaidRuntime({ scope: { runScope: record.run_scope, stack: record.stack,
      runtimeControl: record.runtime_control, runtimeWindow: record.runtime_window, ownedCleanupCompleted: true,
      subject: record.users[0].sub, email: record.users[0].email, userPoolId: record.user_pool_id,
      deployment: record.deployment, config: { serviceUrl: record.service_url } } });
    if (boundary === 'delayed-stop') {
      await result;
      assert.equal(record.runtime_control.restored, true);
      assert.equal(sleeps, 1);
    } else {
      await assert.rejects(result, /scan|STOPPED/);
      assert.equal(record.runtime_control.restored, false);
      assert.ok(!h.mutations.slice(before).some(({ operation }) => operation === 'deregister-definition'));
      assert.equal(sleeps, ['running', 'inactive-running'].includes(boundary) ? 6 : 0);
    }
    assert.ok(!h.mutations.slice(before).some(({ operation }) => operation === 'stop-task'));
  }
});
