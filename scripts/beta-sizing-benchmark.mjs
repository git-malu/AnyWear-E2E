import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { assertSizingCompatibilityEqual, validateSizingSource } from './beta-sizing-source.mjs';
import { S1_INPUT_BYTES_MAX } from './beta-sizing-envelope.mjs';
import { sizingVtoCases } from './beta-sizing-workload.mjs';

const STAGE_DEFINITIONS = Object.freeze([
  Object.freeze({ id: 'S0', purpose: 'historical-replica-cost-baseline', api: { desired: 2, minimum: 2, cpu: 512, memoryMiB: 1024 }, worker: { desired: 1, minimum: 1, cpu: 1024, memoryMiB: 2048 } }),
  Object.freeze({ id: 'S1', purpose: 'fresh-common-runtime-baseline', api: { desired: 1, minimum: 1, cpu: 512, memoryMiB: 1024 }, worker: { desired: 1, minimum: 1, cpu: 1024, memoryMiB: 2048 } }),
  Object.freeze({ id: 'S2', purpose: 'api-memory-candidate', api: { desired: 1, minimum: 1, cpu: 256, memoryMiB: 512 }, worker: { desired: 1, minimum: 1, cpu: 1024, memoryMiB: 2048 } }),
  Object.freeze({ id: 'S3', purpose: 'worker-memory-candidate', api: { desired: 1, minimum: 1, cpu: 256, memoryMiB: 512 }, worker: { desired: 1, minimum: 1, cpu: 512, memoryMiB: 1024 } }),
]);

export const SIZING_STAGES = STAGE_DEFINITIONS;

export const SIZING_WORKLOAD = Object.freeze({
  upload_tagging_cases: 12,
  vto_generations: 8,
  paced_requests_per_route: 100,
  paced_routes: Object.freeze(['/users/me', '/wardrobe', '/vto/base-photos', '/vto/generations']),
  overlap_cases: 2,
  image_formats: Object.freeze(['image/jpeg', 'image/png', 'image/webp']),
  // Four shapes, twice. The fifth reviewed shape carried five garments and the
  // representative larger 4K output; it is deferred to #140 with its aggregate
  // recorded in `S1_DEFERRED_VTO_SHAPE`, because that payload is the one most
  // likely to reproduce the large-input failure this bound works around. The
  // `large-base-*` names are historical bindings retained for stability: every
  // submitted shape uses the served ordinary base photo (see `S1_VTO_SHAPE_NAMING`).
  vto_shapes: Object.freeze(['ordinary-base-one-garment', 'large-base-one-garment', 'ordinary-base-three-garments', 'large-base-three-garments']),
  submission_modes: Object.freeze(['sequential', 'burst']),
  // The reviewed matrix had a second `near-supported-limit` class. Those inputs
  // were above the demonstrated S1 envelope, so the class is not part of the
  // submitted set: `sizingUploadCases()` may only build cases from these classes
  // and `loadSizingFixtures` rejects any fixture above `S1_INPUT_BYTES_MAX`.
  size_classes: Object.freeze(['ordinary']),
  // The bound is per submitted input. A VTO generation aggregates the base photo
  // plus the garments; that aggregate is recorded per observation and is not
  // bounded or proven by this number.
  per_input_bytes_max: S1_INPUT_BYTES_MAX,
});

export const SIZING_LIMITS = Object.freeze({
  api_memory_headroom_mib: 384,
  worker_memory_headroom_mib: 768,
  latency_relative: 0.25,
  latency_slack_ms: 100,
  local_processing_slack_ms: 250,
  queue_slack_ms: 1000,
  cpu_sample_limit_percent: 90,
});

const ROUTES = new Set(SIZING_WORKLOAD.paced_routes);
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const fixtureManifestBytes = readFileSync(new URL('../tests/fixtures/beta-sizing/fixture-manifest.json', import.meta.url));
const fixtureManifestSha256 = createHash('sha256').update(fixtureManifestBytes).digest('hex');
const frozenFixtures = new Map(JSON.parse(fixtureManifestBytes).fixtures.map(fixture => [fixture.id, fixture]));

export function sizingUploadCases() {
  const cases = [];
  const extraGarments = ['trousers', 'jacket', 'shoes', 'bag'];
  let extra = 0;
  for (const submission of SIZING_WORKLOAD.submission_modes) {
    for (const size of SIZING_WORKLOAD.size_classes) {
      for (const ext of ['jpg', 'png', 'webp']) {
        for (let repeat = 0; repeat < 2; repeat += 1) {
          const fixture = size === 'ordinary' && ext === 'jpg'
            ? `${extraGarments[extra++]}-ordinary.jpg`
            : `sweater-${size === 'ordinary' ? 'ordinary' : 'large'}.${ext}`;
          cases.push({ case_id: `${submission}-${size}-${ext}-${repeat}`, fixture, submission, size_class: size });
        }
      }
    }
  }
  if (cases.length !== SIZING_WORKLOAD.upload_tagging_cases) {
    throw new Error(`Upload matrix has ${cases.length} cases, not the reviewed ${SIZING_WORKLOAD.upload_tagging_cases}`);
  }
  return cases;
}

function fail(message) {
  throw new Error(message);
}

function finiteNumber(value, label, { minimum = 0 } = {}) {
  if (!Number.isFinite(value) || value < minimum) fail(`${label} must be a finite number >= ${minimum}`);
  return value;
}

function exactStage(stage, expected, label) {
  if (!stage || stage.id !== expected.id || stage.purpose !== expected.purpose) fail(`${label} stage identity changed`);
  for (const service of ['api', 'worker']) {
    for (const field of ['desired', 'minimum', 'cpu', 'memoryMiB']) {
      if (stage[service]?.[field] !== expected[service][field]) fail(`${label} ${service}.${field} differs from reviewed sizing`);
    }
  }
}

export function createSizingPlan({ fixtureManifestSha256, compatibilitySha } = {}) {
  if (!HASH.test(fixtureManifestSha256)) fail('fixtureManifestSha256 must be a full SHA-256');
  if (!SHA.test(compatibilitySha)) fail('compatibilitySha must be a full commit SHA');
  return {
    schema_version: 1,
    issue: 95,
    fixture_manifest_sha256: fixtureManifestSha256,
    compatibility_sha: compatibilitySha,
    runtime_baseline: 'S1',
    stages: STAGE_DEFINITIONS.map((stage) => structuredClone(stage)),
    workload: structuredClone(SIZING_WORKLOAD),
    limits: structuredClone(SIZING_LIMITS),
  };
}

export function validateSizingPlan(plan) {
  if (!plan || plan.schema_version !== 1 || plan.issue !== 95) fail('Unsupported Beta sizing plan');
  if (!HASH.test(plan.fixture_manifest_sha256)) fail('Sizing plan fixture manifest binding is required');
  if (!SHA.test(plan.compatibility_sha)) fail('Sizing plan compatibility binding is required');
  if (plan.runtime_baseline !== 'S1') fail('Fresh runtime comparison must use the one-replica S1 baseline');
  if (!Array.isArray(plan.stages) || plan.stages.length !== STAGE_DEFINITIONS.length) fail('Sizing plan must contain S0 through S3 exactly once');
  plan.stages.forEach((stage, index) => exactStage(stage, STAGE_DEFINITIONS[index], `S${index}`));
  if (!plan.workload || plan.workload.upload_tagging_cases !== SIZING_WORKLOAD.upload_tagging_cases
    || plan.workload.vto_generations !== SIZING_WORKLOAD.vto_generations
    || plan.workload.paced_requests_per_route !== 100 || plan.workload.overlap_cases !== 2
    || plan.workload.per_input_bytes_max !== S1_INPUT_BYTES_MAX
    || JSON.stringify(plan.workload.paced_routes) !== JSON.stringify(SIZING_WORKLOAD.paced_routes)
    || JSON.stringify(plan.workload.image_formats) !== JSON.stringify(SIZING_WORKLOAD.image_formats)
    || JSON.stringify(plan.workload.size_classes) !== JSON.stringify(SIZING_WORKLOAD.size_classes)
    || JSON.stringify(plan.workload.vto_shapes) !== JSON.stringify(SIZING_WORKLOAD.vto_shapes)) fail('Sizing workload does not match the reviewed representative set');
  for (const [key, value] of Object.entries(SIZING_LIMITS)) {
    if (plan.limits?.[key] !== value) fail(`Sizing decision limit ${key} changed`);
  }
  return true;
}

function percentile95(samples, label) {
  samples.forEach((value) => finiteNumber(value, label));
  return [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * 0.95) - 1];
}

function time(value) {
  return typeof value === 'string' && /Z$/.test(value) ? Date.parse(value) : NaN;
}

function queueBounds(item) {
  const queue = item.queue;
  if (!queue || queue.task_correlation_verified !== true || queue.clock_bound_verified !== true
    || !HASH.test(queue.clock_evidence_sha256)) return undefined;
  if (queue.kind === 'same-worker-causal-bounds') {
    const { absent_snapshot_started_ms: absent, send_started_ms: send,
      send_acknowledged_ms: ack, first_execution_started_ms: execution } = queue;
    if (!queue.process_instance || !queue.outbox_id || !queue.send_request_id
      || queue.complete_unfiltered_absence_verified !== true || queue.first_attempt_verified !== true || queue.send_sdk_attempts !== 1
      || ![absent, send, ack, execution].every(Number.isFinite)
      || absent < 0 || send < absent || ack < send || execution < send) return undefined;
    return { commit_to_publish: [0, ack - absent],
      publish_to_execution: [Math.max(0, execution - ack), execution - send] };
  }
  if (queue.kind === 'exact-common-clock') {
    if (['commit_to_publish_ms', 'publish_to_execution_ms'].some((field) => !Number.isFinite(queue[field]) || queue[field] < 0)) return undefined;
    return { commit_to_publish: [queue.commit_to_publish_ms, queue.commit_to_publish_ms],
      publish_to_execution: [queue.publish_to_execution_ms, queue.publish_to_execution_ms] };
  }
  if (queue.kind !== 'conservative-phase-bounds' || !Number.isFinite(queue.clock_error_bound_ms)
    || queue.clock_error_bound_ms < 0 || !queue.outbox_id || !queue.send_request_id) return undefined;
  const precommit = time(queue.precommit_at);
  const sendStart = time(queue.send_started_at);
  const acknowledged = time(queue.send_acknowledged_at);
  const execution = time(queue.first_execution_started_at);
  const error = queue.clock_error_bound_ms;
  if (![precommit, sendStart, acknowledged, execution].every(Number.isFinite)
    || acknowledged < sendStart || sendStart + error < precommit || execution + error < sendStart) return undefined;
  return { commit_to_publish: [0, acknowledged - precommit + error],
    publish_to_execution: [0, execution - sendStart + error] };
}

function evidenceGap(result, stage) {
  const binding = result.binding;
  if (!binding || !HASH.test(binding.fixture_manifest_sha256) || !HASH.test(binding.supported_input_envelope_sha256)
    || !HASH.test(binding.provider_configuration_sha256) || !HASH.test(binding.deployment_record_sha256)
    || !SHA.test(binding.client_sha) || !SHA.test(binding.service_sha) || !SHA.test(binding.infra_sha)
    || !SHA.test(binding.e2e_sha) || !/^sha256:[a-f0-9]{64}$/.test(binding.image_digest)) return 'Exact workload and deployed input bindings are incomplete';
  try {
    validateSizingSource(result.source_proof, { e2eSha: binding.e2e_sha, runId: result.run_id, runAttempt: result.run_attempt });
    const compatibility = result.source_proof.compatibility;
    if (binding.benchmark_source_sha256 !== result.source_proof.benchmark_source_sha256
      || binding.deployment_record_sha256 !== compatibility.deployment.record_sha256
      || ['client', 'service', 'infra'].some(component => binding[`${component}_sha`] !== compatibility[component].sha)) {
      return 'Actual sizing source/deployment binding mismatch';
    }
  } catch { return 'Complete actual run/source proof is missing or invalid'; }
  if (!Array.isArray(result.raw_evidence) || !result.raw_evidence.length
    || result.raw_evidence.some((item) => !HASH.test(item.sha256) || !/^https:\/\/github\.com\//.test(item.url))) return 'Immutable raw evidence references are incomplete';
  if (!result.observed) return 'Actual deployed sizing is missing';
  for (const service of ['api', 'worker']) {
    for (const field of ['desired', 'minimum', 'cpu', 'memoryMiB']) {
      if (result.observed[service]?.[field] !== stage[service][field]) return `Actual ${service}.${field} differs from the selected stage`;
    }
  }

  const uploads = result.workload?.uploads;
  if (!Array.isArray(uploads) || uploads.length !== SIZING_WORKLOAD.upload_tagging_cases) return 'Representative upload/tagging coverage is incomplete';
  if (binding.fixture_manifest_sha256 !== fixtureManifestSha256) return 'Upload fixture manifest differs from the frozen source';
  const cases = new Map(sizingUploadCases().map(item => [item.case_id, item]));
  if (new Set(uploads.map(item => item.case_id)).size !== cases.size) return 'Upload matrix requires unique canonical case IDs';
  for (const item of uploads) {
    const expected = cases.get(item.case_id);
    const fixture = expected && frozenFixtures.get(expected.fixture);
    if (!fixture || item.fixture !== expected.fixture || item.submission !== expected.submission
      || item.size_class !== expected.size_class || item.mime !== fixture.mime
      || item.fixture_sha256 !== fixture.sha256 || item.fixture_bytes !== fixture.bytes
      || !Array.isArray(item.fixture_dimensions) || item.fixture_dimensions.length !== 2
      || item.fixture_dimensions[0] !== fixture.width || item.fixture_dimensions[1] !== fixture.height) {
      return 'Upload matrix or frozen fixture binding differs from the reviewed case';
    }
    if (item.fixture_bytes > S1_INPUT_BYTES_MAX) return `Upload input ${item.case_id} exceeds the demonstrated S1 input envelope`;
  }
  const vto = result.workload?.vto;
  if (!Array.isArray(vto) || vto.length !== SIZING_WORKLOAD.vto_generations) return 'Representative VTO coverage is incomplete';
  // A VTO generation sends the base photo plus its garments. Every one of those
  // inputs must be inside the per-input bound, the garment list must be the
  // canonical smallest-first one, and the observation must report the aggregate
  // it actually submitted so the payload is visible rather than left to be added
  // up. That aggregate is not bounded by the per-input number and stays unproven.
  const vtoCases = new Map(sizingVtoCases().map(item => [item.case_id, item]));
  for (const item of vto) {
    const expected = vtoCases.get(item.case_id);
    const base = expected && frozenFixtures.get(expected.base_fixture);
    if (!base || item.base_fixture !== expected.base_fixture || item.base_fixture_sha256 !== base.sha256
      || item.base_fixture_bytes !== base.bytes || !Number.isInteger(item.base_fixture_bytes)
      || item.base_fixture_bytes > S1_INPUT_BYTES_MAX) {
      return 'VTO base fixture binding is missing, changed or above the demonstrated S1 input envelope';
    }
    const garments = expected.garment_fixtures;
    if (item.garment_count !== expected.garment_count
      || JSON.stringify(item.garment_fixtures) !== JSON.stringify(garments)
      || garments.some(id => !frozenFixtures.has(id) || frozenFixtures.get(id).bytes > S1_INPUT_BYTES_MAX)) {
      return 'VTO garment binding must be the canonical inside-envelope list submitted smallest-first';
    }
    const aggregate = base.bytes + garments.reduce((total, id) => total + frozenFixtures.get(id).bytes, 0);
    if (item.aggregate_submitted_bytes !== aggregate || aggregate <= S1_INPUT_BYTES_MAX) {
      return 'VTO observations must report the aggregate they submitted, which the per-input bound does not cover';
    }
  }
  const ids = [...uploads, ...vto].map((item) => item.task_id);
  if (ids.some((id) => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) return 'Accepted task identities must be distinct';
  if (uploads.some((item) => item.terminal_state !== 'ready' || item.replay_verified !== true || item.reload_verified !== true)) return 'Upload terminal, replay or recovery evidence is incomplete';
  for (const shape of SIZING_WORKLOAD.vto_shapes) {
    if (vto.filter((item) => item.shape === shape).length !== 2) return 'Each supported VTO shape must run twice';
  }
  if (vto.some((item) => item.terminal_state !== 'Complete' || item.output_retrievable !== true
    || item.progress_reload_verified !== true || item.replay_verified !== true || item.credit_debit !== 1)) return 'VTO completion, output, progress, replay or credit evidence is incomplete';
  const overlap = result.workload?.overlap;
  if (!Array.isArray(overlap) || overlap.length < SIZING_WORKLOAD.overlap_cases
    || new Set(overlap.map((item) => `${item.upload_task_id}:${item.vto_task_id}`)).size !== overlap.length) return 'Distinct overlap cases are incomplete';
  for (const item of overlap) {
    const upload = uploads.find((entry) => entry.task_id === item.upload_task_id);
    const generation = vto.find((entry) => entry.task_id === item.vto_task_id);
    if (!upload || !generation || !upload.worker_task_arn || upload.worker_task_arn !== generation.worker_task_arn
      || !upload.worker_process_instance || upload.worker_process_instance !== generation.worker_process_instance
      || ![upload.started_monotonic_ms, upload.finished_monotonic_ms, generation.started_monotonic_ms, generation.finished_monotonic_ms].every(value => Number.isFinite(value) && value >= 0)
      || upload.started_monotonic_ms >= upload.finished_monotonic_ms || generation.started_monotonic_ms >= generation.finished_monotonic_ms
      || Math.max(upload.started_monotonic_ms, generation.started_monotonic_ms) >= Math.min(upload.finished_monotonic_ms, generation.finished_monotonic_ms)) return 'Same-Worker-task overlap is not demonstrated';
  }

  const measurements = result.measurements;
  if (!measurements) return 'Measurements are missing';
  if (measurements.peak_method !== 'container-cgroup-high-water' || measurements.peak_window_covered !== true) return 'Complete container high-water evidence is unavailable; sampled memory or RSS is insufficient';
  const tasks = measurements.tasks;
  const peaks = measurements.container_peaks;
  if (!Array.isArray(tasks) || !tasks.length || new Set(tasks.map((item) => item.task_arn)).size !== tasks.length
    || !Array.isArray(peaks) || peaks.length !== tasks.length
    || !['api', 'worker'].every((service) => tasks.some((item) => item.service === service))) return 'Per-task peak inventory is incomplete';
  for (const task of tasks) {
    const peak = peaks.filter((item) => item.task_arn === task.task_arn);
    if (!task.task_arn || !['api', 'worker'].includes(task.service) || peak.length !== 1
      || !Number.isFinite(peak[0].peak_mib) || peak[0].peak_mib <= 0
      || peak[0].limit_mib !== stage[task.service].memoryMiB) return 'Peak evidence is not bound to every actual task and hard limit';
  }
  const start = time(measurements.started_at);
  const end = time(measurements.finished_at);
  const minutes = (end - start) / 60000;
  if (!Number.isFinite(start) || !Number.isInteger(minutes) || minutes < 5 || start % 60000) return 'Complete aligned measurement window is missing';
  const cpu = measurements.cpu_samples;
  if (!Array.isArray(cpu) || cpu.length !== minutes * 2) return 'CPU samples must cover both services in every minute; missing buckets are not zero';
  for (const service of ['api', 'worker']) {
    for (let minute = 0; minute < minutes; minute += 1) {
      const samples = cpu.filter((item) => item.service === service && time(item.minute_utc) === start + minute * 60000);
      if (samples.length !== 1 || !Number.isFinite(samples[0].percent) || samples[0].percent < 0) return 'CPU sample coverage is incomplete or duplicated';
    }
  }
  const routes = measurements.route_samples_ms;
  if (!routes || Object.keys(routes).length !== ROUTES.size || Object.keys(routes).some((route) => !ROUTES.has(route))
    || [...ROUTES].some((route) => !Array.isArray(routes[route]) || routes[route].length < SIZING_WORKLOAD.paced_requests_per_route)) return 'At least 100 measured requests are required for each ordinary route';
  const timings = measurements.task_timings;
  if (!Array.isArray(timings) || timings.length !== ids.length || new Set(timings.map((item) => item.task_id)).size !== ids.length
    || timings.some((item) => !ids.includes(item.task_id) || item.provider_separated !== true
      || ['local_processing_ms', 'provider_ms'].some((field) => !Number.isFinite(item[field]) || item[field] < 0)
      || !queueBounds(item))) return 'Provider-separated local and clock-verified correlated queue evidence are required for every accepted task';
  return undefined;
}

function summary(result) {
  const measurements = result.measurements;
  const tasks = measurements.tasks;
  return {
    api_peak_mib: Math.max(...measurements.container_peaks.filter((peak) => tasks.some((task) => task.task_arn === peak.task_arn && task.service === 'api')).map((peak) => peak.peak_mib)),
    worker_peak_mib: Math.max(...measurements.container_peaks.filter((peak) => tasks.some((task) => task.task_arn === peak.task_arn && task.service === 'worker')).map((peak) => peak.peak_mib)),
    route_p95_ms: Object.fromEntries([...ROUTES].map((route) => [route, percentile95(measurements.route_samples_ms[route], `${route} latency`)])),
    local_processing_p95_ms: percentile95(measurements.task_timings.map((item) => item.local_processing_ms), 'local processing'),
    queue: Object.fromEntries(['commit_to_publish', 'publish_to_execution'].map((interval) => [interval, {
      lower_p95_ms: percentile95(measurements.task_timings.map((item) => queueBounds(item)[interval][0]), `${interval} lower bound`),
      upper_p95_ms: percentile95(measurements.task_timings.map((item) => queueBounds(item)[interval][1]), `${interval} upper bound`),
      exact: measurements.task_timings.every((item) => item.queue.kind === 'exact-common-clock'),
    }])),
  };
}

export function evaluateSizingResult(result, baseline) {
  const stage = STAGE_DEFINITIONS.find((item) => item.id === result?.stage);
  if (!stage) fail('Sizing result stage must be S0, S1, S2 or S3');
  const verdict = (status, reason) => ({ status, reason, stage: stage.id });
  if (result.schema_version !== 2) return verdict('unqualified', 'Measured sizing evidence schema version 2 is required');
  if (!Array.isArray(result.evidence_gaps) || result.evidence_gaps.length !== 0) {
    return verdict('unqualified', 'Collector evidence gaps must be explicitly empty before qualification');
  }
  for (const field of ['unexpected_oom', 'task_replacements', 'lost_accepted_work', 'readiness_failures', 'duplicate_effects', 'manual_intervention', 'unexpected_dlq', 'missed_lease_renewals', 'notification_failures', 'unexplained_backlog']) {
    if (result[field] === undefined) return verdict('unqualified', `${field} evidence is missing`);
    finiteNumber(result[field], field);
    if (result[field] !== 0) return verdict('rejected', `${field} must remain zero`);
  }
  for (const [kind, terminal] of [['uploads', 'ready'], ['vto', 'Complete']]) {
    for (const item of result.workload?.[kind] ?? []) {
      if (item.terminal_state !== undefined && item.terminal_state !== terminal) return verdict('rejected', `${kind} has an unsuccessful terminal state`);
      for (const field of ['replay_verified', 'reload_verified', 'output_retrievable', 'progress_reload_verified']) {
        if (item[field] === false) return verdict('rejected', `${kind} ${field} failed`);
      }
      if (kind === 'vto' && item.credit_debit !== undefined && item.credit_debit !== 1) return verdict('rejected', 'VTO credit debit differs from one accepted generation');
    }
  }
  const gap = evidenceGap(result, stage);
  if (gap) return verdict('unqualified', gap);
  for (const service of ['api', 'worker']) {
    let consecutive = 0;
    for (const sample of result.measurements.cpu_samples.filter((item) => item.service === service).sort((a, b) => time(a.minute_utc) - time(b.minute_utc))) {
      consecutive = sample.percent >= SIZING_LIMITS.cpu_sample_limit_percent ? consecutive + 1 : 0;
      if (consecutive >= 5) return verdict('rejected', `${service} CPU reached 90% in five consecutive one-minute samples`);
    }
  }
  const measured = summary(result);
  if (['S2', 'S3'].includes(stage.id) && measured.api_peak_mib > SIZING_LIMITS.api_memory_headroom_mib) return verdict('rejected', 'API candidate lacks 25% memory headroom');
  if (stage.id === 'S3' && measured.worker_peak_mib > SIZING_LIMITS.worker_memory_headroom_mib) return verdict('rejected', 'Worker candidate lacks 25% memory headroom');
  if (['S2', 'S3'].includes(stage.id)) {
    if (baseline?.stage !== 'S1' || evaluateSizingResult(baseline).status !== 'passed') return verdict('unqualified', 'A complete passing fresh common S1 baseline is required');
    for (const field of ['fixture_manifest_sha256', 'supported_input_envelope_sha256', 'provider_configuration_sha256', 'client_sha', 'service_sha', 'infra_sha', 'image_digest', 'benchmark_source_sha256']) {
      if (result.binding[field] !== baseline.binding[field]) return verdict('unqualified', `S1 comparison input ${field} changed`);
    }
    try { assertSizingCompatibilityEqual(result.source_proof.compatibility, baseline.source_proof.compatibility); }
    catch { return verdict('unqualified', 'S1 strict compatibility changed outside four deployment record fields'); }
    const before = summary(baseline);
    const limit = (value, slack) => value + Math.max(value * SIZING_LIMITS.latency_relative, slack);
    for (const route of ROUTES) {
      if (measured.route_p95_ms[route] > limit(before.route_p95_ms[route], SIZING_LIMITS.latency_slack_ms)) return verdict('rejected', `${route} p95 exceeded the S1 regression limit`);
    }
    if (measured.local_processing_p95_ms > limit(before.local_processing_p95_ms, SIZING_LIMITS.local_processing_slack_ms)) return verdict('rejected', 'Provider-separated local processing exceeded the S1 regression limit');
    for (const interval of ['commit_to_publish', 'publish_to_execution']) {
      if (measured.queue[interval].upper_p95_ms > before.queue[interval].lower_p95_ms + SIZING_LIMITS.queue_slack_ms) {
        const exact = measured.queue[interval].exact && before.queue[interval].exact;
        return verdict(exact ? 'rejected' : 'unqualified', `${interval} ${exact ? 'exceeded' : 'upper bound cannot establish'} the S1 regression limit`);
      }
    }
  }
  return { ...verdict('passed', 'Recorded representative workload, stability, latency and sizing limits passed'), measurements: measured };
}
