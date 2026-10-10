import assert from 'node:assert/strict';
import test from 'node:test';
import { createSizingPlan, evaluateSizingResult, SIZING_STAGES, SIZING_WORKLOAD, validateSizingPlan } from './beta-sizing-benchmark.mjs';

const hash = 'a'.repeat(64);
const sha = 'b'.repeat(40);
const started = '2026-10-10T00:00:00Z';
const finished = '2026-10-10T00:05:00Z';

function result(stage) {
  const sizing = SIZING_STAGES.find((item) => item.id === stage);
  const uploads = Array.from({ length: 24 }, (_, index) => ({
    task_id: `upload-${index}`, mime: SIZING_WORKLOAD.image_formats[index % 3],
    size_class: Math.floor(index / 3) % 2 ? 'near-supported-limit' : 'ordinary',
    fixture_sha256: hash, submission: index % 2 ? 'burst' : 'sequential',
    terminal_state: 'ready', replay_verified: true, reload_verified: true,
    worker_task_arn: 'arn:aws:ecs:ap-east-1:650880818323:task/cluster/worker',
    worker_process_instance: 'worker-process', started_monotonic_ms: 1000, finished_monotonic_ms: 2000,
    started_at: '2026-10-10T00:01:00Z', finished_at: '2026-10-10T00:02:00Z',
  }));
  const vto = Array.from({ length: 10 }, (_, index) => ({
    task_id: `vto-${index}`, shape: SIZING_WORKLOAD.vto_shapes[index % 5],
    terminal_state: 'Complete', output_retrievable: true, progress_reload_verified: true,
    replay_verified: true, credit_debit: 1, worker_task_arn: uploads[0].worker_task_arn,
    worker_process_instance: 'worker-process', started_monotonic_ms: 1500, finished_monotonic_ms: 3000,
    started_at: '2026-10-10T00:01:30Z', finished_at: '2026-10-10T00:03:00Z',
  }));
  const tasks = [{ task_arn: 'api', service: 'api' }, { task_arn: 'worker', service: 'worker' }];
  return {
    schema_version: 2, stage,
    unexpected_oom: 0, task_replacements: 0, lost_accepted_work: 0,
    readiness_failures: 0, duplicate_effects: 0, manual_intervention: 0,
    unexpected_dlq: 0, missed_lease_renewals: 0, notification_failures: 0, unexplained_backlog: 0,
    binding: {
      fixture_manifest_sha256: hash, supported_input_envelope_sha256: hash,
      provider_configuration_sha256: hash, deployment_record_sha256: hash,
      client_sha: sha, service_sha: sha, infra_sha: sha, e2e_sha: sha,
      image_digest: `sha256:${hash}`,
    },
    raw_evidence: [{ url: 'https://github.com/git-malu/AnyWear-E2E/actions/runs/1/artifacts/2', sha256: hash }],
    observed: { api: { ...sizing.api }, worker: { ...sizing.worker } },
    workload: { uploads, vto, overlap: [
      { upload_task_id: 'upload-0', vto_task_id: 'vto-0' },
      { upload_task_id: 'upload-1', vto_task_id: 'vto-1' },
    ] },
    measurements: {
      started_at: started, finished_at: finished, peak_method: 'container-cgroup-high-water', peak_window_covered: true,
      tasks, container_peaks: tasks.map((item) => ({ task_arn: item.task_arn,
        peak_mib: item.service === 'api' ? 100 : 300, limit_mib: sizing[item.service].memoryMiB })),
      cpu_samples: ['api', 'worker'].flatMap((service) => Array.from({ length: 5 }, (_, minute) => ({
        service, minute_utc: new Date(Date.parse(started) + minute * 60000).toISOString(), percent: 50,
      }))),
      route_samples_ms: Object.fromEntries(SIZING_WORKLOAD.paced_routes.map((route) => [route, Array(100).fill(100)])),
      task_timings: [...uploads, ...vto].map((item) => ({ task_id: item.task_id, provider_separated: true,
        local_processing_ms: 500, provider_ms: 1000, queue: { kind: 'exact-common-clock',
          task_correlation_verified: true, clock_bound_verified: true, clock_evidence_sha256: hash,
          commit_to_publish_ms: 400, publish_to_execution_ms: 400 } })),
    },
  };
}

test('binds the reviewed plan to full hashes and five supported VTO shapes', () => {
  const plan = createSizingPlan({ fixtureManifestSha256: hash, compatibilitySha: sha });
  assert.equal(validateSizingPlan(plan), true);
  assert.equal(plan.workload.vto_shapes.length, 5);
  assert.throws(() => createSizingPlan({ fixtureManifestSha256: 'partial', compatibilitySha: sha }), /full SHA-256/);
  plan.stages[0].api.desired = 1;
  assert.throws(() => validateSizingPlan(plan), /S0 api.desired differs/);
});

test('does not qualify legacy scalar summaries or incomplete business workload', () => {
  assert.equal(evaluateSizingResult({ ...result('S1'), schema_version: 1 }).status, 'unqualified');
  const incomplete = result('S1');
  incomplete.workload.vto.pop();
  assert.match(evaluateSizingResult(incomplete, result('S1')).reason, /VTO coverage/);
  const insufficient = result('S2');
  insufficient.measurements.route_samples_ms['/users/me'] = Array(99).fill(1);
  assert.match(evaluateSizingResult(insufficient, result('S1')).reason, /100 measured requests/);
});

test('requires actual sizing, common application inputs and a passing common S1', () => {
  const wrongSize = result('S2');
  wrongSize.observed.api.memoryMiB = 1024;
  assert.equal(evaluateSizingResult(wrongSize, result('S1')).status, 'unqualified');
  const changedImage = result('S2');
  changedImage.binding.image_digest = `sha256:${'c'.repeat(64)}`;
  assert.match(evaluateSizingResult(changedImage, result('S1')).reason, /image_digest changed/);
  assert.equal(evaluateSizingResult(result('S1')).status, 'passed');
  assert.equal(evaluateSizingResult(result('S2'), result('S1')).status, 'passed');
  assert.match(evaluateSizingResult(result('S2'), result('S0')).reason, /common S1 baseline/);
  const incompleteBaseline = result('S1');
  incompleteBaseline.workload.uploads.pop();
  assert.equal(evaluateSizingResult(result('S2'), incompleteBaseline).status, 'unqualified');
});

test('sampled memory, missing task peaks and missing CPU minutes remain unqualified', () => {
  const sampled = result('S2');
  sampled.measurements.peak_method = 'container-insights-one-minute';
  assert.equal(evaluateSizingResult(sampled, result('S1')).status, 'unqualified');
  const missing = result('S2');
  missing.measurements.container_peaks.pop();
  assert.equal(evaluateSizingResult(missing, result('S1')).status, 'unqualified');
  const cpuGap = result('S2');
  cpuGap.measurements.cpu_samples.pop();
  assert.equal(evaluateSizingResult(cpuGap, result('S1')).status, 'unqualified');
});

test('rejects sustained CPU saturation while accepting an isolated high sample', () => {
  const isolated = result('S2');
  isolated.measurements.cpu_samples[0].percent = 95;
  assert.equal(evaluateSizingResult(isolated, result('S1')).status, 'passed');
  const sustained = result('S2');
  sustained.measurements.cpu_samples.filter((item) => item.service === 'worker').forEach((item) => { item.percent = 90; });
  assert.match(evaluateSizingResult(sustained, result('S1')).reason, /five consecutive/);
});

test('compares provider-excluded local work and both queue intervals independently', () => {
  const providerVariation = result('S2');
  providerVariation.measurements.task_timings.forEach((item) => { item.provider_ms = 100000; });
  assert.equal(evaluateSizingResult(providerVariation, result('S1')).status, 'passed');
  const local = result('S2');
  local.measurements.task_timings.forEach((item) => { item.local_processing_ms = 751; });
  assert.match(evaluateSizingResult(local, result('S1')).reason, /local processing/);
  const queue = result('S2');
  queue.measurements.task_timings.forEach((item) => { item.queue.commit_to_publish_ms = 1401; });
  assert.match(evaluateSizingResult(queue, result('S1')).reason, /commit_to_publish/);
  const inseparable = result('S2');
  inseparable.measurements.task_timings[0].provider_separated = false;
  assert.equal(evaluateSizingResult(inseparable, result('S1')).status, 'unqualified');
});

test('uses candidate queue upper bounds against baseline lower bounds without inventing exact deltas', () => {
  function bounded(stage, milliseconds) {
    const value = result(stage);
    value.measurements.task_timings.forEach((item) => {
      item.queue = { kind: 'conservative-phase-bounds', task_correlation_verified: true,
        clock_bound_verified: true, clock_evidence_sha256: hash, clock_error_bound_ms: 10,
        outbox_id: `outbox-${item.task_id}`, send_request_id: 'request-1',
        precommit_at: started, send_started_at: new Date(Date.parse(started) + milliseconds - 20).toISOString(),
        send_acknowledged_at: new Date(Date.parse(started) + milliseconds - 10).toISOString(),
        first_execution_started_at: new Date(Date.parse(started) + milliseconds - 15).toISOString() };
    });
    return value;
  }
  assert.equal(evaluateSizingResult(bounded('S2', 900), bounded('S1', 5000)).status, 'passed');
  assert.equal(evaluateSizingResult(bounded('S2', 1100), bounded('S1', 5000)).status, 'unqualified');
  const unknownClock = bounded('S2', 900);
  unknownClock.measurements.task_timings[0].queue.clock_bound_verified = false;
  assert.equal(evaluateSizingResult(unknownClock, result('S1')).status, 'unqualified');
  const impossibleOrder = bounded('S2', 900);
  impossibleOrder.measurements.task_timings[0].queue.first_execution_started_at = '2026-10-09T00:00:00Z';
  assert.equal(evaluateSizingResult(impossibleOrder, result('S1')).status, 'unqualified');
});

test('uses same-Worker causal upper bounds without cross-process clock assumptions', () => {
  function bounded(stage, upper) {
    const value = result(stage);
    value.measurements.task_timings.forEach(item => {
      item.queue = { kind: 'same-worker-causal-bounds', task_correlation_verified: true, clock_bound_verified: true,
        clock_evidence_sha256: hash, process_instance: 'worker-process', outbox_id: item.task_id,
        send_request_id: 'request', complete_unfiltered_absence_verified: true, first_attempt_verified: true,
        absent_snapshot_started_ms: 100, send_started_ms: 600, send_acknowledged_ms: 100 + upper,
        first_execution_started_ms: 750 };
    });
    return value;
  }
  assert.equal(evaluateSizingResult(bounded('S2', 900), bounded('S1', 5000)).status, 'passed');
  assert.equal(evaluateSizingResult(bounded('S2', 1100), bounded('S1', 5000)).status, 'unqualified');
  const truncated = bounded('S2', 900);
  truncated.measurements.task_timings[0].queue.complete_unfiltered_absence_verified = false;
  assert.equal(evaluateSizingResult(truncated, result('S1')).status, 'unqualified');
});

test('rejects incorrect credits and claimed overlap on distinct Worker tasks', () => {
  const credits = result('S2');
  credits.workload.vto[0].credit_debit = 0;
  assert.equal(evaluateSizingResult(credits, result('S1')).status, 'rejected');
  const overlap = result('S2');
  overlap.workload.vto[0].worker_task_arn = 'other';
  assert.match(evaluateSizingResult(overlap, result('S1')).reason, /Same-Worker-task overlap/);
});

test('retains API headroom at S3 and distinguishes observed failure from missing evidence', () => {
  const api = result('S3');
  api.measurements.container_peaks[0].peak_mib = 385;
  assert.match(evaluateSizingResult(api, result('S1')).reason, /API candidate/);
  const worker = result('S3');
  worker.measurements.container_peaks[1].peak_mib = 769;
  assert.match(evaluateSizingResult(worker, result('S1')).reason, /Worker candidate/);
  const oom = result('S2');
  oom.unexpected_oom = 1;
  assert.equal(evaluateSizingResult(oom, result('S1')).status, 'rejected');
  const unknown = result('S2');
  delete unknown.lost_accepted_work;
  assert.equal(evaluateSizingResult(unknown, result('S1')).status, 'unqualified');
});

test('derives route percentiles from retained samples rather than supplied scalar values', () => {
  const measured = result('S2');
  measured.measurements.route_samples_ms['/users/me'] = [...Array(94).fill(100), ...Array(6).fill(201)];
  assert.equal(evaluateSizingResult(measured, result('S1')).status, 'rejected');
  const accepted = evaluateSizingResult(result('S2'), result('S1'));
  assert.equal(accepted.status, 'passed');
  assert.equal(accepted.measurements.route_p95_ms['/users/me'], 100);
});
