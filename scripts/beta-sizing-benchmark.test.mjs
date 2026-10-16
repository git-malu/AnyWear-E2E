import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createSizingPlan, evaluateSizingResult, sizingUploadCases, SIZING_STAGES, SIZING_WORKLOAD, validateSizingPlan } from './beta-sizing-benchmark.mjs';
import { sizingVtoCases, vtoAggregateSubmittedBytes } from './beta-sizing-workload.mjs';
import { S1_INPUT_BYTES_MAX, S1_DEFERRED_VTO_SHAPE } from './beta-sizing-envelope.mjs';
import { sizingSourceFixture } from './fixtures/beta-sizing-source.mjs';

const hash = 'a'.repeat(64);
const sha = 'b'.repeat(40);
const started = '2026-10-10T00:00:00Z';
const finished = '2026-10-10T00:05:00Z';
const fixtureBytes = readFileSync(new URL('../tests/fixtures/beta-sizing/fixture-manifest.json', import.meta.url));
const fixtures = new Map(JSON.parse(fixtureBytes).fixtures.map(fixture => [fixture.id, fixture]));
const manifestSha256 = createHash('sha256').update(fixtureBytes).digest('hex');
const vtoCases = sizingVtoCases();

function result(stage) {
  const sizing = SIZING_STAGES.find((item) => item.id === stage);
  const uploads = sizingUploadCases().map((item, index) => ({
    ...item, task_id: `upload-${index}`, mime: fixtures.get(item.fixture).mime,
    fixture_sha256: fixtures.get(item.fixture).sha256, fixture_bytes: fixtures.get(item.fixture).bytes,
    fixture_dimensions: [fixtures.get(item.fixture).width, fixtures.get(item.fixture).height],
    terminal_state: 'ready', replay_verified: true, reload_verified: true,
    worker_task_arn: 'arn:aws:ecs:ap-east-1:650880818323:task/cluster/worker',
    worker_process_instance: 'worker-process', started_monotonic_ms: 1000, finished_monotonic_ms: 2000,
    started_at: '2026-10-10T00:01:00Z', finished_at: '2026-10-10T00:02:00Z',
  }));
  const vto = Array.from({ length: SIZING_WORKLOAD.vto_generations }, (_, index) => ({
    ...vtoCases[index], task_id: `vto-${index}`,
    base_fixture_sha256: fixtures.get(vtoCases[index].base_fixture).sha256,
    base_fixture_bytes: fixtures.get(vtoCases[index].base_fixture).bytes,
    aggregate_submitted_bytes: vtoAggregateSubmittedBytes(fixtures, vtoCases[index].base_fixture,
      vtoCases[index].garment_fixtures),
    terminal_state: 'Complete', output_retrievable: true, progress_reload_verified: true,
    replay_verified: true, credit_debit: 1, worker_task_arn: uploads[0].worker_task_arn,
    worker_process_instance: 'worker-process', started_monotonic_ms: 1500, finished_monotonic_ms: 3000,
    started_at: '2026-10-10T00:01:30Z', finished_at: '2026-10-10T00:03:00Z',
  }));
  const tasks = [{ task_arn: 'api', service: 'api' }, { task_arn: 'worker', service: 'worker' }];
  const source = sizingSourceFixture();
  source.compatibility.client.sha = sha; source.compatibility.service.sha = sha; source.compatibility.infra.sha = sha;
  source.compatibility.deployment.record_sha256 = hash;
  const proof = sizingSourceFixture({ compatibility: source.compatibility });
  return {
    schema_version: 2, stage, evidence_gaps: [], source_proof: proof, run_id: '1', run_attempt: '1',
    unexpected_oom: 0, task_replacements: 0, lost_accepted_work: 0,
    readiness_failures: 0, duplicate_effects: 0, manual_intervention: 0,
    unexpected_dlq: 0, missed_lease_renewals: 0, notification_failures: 0, unexplained_backlog: 0,
    binding: {
      fixture_manifest_sha256: manifestSha256, supported_input_envelope_sha256: hash,
      provider_configuration_sha256: hash, deployment_record_sha256: hash,
      client_sha: sha, service_sha: sha, infra_sha: sha, e2e_sha: sha,
      benchmark_source_sha256: proof.benchmark_source_sha256,
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

test('binds the reviewed plan to full hashes and the four remaining VTO shapes', () => {
  const plan = createSizingPlan({ fixtureManifestSha256: hash, compatibilitySha: sha });
  assert.equal(validateSizingPlan(plan), true);
  assert.equal(plan.workload.vto_shapes.length, 4);
  assert.equal(plan.workload.vto_generations, 8);
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
  const changedSource = result('S2');
  changedSource.binding.e2e_sha = 'c'.repeat(40);
  assert.match(evaluateSizingResult(changedSource, result('S1')).reason, /source proof/);
});

test('permits only four deployment record fields with complete identical benchmark source proof', () => {
  const baseline = result('S1');
  const candidate = result('S2');
  const compatibility = structuredClone(candidate.source_proof.compatibility);
  Object.assign(compatibility.deployment, { run_id: 31, run_attempt: 1, artifact_id: 41, record_sha256: 'd'.repeat(64) });
  candidate.source_proof = sizingSourceFixture({ e2eSha: 'd'.repeat(40), compatibility, runId: '2' });
  candidate.run_id = '2'; candidate.binding.e2e_sha = 'd'.repeat(40);
  candidate.binding.deployment_record_sha256 = compatibility.deployment.record_sha256;
  assert.equal(evaluateSizingResult(candidate, baseline).status, 'passed');
  candidate.source_proof.compatibility.service_artifacts.release_id++;
  candidate.source_proof = sizingSourceFixture({ e2eSha: 'd'.repeat(40), compatibility: candidate.source_proof.compatibility, runId: '2' });
  assert.match(evaluateSizingResult(candidate, baseline).reason, /strict compatibility/);
  for (const mutate of [value => { delete value.source_proof; }, value => { value.source_proof.run_id = '99'; },
    value => { value.source_proof.inventory.pop(); }, value => { value.source_proof.benchmark_source_sha256 = hash; },
    value => { value.source_proof.compatibility_bytes_base64 = 'e30='; }]) {
    const value = result('S1'); mutate(value);
    assert.equal(evaluateSizingResult(value).status, 'unqualified');
  }
});

test('unresolved or malformed collector gaps block S1 and candidate qualification', () => {
  for (const stage of ['S1', 'S2']) {
    for (const gaps of [['Non-JSON sizing event in api'], [{ resource_id: 'item', reason: 'Missing ACK' }], undefined, null, '']) {
      const value = result(stage); value.evidence_gaps = gaps;
      assert.equal(evaluateSizingResult(value, result('S1')).status, 'unqualified');
    }
  }
});

test('all formats and sizes require two sequential and two burst cases with frozen bindings', () => {
  const replaced = result('S1');
  // Preserve total count and all format/size/mode presence while replacing most
  // cells with repeated ordinary sequential JPEG uploads.
  const keep = new Set([0, 2, 4, 6, 8, 10]);
  for (let index = 0; index < replaced.workload.uploads.length; index++) {
    if (!keep.has(index)) replaced.workload.uploads[index] = { ...replaced.workload.uploads[0], task_id: `upload-${index}` };
  }
  assert.equal(evaluateSizingResult(replaced).status, 'unqualified');
  const missingBurst = result('S1');
  const item = missingBurst.workload.uploads.find(upload => upload.case_id === 'burst-ordinary-webp-1');
  item.submission = 'sequential';
  assert.match(evaluateSizingResult(missingBurst).reason, /Upload matrix/);
  for (const mutate of [upload => { upload.case_id = 'invented-case'; },
    upload => { upload.fixture = 'sweater-large.png'; },
    upload => { upload.fixture_sha256 = hash; }, upload => { upload.fixture_bytes++; },
    upload => { upload.fixture_dimensions[0]++; }]) {
    const value = result('S1'); mutate(value.workload.uploads[0]);
    assert.match(evaluateSizingResult(value).reason, /Upload matrix/);
  }
});

test('binds the reviewed plan and collected evidence to the measured S1 input envelope', () => {
  const plan = createSizingPlan({ fixtureManifestSha256: hash, compatibilitySha: sha });
  assert.equal(plan.workload.upload_tagging_cases, 12);
  assert.equal(plan.workload.vto_generations, 8);
  assert.equal(plan.workload.per_input_bytes_max, S1_INPUT_BYTES_MAX);
  assert.deepEqual(plan.workload.size_classes, ['ordinary']);
  plan.workload.upload_tagging_cases = 24;
  assert.throws(() => validateSizingPlan(plan), /reviewed representative set/);
  const widened = createSizingPlan({ fixtureManifestSha256: hash, compatibilitySha: sha });
  widened.workload.per_input_bytes_max = S1_INPUT_BYTES_MAX + 1;
  assert.throws(() => validateSizingPlan(widened), /reviewed representative set/);
  const moreShapes = createSizingPlan({ fixtureManifestSha256: hash, compatibilitySha: sha });
  moreShapes.workload.vto_shapes.push('representative-larger-outfit-output');
  assert.throws(() => validateSizingPlan(moreShapes), /reviewed representative set/);

  // Evidence that reports an above-envelope input is unqualified, not accepted:
  // constraining what is submitted never relaxes what must pass. The measured
  // inputs are the run's historical figures, so the shipped fixtures may differ.
  const declared = JSON.parse(fixtureBytes);
  assert.ok(declared.fixtures.every(fixture => fixture.bytes <= S1_INPUT_BYTES_MAX));
  assert.match(declared.s1_input_envelope.measured_inputs_basis, /historical run evidence/);
  assert.match(declared.s1_input_envelope.input_bytes_max_basis, /per submitted input/);
  assert.deepEqual(declared.s1_input_envelope.deferred_vto_shape, { ...S1_DEFERRED_VTO_SHAPE,
    advanced_settings: { ...S1_DEFERRED_VTO_SHAPE.advanced_settings },
    garment_fixtures: [...S1_DEFERRED_VTO_SHAPE.garment_fixtures] });
  const served = declared.s1_input_envelope.measured_inputs;
  assert.equal(Math.max(...served.filter(item => item.terminal_state === 'ready').map(item => item.bytes)),
    S1_INPUT_BYTES_MAX);
  const unbindableVto = result('S1');
  unbindableVto.workload.vto[0].base_fixture_bytes = S1_INPUT_BYTES_MAX + 1;
  assert.match(evaluateSizingResult(unbindableVto).reason, /VTO base fixture binding/);
  const unboundVto = result('S1');
  delete unboundVto.workload.vto[0].base_fixture_sha256;
  assert.match(evaluateSizingResult(unboundVto).reason, /VTO base fixture binding/);

  // The VTO aggregate is reported per observation: a missing or wrong figure, and a
  // garment list that is not the canonical smallest-first one, are unqualified.
  const missingAggregate = result('S1');
  delete missingAggregate.workload.vto[0].aggregate_submitted_bytes;
  assert.match(evaluateSizingResult(missingAggregate).reason, /aggregate they submitted/);
  const padded = result('S1');
  padded.workload.vto[0].garment_fixtures = ['bag-ordinary.jpg', 'sweater-ordinary.png'];
  assert.match(evaluateSizingResult(padded).reason, /canonical inside-envelope list/);
  const reordered = result('S1');
  reordered.workload.vto[2].garment_fixtures = ['trousers-ordinary.jpg', 'bag-ordinary.jpg', 'shoes-ordinary.jpg'];
  assert.match(evaluateSizingResult(reordered).reason, /canonical inside-envelope list/);
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
        send_request_id: 'request', complete_unfiltered_absence_verified: true, first_attempt_verified: true, send_sdk_attempts: 1,
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
  const retried = bounded('S2', 900);
  retried.measurements.task_timings[0].queue.send_sdk_attempts = 2;
  assert.equal(evaluateSizingResult(retried, result('S1')).status, 'unqualified');
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
