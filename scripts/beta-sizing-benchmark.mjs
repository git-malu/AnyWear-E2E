const STAGE_DEFINITIONS = Object.freeze([
  Object.freeze({ id: 'S0', purpose: 'fresh-qualified-baseline', api: { desired: 2, minimum: 2, cpu: 512, memoryMiB: 1024 }, worker: { desired: 1, minimum: 1, cpu: 1024, memoryMiB: 2048 } }),
  Object.freeze({ id: 'S1', purpose: 'required-replica-reduction', api: { desired: 1, minimum: 1, cpu: 512, memoryMiB: 1024 }, worker: { desired: 1, minimum: 1, cpu: 1024, memoryMiB: 2048 } }),
  Object.freeze({ id: 'S2', purpose: 'api-memory-candidate', api: { desired: 1, minimum: 1, cpu: 256, memoryMiB: 512 }, worker: { desired: 1, minimum: 1, cpu: 1024, memoryMiB: 2048 } }),
  Object.freeze({ id: 'S3', purpose: 'worker-memory-candidate', api: { desired: 1, minimum: 1, cpu: 256, memoryMiB: 512 }, worker: { desired: 1, minimum: 1, cpu: 512, memoryMiB: 1024 } }),
]);

export const SIZING_STAGES = STAGE_DEFINITIONS;

export const SIZING_WORKLOAD = Object.freeze({
  upload_tagging_cases: 24,
  vto_generations: 10,
  paced_requests_per_route: 100,
  paced_routes: Object.freeze(['/users/me', '/wardrobes', '/base-photos', '/vto-jobs']),
  overlap_cases: 2,
  image_formats: Object.freeze(['image/jpeg', 'image/png', 'image/webp']),
  vto_shapes: Object.freeze(['ordinary-base-one-garment', 'large-base-three-garments', 'largest-supported-output']),
});

export const SIZING_LIMITS = Object.freeze({
  api_memory_headroom_mib: 384,
  worker_memory_headroom_mib: 768,
  latency_relative: 0.25,
  latency_slack_ms: 100,
  provider_slack_ms: 250,
  queue_slack_ms: 1000,
  cpu_sample_limit_percent: 90,
});

const STAGE_IDS = new Set(STAGE_DEFINITIONS.map(({ id }) => id));
const ROUTES = new Set(SIZING_WORKLOAD.paced_routes);

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
  if (typeof fixtureManifestSha256 !== 'string' || fixtureManifestSha256.length === 0) fail('fixtureManifestSha256 is required');
  if (typeof compatibilitySha !== 'string' || compatibilitySha.length === 0) fail('compatibilitySha is required');
  return {
    schema_version: 1,
    issue: 95,
    fixture_manifest_sha256: fixtureManifestSha256,
    compatibility_sha: compatibilitySha,
    stages: STAGE_DEFINITIONS.map((stage) => structuredClone(stage)),
    workload: structuredClone(SIZING_WORKLOAD),
    limits: structuredClone(SIZING_LIMITS),
  };
}

export function validateSizingPlan(plan) {
  if (!plan || plan.schema_version !== 1 || plan.issue !== 95) fail('Unsupported Beta sizing plan');
  if (typeof plan.fixture_manifest_sha256 !== 'string' || plan.fixture_manifest_sha256.length === 0) fail('Sizing plan fixture manifest binding is required');
  if (typeof plan.compatibility_sha !== 'string' || plan.compatibility_sha.length === 0) fail('Sizing plan compatibility binding is required');
  if (!Array.isArray(plan.stages) || plan.stages.length !== STAGE_DEFINITIONS.length) fail('Sizing plan must contain S0 through S3 exactly once');
  plan.stages.forEach((stage, index) => exactStage(stage, STAGE_DEFINITIONS[index], `S${index}`));
  if (!plan.workload || plan.workload.upload_tagging_cases !== 24 || plan.workload.vto_generations !== 10
    || plan.workload.paced_requests_per_route !== 100 || plan.workload.overlap_cases < 2
    || JSON.stringify(plan.workload.paced_routes) !== JSON.stringify(SIZING_WORKLOAD.paced_routes)
    || JSON.stringify(plan.workload.image_formats) !== JSON.stringify(SIZING_WORKLOAD.image_formats)
    || JSON.stringify(plan.workload.vto_shapes) !== JSON.stringify(SIZING_WORKLOAD.vto_shapes)) fail('Sizing workload does not match the reviewed representative set');
  for (const [key, value] of Object.entries(SIZING_LIMITS)) {
    if (plan.limits?.[key] !== value) fail(`Sizing decision limit ${key} changed`);
  }
  return true;
}

function limitFor(stage, baseline, key, slack, label) {
  const observed = finiteNumber(baseline?.[key], `S0 ${label}`);
  return observed + Math.max(observed * SIZING_LIMITS.latency_relative, slack);
}

export function evaluateSizingResult(result, baseline) {
  if (!result || !STAGE_IDS.has(result.stage)) fail('Sizing result stage must be S0, S1, S2 or S3');
  const stage = STAGE_DEFINITIONS.find(({ id }) => id === result.stage);
  for (const field of ['unexpected_oom', 'task_replacements', 'lost_accepted_work', 'readiness_failures', 'duplicate_effects', 'manual_intervention']) {
    if (result[field] !== 0) return { status: 'rejected', reason: `${field} must remain zero`, stage: stage.id };
  }
  if (result.api_peak_mib == null || result.worker_peak_mib == null) return { status: 'unqualified', reason: 'Container peak evidence is incomplete', stage: stage.id };
  for (const field of ['api_peak_mib', 'worker_peak_mib', 'provider_p95_ms', 'queue_p95_ms', 'cpu_sample_max_percent']) {
    finiteNumber(result[field], `${stage.id} ${field}`);
  }
  if (result.cpu_sample_max_percent >= SIZING_LIMITS.cpu_sample_limit_percent) return { status: 'rejected', reason: 'CPU sample reached the sustained limit', stage: stage.id };

  const routeP95 = result.route_p95_ms;
  if (!routeP95 || typeof routeP95 !== 'object' || Object.keys(routeP95).length !== ROUTES.size || Object.keys(routeP95).some((route) => !ROUTES.has(route))) {
    fail('Route p95 evidence must include each reviewed route exactly once');
  }
  for (const [route, value] of Object.entries(routeP95)) {
    finiteNumber(value, `${stage.id} ${route} p95`);
    if (stage.id !== 'S0' && value > limitFor(stage, { route_p95_ms: baseline?.route_p95_ms?.[route] }, 'route_p95_ms', SIZING_LIMITS.latency_slack_ms, `${route} p95`)) {
      return { status: 'rejected', reason: `${route} p95 exceeded the S0 regression limit`, stage: stage.id };
    }
  }
  if (stage.id !== 'S0') {
    if (result.provider_p95_ms > limitFor(stage, baseline, 'provider_p95_ms', SIZING_LIMITS.provider_slack_ms, 'provider p95')) return { status: 'rejected', reason: 'Provider p95 exceeded the S0 regression limit', stage: stage.id };
    if (result.queue_p95_ms > limitFor(stage, baseline, 'queue_p95_ms', SIZING_LIMITS.queue_slack_ms, 'queue p95')) return { status: 'rejected', reason: 'Queue p95 exceeded the S0 regression limit', stage: stage.id };
  }
  if (stage.id === 'S2' && result.api_peak_mib > SIZING_LIMITS.api_memory_headroom_mib) return { status: 'rejected', reason: 'API candidate lacks 25% memory headroom', stage: stage.id };
  if (stage.id === 'S3' && result.worker_peak_mib > SIZING_LIMITS.worker_memory_headroom_mib) return { status: 'rejected', reason: 'Worker candidate lacks 25% memory headroom', stage: stage.id };
  return { status: 'passed', reason: 'All recorded stability, latency and sizing limits passed', stage: stage.id };
}
