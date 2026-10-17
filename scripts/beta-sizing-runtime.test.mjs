import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { sizingRuntimeSnapshot } from './beta-sizing-runtime.mjs';

test('Beta qualification checks the selected sizing tuple before starting Playwright', () => {
  const workflow = readFileSync(new URL('../.github/workflows/beta-qualification.yml', import.meta.url), 'utf8');
  const preflight = workflow.indexOf('      - name: Validate the selected sizing stage before the suite');
  const suite = workflow.indexOf('      - name: Run complete deployed Beta suite');
  assert.notEqual(preflight, -1);
  assert.notEqual(suite, -1);
  assert.ok(preflight < suite);
  assert.match(workflow.slice(preflight, suite), /if: \$\{\{ inputs\.sizing_stage != 'disabled' \}\}/);
  assert.match(workflow.slice(preflight, suite), /run: node scripts\/beta-sizing-runtime\.mjs/);
  // The qualification itself no longer collects the measurement, so the stage check here
  // is only a preflight; the workload runs it again inside its own job.
  assert.doesNotMatch(workflow.slice(preflight, suite), /pnpm test:instrumentation/);
});

function fixture(stageId = 'S1') {
  const sizing = {
    S1: { api: { desired: 1, minimum: 1, cpu: 512, memory: 1024 }, worker: { desired: 1, minimum: 1, cpu: 1024, memory: 2048 } },
    S2: { api: { desired: 1, minimum: 1, cpu: 256, memory: 512 }, worker: { desired: 1, minimum: 1, cpu: 1024, memory: 2048 } },
    S3: { api: { desired: 1, minimum: 1, cpu: 256, memory: 512 }, worker: { desired: 1, minimum: 1, cpu: 512, memory: 1024 } },
  }[stageId];
  const services = ['api', 'worker'].map(role => ({
    serviceName: `beta-anywear-${role}`, taskDefinition: `definition-${role}`,
    desiredCount: sizing[role].desired, runningCount: sizing[role].desired, pendingCount: 0,
    deployments: [{ rolloutState: 'COMPLETED' }],
  }));
  const definitions = ['api', 'worker'].map(role => ({
    taskDefinitionArn: `definition-${role}`, cpu: String(sizing[role].cpu), memory: String(sizing[role].memory),
    containerDefinitions: [{ name: `${role === 'api' ? 'Api' : 'Worker'}Container`,
      environment: [{ name: 'BETA_SIZING_TELEMETRY', value: 'true' }] }],
  }));
  const tasks = ['api', 'worker'].map(role => ({ taskArn: `task-${role}`,
    taskDefinitionArn: `definition-${role}`, lastStatus: 'RUNNING' }));
  const scalingTargets = ['api', 'worker'].map(role => ({
    ResourceId: `service/beta-anywear/beta-anywear-${role}`, MinCapacity: sizing[role].minimum,
  }));
  const calls = [];
  const aws = args => {
    calls.push(args);
    const command = args.slice(0, 2).join(' ');
    const value = option => args[args.indexOf(option) + 1];
    switch (command) {
      case 'sts get-caller-identity': return { Account: '650880818323' };
      case 'ecs describe-services': return { services, failures: [] };
      case 'ecs list-tasks': return { taskArns: tasks.filter(task => task.taskDefinitionArn === `definition-${value('--service-name').split('-').at(-1)}`).map(task => task.taskArn) };
      case 'ecs describe-tasks': return { tasks: tasks.filter(task => task.taskArn === value('--tasks')), failures: [] };
      case 'ecs describe-task-definition': return { taskDefinition: definitions.find(item => item.taskDefinitionArn === value('--task-definition')) };
      case 'application-autoscaling describe-scalable-targets': return { ScalableTargets: scalingTargets };
      default: throw new Error(`Unexpected AWS read: ${command}`);
    }
  };
  return { aws, calls, services, definitions, tasks, scalingTargets };
}

test('sizing preflight requires the selected stage CPU, memory, desired count, and autoscaling minimum', () => {
  for (const stage of ['S1', 'S2', 'S3']) {
    const input = fixture(stage);
    const snapshot = sizingRuntimeSnapshot(input.aws, stage);
    assert.equal(snapshot.stage, stage);
    assert.equal(snapshot.scaling_targets.ScalableTargets.length, 2);
    assert.ok(input.calls.every(args => !['update-service', 'register-task-definition', 'put-scaling-policy'].includes(args[1])));
  }
});

test('sizing preflight refuses stage drift before any workload can start', () => {
  const cases = [
    input => { input.services[0].desiredCount++; },
    input => { input.services[0].runningCount++; },
    input => { input.definitions[0].cpu = '512'; }, // S2 API candidate requires 256 CPU units.
    input => { input.definitions[0].memory = '1024'; },
    input => { input.scalingTargets[0].MinCapacity = 2; },
    input => { input.scalingTargets.splice(0, 1); },
    input => { input.scalingTargets.push({ ...input.scalingTargets[0] }); },
    input => { input.tasks[0].taskDefinitionArn = 'stale-definition'; },
  ];
  for (const mutate of cases) {
    const input = fixture('S2'); mutate(input);
    assert.throws(() => sizingRuntimeSnapshot(input.aws, 'S2'));
  }
  assert.throws(() => sizingRuntimeSnapshot(fixture().aws, 'S0'), /explicit sizing stage/);
});

test('sizing preflight requires telemetry enabled in both API and Worker task definitions', () => {
  const mutations = [
    definition => { definition.containerDefinitions[0].environment = []; },
    definition => { definition.containerDefinitions[0].environment[0].value = 'false'; },
    definition => { definition.containerDefinitions[0].environment.push({ name: 'BETA_SIZING_TELEMETRY', value: 'true' }); },
    definition => { delete definition.containerDefinitions; },
  ];
  for (const roleIndex of [0, 1]) {
    for (const mutate of mutations) {
      const input = fixture('S2'); mutate(input.definitions[roleIndex]);
      assert.throws(() => sizingRuntimeSnapshot(input.aws, 'S2'), /BETA_SIZING_TELEMETRY=true|telemetry environment is unavailable/);
    }
  }
});
