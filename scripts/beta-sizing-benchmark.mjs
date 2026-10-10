const STAGE_DEFINITIONS = Object.freeze([
  Object.freeze({ id: 'S0', purpose: 'historical-replica-cost-baseline', api: { desired: 2, minimum: 2, cpu: 512, memoryMiB: 1024 }, worker: { desired: 1, minimum: 1, cpu: 1024, memoryMiB: 2048 } }),
  Object.freeze({ id: 'S1', purpose: 'fresh-common-runtime-baseline', api: { desired: 1, minimum: 1, cpu: 512, memoryMiB: 1024 }, worker: { desired: 1, minimum: 1, cpu: 1024, memoryMiB: 2048 } }),
  Object.freeze({ id: 'S2', purpose: 'api-memory-candidate', api: { desired: 1, minimum: 1, cpu: 256, memoryMiB: 512 }, worker: { desired: 1, minimum: 1, cpu: 1024, memoryMiB: 2048 } }),
  Object.freeze({ id: 'S3', purpose: 'worker-memory-candidate', api: { desired: 1, minimum: 1, cpu: 256, memoryMiB: 512 }, worker: { desired: 1, minimum: 1, cpu: 512, memoryMiB: 1024 } }),
]);

export const SIZING_STAGES = STAGE_DEFINITIONS;

export const SIZING_WORKLOAD = Object.freeze({
  upload_tagging_cases: 24,
  vto_generations: 10,
  paced_requests_per_route: 100,
  paced_routes: Object.freeze(['/users/me', '/wardrobe', '/vto/base-photos', '/vto/generations']),
  overlap_cases: 2,
  image_formats: Object.freeze(['image/jpeg', 'image/png', 'image/webp']),
  vto_shapes: Object.freeze(['ordinary-base-one-garment', 'large-base-one-garment', 'ordinary-base-three-garments', 'large-base-three-garments', 'representative-larger-outfit-output']),
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
  if (!plan.workload || plan.workload.upload_tagging_cases !== 24 || plan.workload.vto_generations !== 10
    || plan.workload.paced_requests_per_route !== 100 || plan.workload.overlap_cases !== 2
    || JSON.stringify(plan.workload.paced_routes) !== JSON.stringify(SIZING_WORKLOAD.paced_routes)
    || JSON.stringify(plan.workload.image_formats) !== JSON.stringify(SIZING_WORKLOAD.image_formats)
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
      || queue.complete_unfiltered_absence_verified !== true || queue.first_attempt_verified !== true
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
  const vto = result.workload?.vto;
  if (!Array.isArray(vto) || vto.length !== SIZING_WORKLOAD.vto_generations) return 'Representative VTO coverage is incomplete';
  const ids = [...uploads, ...vto].map((item) => item.task_id);
  if (ids.some((id) => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) return 'Accepted task identities must be distinct';
  for (const format of SIZING_WORKLOAD.image_formats) {
    for (const size of ['ordinary', 'near-supported-limit']) {
      if (!uploads.some((item) => item.mime === format && item.size_class === size && HASH.test(item.fixture_sha256))) return 'Upload formats or supported size envelope are incomplete';
    }
  }
  if (!['sequential', 'burst'].every((mode) => uploads.some((item) => item.submission === mode))) return 'Sequential and burst coverage are incomplete';
  if (uploads.some((item) => item.terminal_state !== 'ready' || item.replay_verified !== true || item.reload_verified !== true)) return 'Upload terminal, replay or recovery evidence is incomplete';
  for (const shape of SIZING_WORKLOAD.vto_shapes) {
    if (vto.filter((item) => item.shape === shape).length !== 2) return 'Each of five supported VTO shapes must run twice';
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
      || ![upload.started_at, upload.finished_at, generation.started_at, generation.finished_at].every((value) => Number.isFinite(time(value)))
      || time(upload.started_at) >= time(upload.finished_at) || time(generation.started_at) >= time(generation.finished_at)
      || Math.max(time(upload.started_at), time(generation.started_at)) >= Math.min(time(upload.finished_at), time(generation.finished_at))) return 'Same-Worker-task overlap is not demonstrated';
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
    for (const field of ['fixture_manifest_sha256', 'supported_input_envelope_sha256', 'provider_configuration_sha256', 'client_sha', 'service_sha', 'image_digest']) {
      if (result.binding[field] !== baseline.binding[field]) return verdict('unqualified', `S1 comparison input ${field} changed`);
    }
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
