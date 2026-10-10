import assert from 'node:assert/strict';
import test from 'node:test';
import { collectSizingCloudEvidence } from './collect-beta-sizing-evidence.mjs';
import { sizingSourceFixture } from './fixtures/beta-sizing-source.mjs';

function fixture() {
  const now = Date.now();
  const image = `sha256:${'a'.repeat(64)}`;
  const sha = 'b'.repeat(40);
  const compatibility = sizingSourceFixture().compatibility;
  compatibility.client.sha = sha; compatibility.infra.sha = sha;
  const sourceProof = sizingSourceFixture({ compatibility });
  const workload = { schema_version: 1, issue: 95, result: 'passed', stage: 'S1', e2e_sha: sha, run_id: '1', run_attempt: '1',
    started_at: new Date(now - 360_000).toISOString(), finished_at: new Date(now - 60_000).toISOString(),
    fixture_manifest_sha256: 'a'.repeat(64), supported_input_envelope_sha256: 'a'.repeat(64),
    deployment: { service: { source_commit: sha, image_digest: image }, client: { source_commit: sha },
      compatibility }, source_proof: sourceProof, source_proof_after: structuredClone(sourceProof),
    workload: { uploads: [], vto: [], overlap_intent: [] }, route_samples_ms: {} };
  const definitions = ['api', 'worker'].map(role => ({ taskDefinitionArn: `definition-${role}`,
    cpu: role === 'api' ? '512' : '1024', memory: role === 'api' ? '1024' : '2048',
    containerDefinitions: [{ name: role, logConfiguration: { options: { 'awslogs-group': `/anywear/beta/${role}`, 'awslogs-stream-prefix': role } } }] }));
  const tasks = ['api', 'worker'].map(role => ({ taskArn: `arn:aws:ecs:ap-east-1:650880818323:task/beta-anywear/${role}`,
    taskDefinitionArn: `definition-${role}`, group: `service:beta-anywear-${role}`, lastStatus: 'RUNNING',
    containers: [{ imageDigest: image }] }));
  const services = ['api', 'worker'].map(role => ({ serviceName: `beta-anywear-${role}`, taskDefinition: `definition-${role}`,
    desiredCount: 1, runningCount: 1, pendingCount: 0, deployments: [{ rolloutState: 'COMPLETED' }] }));
  const before = { tasks, observed_at: new Date(now - 400_000).toISOString(),
    e2e_sha: sha, run_id: '1', run_attempt: '1', stage: 'S1', source_proof: structuredClone(sourceProof) };
  const calls = [];
  const aws = args => {
    calls.push(args);
    const key = args.slice(0, 2).join(' ');
    const read = name => args[args.indexOf(name) + 1];
    switch (key) {
      case 'sts get-caller-identity': return { Account: '650880818323', Arn: 'verified-test-principal' };
      case 'ecs describe-services': return { services, failures: [] };
      case 'ecs list-tasks': return { taskArns: args.includes('--desired-status') ? []
        : tasks.filter(task => task.group === `service:${read('--service-name')}`).map(task => task.taskArn) };
      case 'ecs describe-tasks': return { tasks: tasks.filter(task => task.taskArn === read('--tasks')), failures: [] };
      case 'ecs describe-task-definition': return { taskDefinition: definitions.find(item => item.taskDefinitionArn === read('--task-definition')) };
      case 'cloudwatch get-metric-statistics': return { Datapoints: [] };
      case 'logs filter-log-events': return { events: [] };
      case 'application-autoscaling describe-scalable-targets': return { ScalableTargets: services.map(service => ({ ResourceId: `service/beta-anywear/${service.serviceName}`, MinCapacity: 1 })) };
      default: throw new Error(`Unallocated AWS call: ${key}`);
    }
  };
  return { workload, before, aws, calls, tasks, services };
}

test('read-only collector retains missing CPU/peak/correctness evidence as gaps, not zero acceptance', () => {
  const input = fixture();
  const collected = collectSizingCloudEvidence(input);
  assert.equal(collected.measured.observed.api.memoryMiB, 1024);
  assert.equal(collected.measured.measurements.cpu_samples.length, 0);
  assert.equal(collected.measured.measurements.peak_window_covered, false);
  assert.equal(collected.measured.unexpected_oom, undefined);
  assert.equal(collected.measured.readiness_failures, undefined);
  assert.ok(collected.measured.evidence_gaps.length >= 2);
  assert.equal(collected.measured.source_proof.e2e_sha, input.workload.e2e_sha);
  assert.equal(collected.measured.binding.benchmark_source_sha256, input.workload.source_proof.benchmark_source_sha256);
  assert.ok(input.calls.every(args => /^(get-|describe-|list-|filter-)/.test(args[1])));
});

test('foreign run/source, stale retention window, stopped services and changed image fail closed', () => {
  for (const alter of [input => { input.before.run_id = '2'; }, input => { input.before.e2e_sha = 'c'.repeat(40); },
    input => { input.workload.source_proof.run_attempt = '2'; }, input => { delete input.before.source_proof; },
    input => { input.before.source_proof.tree_sha = 'd'.repeat(40); }, input => { delete input.workload.source_proof_after; },
    input => { input.workload.result = 'failed-or-incomplete'; },
    input => { input.workload.deployment.compatibility.deployment.artifact_id++; },
    input => { input.workload.started_at = new Date(Date.now() - 3_100_000).toISOString(); },
    input => { input.services[0].runningCount = 0; }, input => { input.tasks[0].containers[0].imageDigest = `sha256:${'c'.repeat(64)}`; }]) {
    const input = fixture(); alter(input);
    assert.throws(() => collectSizingCloudEvidence(input));
  }
});
