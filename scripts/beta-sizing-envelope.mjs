// The sizing input envelope this deployment is demonstrated to serve.
//
// The bound is measured, not assumed: it is the largest single input a real S1
// Beta Qualification run served to a terminal `ready` state. It applies to each
// SUBMITTED INPUT, which is the reading the evidence supports - it was derived
// from single-image uploads, where one input is one provider payload. A VTO
// generation aggregates a base photo plus one or more garments and is a separate
// quantity; see `SIZING_VTO_AGGREGATE_LIMIT`.
//
// This is a bound on what is submitted, never a relaxation of what must pass: an
// input above the bound is not made passable, it is not submitted until a run
// passes at that size. Inputs above the bound remain the known #140 defect.
export const S1_INPUT_BYTES_MAX = 697_437;

export const S1_INPUT_ENVELOPE_REFERENCE = Object.freeze({
  artifact: 'beta-qualification-diagnostics-38768690421-1',
  run_url: 'https://github.com/git-malu/AnyWear-E2E/actions/runs/38768690421',
  run_id: 38768690421,
  run_attempt: 1,
  stage: 'S1',
  e2e_sha: '2fb06bce239e483eae77f7095062dc06fc395891',
  workload_path: 'test-results/beta-sizing-workload.json',
});

export const S1_INPUT_MEASURED_BASIS = 'historical run evidence from run 38768690421; the shipped fixtures are '
  + 're-encoded and are not these byte counts';

// Inputs this envelope is derived from, exactly as that run reported them. These
// are HISTORICAL figures, not the committed fixture sizes: the two serving
// fixtures now ship re-encoded (trousers-ordinary.jpg 441,913 -> 388,182 B and
// jacket-ordinary.jpg 697,437 -> 664,453 B), and the failed third case is
// retained because it is the observation that places the bound below its bytes.
export const S1_INPUT_MEASURED_CASES = Object.freeze([
  Object.freeze({ case_id: 'sequential-ordinary-jpg-0', fixture: 'trousers-ordinary.jpg',
    bytes: 441_913, width: 1200, height: 960, terminal_state: 'ready', seconds: 25.7 }),
  Object.freeze({ case_id: 'sequential-ordinary-jpg-1', fixture: 'jacket-ordinary.jpg',
    bytes: 697_437, width: 900, height: 1200, terminal_state: 'ready', seconds: 85.0 }),
  Object.freeze({ case_id: 'sequential-ordinary-png-0', fixture: 'sweater-ordinary.png',
    bytes: 3_742_711, width: 1200, height: 1039, terminal_state: 'failed' }),
]);

// Fixtures deliberately outside the constrained set. They stay excluded, and no
// case may reference them, until a run demonstrates a larger envelope.
export const S1_INPUT_EXCLUDED_FIXTURES = Object.freeze([
  Object.freeze({ id: 'base-photo-large.jpg', bytes: 2_611_145, width: 2124, height: 2940,
    sha256: 'a7b6638f370cf06800211280934da7ccf00d04eac7fb86654fe54b5784c96b46',
    size_class: 'large-base', reason: 'input_bytes_above_envelope' }),
  Object.freeze({ id: 'sweater-large.jpg', bytes: 9_218_003, width: 6357, height: 5505,
    sha256: '9e1cde764270b3b10cbbaf0fee21c2b260d438fc67d256f42c9ca5a52680b02b',
    size_class: 'near-supported-limit', reason: 'input_bytes_above_envelope' }),
  Object.freeze({ id: 'sweater-large.png', bytes: 9_749_963, width: 1937, height: 1677,
    sha256: 'f2403c1c0134179aedb0fbdc7cc6ed4ad7834fa2f838cf5450cf8889a6b7d36d',
    size_class: 'near-supported-limit', reason: 'input_bytes_above_envelope' }),
  Object.freeze({ id: 'sweater-large.webp', bytes: 9_748_684, width: 3952, height: 5269,
    sha256: '5cbef6e1b51f33ff99e24cec94a6742f4af216402eccb76dba203f18bbae2386',
    size_class: 'near-supported-limit', reason: 'input_bytes_above_envelope' }),
]);

// The VTO payload is the base photo plus the selected garments, so it aggregates
// several inputs into one provider payload. That aggregate is a different
// quantity from the per-input bound and is NOT proven by this envelope: no VTO
// generation has ever run in this workload. Garments are ordered smallest-first
// so each shape carries the least payload it can.
//
// The pool is CONSTRAINED to the fixtures the submission plan resolves before the
// VTO cases: every id here is submitted by a sequential sizing upload case, so no
// VTO case can name a garment the case set never submits - the defect this pool
// exists to remove is a five-id list whose last entry, `sweater-ordinary.png`, is
// submitted only by burst uploads that launch inside the VTO loop. The workload
// module refuses a pool that names anything outside this set, and
// `createSizingVtoGarmentPlan` refuses a case whose garment the submission plan
// cannot resolve. A reference outside this pool is not resolvable and is not
// "maybe later": it fails.
export const S1_VTO_GARMENT_POOL = Object.freeze([
  'trousers-ordinary.jpg', 'jacket-ordinary.jpg', 'sweater-ordinary.png',
]);

export const SIZING_VTO_AGGREGATE_LIMIT = 'per submitted input, not per aggregate: the VTO aggregate (base photo '
  + 'plus garments) is a separate, unproven quantity recorded as aggregate_submitted_bytes per observation';

// The shape identifiers are reviewed bindings, so they keep their historical
// names even where a name no longer describes the fixture. Saying so here stops a
// reader from taking `large-base-*` as still submitting a large base photo.
export const S1_VTO_SHAPE_NAMING = 'the `large-base-*` shape identifiers are historical names retained for binding '
  + 'stability, not a description of the fixture: every submitted shape uses base-photo-ordinary.jpg, and the only '
  + 'shape that carried the large base photo is the deferred five-garment one';

// Deferred rather than silently dropped: the five-garment shape also carried the
// representative larger 4K output, and its aggregate is the shape most likely to
// reproduce the #140 failure this change is working around. Its garment-only
// bytes are about 79% of the 3,742,711-byte single input whose base64 payload
// exhausted the 60 s budget.
export const S1_DEFERRED_VTO_SHAPE = Object.freeze({
  shape: 'representative-larger-outfit-output',
  garment_count: 5,
  advanced_settings: Object.freeze({ size: '4K' }),
  // The deferred record keeps its own frozen five-garment list verbatim rather
  // than tracking the submitted pool: it is a record of the shape that is NOT
  // submitted, so it must not drift with the pool that is.
  garment_fixtures: Object.freeze([
    'bag-ordinary.jpg', 'shoes-ordinary.jpg', 'trousers-ordinary.jpg',
    'jacket-ordinary.jpg', 'sweater-ordinary.png',
  ]),
  garment_only_bytes: 2_408_024,
  base_photo_bytes: 545_720,
  aggregate_submitted_bytes: 2_953_744,
  reason: 'deferred_to_140',
});

export const S1_INPUT_ENVELOPE = Object.freeze({
  schema_version: 1,
  reference: S1_INPUT_ENVELOPE_REFERENCE.artifact,
  run_url: S1_INPUT_ENVELOPE_REFERENCE.run_url,
  run_id: S1_INPUT_ENVELOPE_REFERENCE.run_id,
  run_attempt: S1_INPUT_ENVELOPE_REFERENCE.run_attempt,
  stage: S1_INPUT_ENVELOPE_REFERENCE.stage,
  e2e_sha: S1_INPUT_ENVELOPE_REFERENCE.e2e_sha,
  workload: S1_INPUT_ENVELOPE_REFERENCE.workload_path,
  input_bytes_max: S1_INPUT_BYTES_MAX,
  input_bytes_max_basis: 'per submitted input; a VTO aggregate is a separate quantity and is not proven by it',
  measured_inputs_basis: S1_INPUT_MEASURED_BASIS,
  largest_served_case_id: 'sequential-ordinary-jpg-1',
  largest_served_bytes: S1_INPUT_BYTES_MAX,
  measured_inputs: S1_INPUT_MEASURED_CASES,
  excluded_fixtures: S1_INPUT_EXCLUDED_FIXTURES,
  excluded_reason: 'deferred to the #140 large-input defect: no case may submit an input above the largest input '
    + 'this deployment is demonstrated to serve',
  vto_aggregate_limit: SIZING_VTO_AGGREGATE_LIMIT,
  vto_shape_naming: S1_VTO_SHAPE_NAMING,
  deferred_vto_shape: S1_DEFERRED_VTO_SHAPE,
  description: 'Largest single inputs a real S1 Beta Qualification run served to a terminal ready state. '
    + 'Larger inputs are excluded rather than assumed to pass: they stay the #140 defect until a run passes at '
    + 'those sizes. VTO aggregates are recorded per observation and remain unproven.',
});

export function assertSizingInputEnvelope(bytes, label, { bound = S1_INPUT_BYTES_MAX } = {}) {
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error(`${label} lacks positive frozen input bytes`);
  if (bytes > bound) {
    throw new Error(`${label} is ${bytes} B, above the demonstrated S1 input envelope of ${bound} B per submitted `
      + `input (${S1_INPUT_ENVELOPE.reference}); a case may not submit an input above the measured envelope`);
  }
  return bytes;
}

// Garment selects are ordered smallest-first so a shape carries the least payload
// it can; a reordered or padded list would raise the aggregate without adding
// coverage. The select is drawn from `S1_VTO_GARMENT_POOL`, the resolvable pool.
export function orderedSizingGarments(fixtures, count) {
  if (!Number.isInteger(count) || count < 1 || count > S1_VTO_GARMENT_POOL.length) {
    throw new Error(`A VTO shape may submit between 1 and ${S1_VTO_GARMENT_POOL.length} garments`);
  }
  const ordered = S1_VTO_GARMENT_POOL.map(id => {
    const fixture = fixtures.get(id);
    if (!fixture) throw new Error(`Frozen garment ${id} is missing from the sizing fixture set`);
    return { id, bytes: fixture.bytes };
  });
  const ascending = [...ordered].sort((left, right) => left.bytes - right.bytes);
  if (ordered.some((item, index) => item.id !== ascending[index].id)) {
    throw new Error('Sizing garments must be ordered smallest-first');
  }
  return ordered.slice(0, count);
}

export function vtoAggregateSubmittedBytes(fixtures, baseFixture, garmentIds) {
  const base = fixtures.get(baseFixture);
  if (!base) throw new Error(`VTO base fixture ${baseFixture} is not a frozen fixture`);
  let aggregate = base.bytes;
  for (const id of garmentIds) {
    const garment = fixtures.get(id);
    if (!garment) throw new Error(`VTO garment ${id} is not a frozen fixture`);
    aggregate += garment.bytes;
  }
  return aggregate;
}

export function assertCaseInputsWithinEnvelope(fixtures, inputs, { bound = S1_INPUT_BYTES_MAX } = {}) {
  const excluded = new Set(S1_INPUT_EXCLUDED_FIXTURES.map(fixture => fixture.id));
  for (const input of inputs) {
    // Upload cases name `fixture`; a VTO case submits `base_fixture` plus garments,
    // so the base photo and every garment reference are checked individually.
    const ids = typeof input === 'string'
      ? [input]
      : [input?.fixture, input?.base_fixture, ...(input?.garment_fixtures ?? [])];
    for (const id of ids) {
      if (id === undefined) continue;
      if (typeof id !== 'string' || !id) throw new Error('Sizing case input must name a frozen fixture');
      if (excluded.has(id)) throw new Error(`Sizing case input ${id} is excluded from the demonstrated S1 envelope`);
      const fixture = fixtures.get(id);
      if (!fixture) throw new Error(`Sizing case input ${id} is not a frozen fixture`);
      assertSizingInputEnvelope(fixture.bytes, `Sizing case input ${id}`, { bound });
    }
  }
  return inputs;
}
