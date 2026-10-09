import assert from 'node:assert/strict';
import test from 'node:test';
import { createSizingPlan, evaluateSizingResult, SIZING_STAGES, validateSizingPlan } from './beta-sizing-benchmark.mjs';

const baseline = {
  api_peak_mib: 100,
  worker_peak_mib: 300,
  provider_p95_ms: 500,
  queue_p95_ms: 400,
  cpu_sample_max_percent: 50,
  route_p95_ms: { '/users/me': 100, '/wardrobe': 120, '/vto/base-photos': 130, '/vto/generations': 150 },
};

function result(stage, overrides = {}) {
  return {
    stage,
    unexpected_oom: 0,
    task_replacements: 0,
    lost_accepted_work: 0,
    readiness_failures: 0,
    duplicate_effects: 0,
    manual_intervention: 0,
    api_peak_mib: 100,
    worker_peak_mib: 300,
    provider_p95_ms: 500,
    queue_p95_ms: 400,
    cpu_sample_max_percent: 50,
    route_p95_ms: { ...baseline.route_p95_ms },
    ...overrides,
  };
}

test('fixes the reviewed S0 -> S3 order and workload contract', () => {
  const plan = createSizingPlan({ fixtureManifestSha256: 'a'.repeat(64), compatibilitySha: 'b'.repeat(40) });
  assert.deepEqual(plan.stages.map(({ id }) => id), ['S0', 'S1', 'S2', 'S3']);
  assert.equal(plan.stages[0].api.desired, 2);
  assert.equal(plan.stages[1].api.desired, 1);
  assert.equal(plan.stages[2].api.memoryMiB, 512);
  assert.equal(plan.stages[3].worker.memoryMiB, 1024);
  assert.equal(validateSizingPlan(plan), true);
});

test('rejects plans that alter production-like settings or omit a representative route', () => {
  const plan = createSizingPlan({ fixtureManifestSha256: 'a'.repeat(64), compatibilitySha: 'b'.repeat(40) });
  plan.stages[0].api.desired = 1;
  assert.throws(() => validateSizingPlan(plan), /S0 api.desired differs/);

  const fresh = createSizingPlan({ fixtureManifestSha256: 'a'.repeat(64), compatibilitySha: 'b'.repeat(40) });
  fresh.workload.paced_routes.pop();
  assert.throws(() => validateSizingPlan(fresh), /representative set/);
});

test('requires complete evidence and classifies incomplete peaks as unqualified', () => {
  assert.deepEqual(evaluateSizingResult(result('S1', { api_peak_mib: undefined }), baseline), {
    status: 'unqualified', reason: 'Container peak evidence is incomplete', stage: 'S1',
  });
  assert.throws(() => evaluateSizingResult(result('S1', { route_p95_ms: { '/users/me': 100 } }), baseline), /each reviewed route/);
});

test('rejects stability and candidate headroom failures', () => {
  assert.equal(evaluateSizingResult(result('S1', { unexpected_oom: 1 }), baseline).status, 'rejected');
  assert.equal(evaluateSizingResult(result('S2', { api_peak_mib: 385 }), baseline).status, 'rejected');
  assert.equal(evaluateSizingResult(result('S3', { worker_peak_mib: 769 }), baseline).status, 'rejected');
  assert.equal(evaluateSizingResult(result('S3', { route_p95_ms: { ...baseline.route_p95_ms, '/vto/generations': 300 } }), baseline).status, 'rejected');
});

test('accepts a complete S0 baseline and a bounded S1 replica reduction', () => {
  assert.equal(evaluateSizingResult(result('S0'), baseline).status, 'passed');
  assert.equal(evaluateSizingResult(result('S1'), baseline).status, 'passed');
  assert.equal(SIZING_STAGES[1].api.minimum, 1);
});
