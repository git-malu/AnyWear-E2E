// The sizing input envelope this deployment is demonstrated to serve.
//
// The bound is measured, not assumed: it is the largest single input a real S1
// measurement run served to a terminal `ready` state - the exact 3,742,711-byte
// PNG that had previously failed. It applies to each SUBMITTED INPUT, which is the
// reading the evidence supports - it was derived from single-image uploads, where
// one input is one provider payload. A VTO generation aggregates a base photo plus
// one or more garments and is a separate quantity; see `SIZING_VTO_AGGREGATE_LIMIT`.
//
// This is a bound on what is submitted, never a relaxation of what must pass: an
// input above the bound is not made passable, it is not submitted until a run
// passes at that size. Inputs above the bound remain the known #140 defect.
export const S1_INPUT_BYTES_MAX = 3_742_711;

export const S1_INPUT_ENVELOPE_REFERENCE = Object.freeze({
  artifact: 'beta-measurement-39529614042-1',
  run_url: 'https://github.com/git-malu/AnyWear-E2E/actions/runs/39529614042',
  run_id: 39529614042,
  run_attempt: 1,
  stage: 'S1',
  e2e_sha: 'b95c55036d81cd284fb6e0ad55c160b7e7c25860',
  workload_path: 'test-results/beta-sizing-workload.json',
});

export const S1_INPUT_MEASURED_BASIS = 'the authorised S1 `measure` run 39529614042 (attempt 1) recorded these '
  + 'fixture bytes, and they are the committed frozen bytes; the envelope is now the demonstrated bound, per '
  + 'submitted input, not a candidate under measurement. A VTO aggregate is a separate quantity that the '
  + 'per-input bound does not bound';

// Inputs this envelope is derived from, exactly as the authorised S1 `measure` run
// reported them. Unlike the earlier historical record, these byte counts are also
// the committed frozen bytes: every fixture below ships at exactly this size, so
// the artifact and the repository agree for all 12 uploads. The two burst PNG
// cases submit the exact fixture at the demonstrated bound; every other case
// submits the ordinary or garment-variant fixture.
export const S1_INPUT_MEASURED_CASES = Object.freeze([
  Object.freeze({ case_id: 'sequential-ordinary-jpg-0', fixture: 'trousers-ordinary.jpg',
    bytes: 388_182, width: 1200, height: 960, terminal_state: 'ready' }),
  Object.freeze({ case_id: 'sequential-ordinary-jpg-1', fixture: 'jacket-ordinary.jpg',
    bytes: 664_453, width: 900, height: 1200, terminal_state: 'ready' }),
  Object.freeze({ case_id: 'sequential-ordinary-png-0', fixture: 'sweater-ordinary-garment.png',
    bytes: 696_168, width: 879, height: 761, terminal_state: 'ready' }),
  Object.freeze({ case_id: 'sequential-ordinary-png-1', fixture: 'sweater-ordinary-garment.png',
    bytes: 696_168, width: 879, height: 761, terminal_state: 'ready' }),
  Object.freeze({ case_id: 'sequential-ordinary-webp-0', fixture: 'sweater-ordinary.webp',
    bytes: 686_274, width: 1200, height: 1039, terminal_state: 'ready' }),
  Object.freeze({ case_id: 'sequential-ordinary-webp-1', fixture: 'sweater-ordinary.webp',
    bytes: 686_274, width: 1200, height: 1039, terminal_state: 'ready' }),
  Object.freeze({ case_id: 'burst-ordinary-jpg-0', fixture: 'shoes-ordinary.jpg',
    bytes: 339_830, width: 1200, height: 800, terminal_state: 'ready' }),
  Object.freeze({ case_id: 'burst-ordinary-jpg-1', fixture: 'bag-ordinary.jpg',
    bytes: 319_391, width: 800, height: 1200, terminal_state: 'ready' }),
  Object.freeze({ case_id: 'burst-ordinary-png-0', fixture: 'sweater-ordinary.png',
    bytes: 3_742_711, width: 1200, height: 1039, terminal_state: 'ready' }),
  Object.freeze({ case_id: 'burst-ordinary-png-1', fixture: 'sweater-ordinary.png',
    bytes: 3_742_711, width: 1200, height: 1039, terminal_state: 'ready' }),
  Object.freeze({ case_id: 'burst-ordinary-webp-0', fixture: 'sweater-ordinary.webp',
    bytes: 686_274, width: 1200, height: 1039, terminal_state: 'ready' }),
  Object.freeze({ case_id: 'burst-ordinary-webp-1', fixture: 'sweater-ordinary.webp',
    bytes: 686_274, width: 1200, height: 1039, terminal_state: 'ready' }),
]);

// The VTO observations the same authorised S1 `measure` run recorded, in the order
// the artifact reports them: four reviewed shapes, twice each, all terminal
// `Complete`. Each record carries the aggregate it actually submitted. That
// aggregate is a different quantity from the per-input bound and is NOT bounded by
// it, although these observations now demonstrate the two shipped aggregates
// (933,902 B and 2,294,523 B) were served; the bound itself stays per submitted
// input.
export const S1_INPUT_MEASURED_VTO_CASES = Object.freeze([
  Object.freeze({ case_id: 'ordinary-base-one-garment-0', shape: 'ordinary-base-one-garment',
    base_fixture: 'base-photo-ordinary.jpg', garment_count: 1,
    garment_fixtures: Object.freeze(['trousers-ordinary.jpg']),
    aggregate_submitted_bytes: 933_902, terminal_state: 'Complete' }),
  Object.freeze({ case_id: 'large-base-one-garment-0', shape: 'large-base-one-garment',
    base_fixture: 'base-photo-ordinary.jpg', garment_count: 1,
    garment_fixtures: Object.freeze(['trousers-ordinary.jpg']),
    aggregate_submitted_bytes: 933_902, terminal_state: 'Complete' }),
  Object.freeze({ case_id: 'ordinary-base-three-garments-0', shape: 'ordinary-base-three-garments',
    base_fixture: 'base-photo-ordinary.jpg', garment_count: 3,
    garment_fixtures: Object.freeze(['trousers-ordinary.jpg', 'jacket-ordinary.jpg', 'sweater-ordinary-garment.png']),
    aggregate_submitted_bytes: 2_294_523, terminal_state: 'Complete' }),
  Object.freeze({ case_id: 'large-base-three-garments-0', shape: 'large-base-three-garments',
    base_fixture: 'base-photo-ordinary.jpg', garment_count: 3,
    garment_fixtures: Object.freeze(['trousers-ordinary.jpg', 'jacket-ordinary.jpg', 'sweater-ordinary-garment.png']),
    aggregate_submitted_bytes: 2_294_523, terminal_state: 'Complete' }),
  Object.freeze({ case_id: 'ordinary-base-one-garment-1', shape: 'ordinary-base-one-garment',
    base_fixture: 'base-photo-ordinary.jpg', garment_count: 1,
    garment_fixtures: Object.freeze(['trousers-ordinary.jpg']),
    aggregate_submitted_bytes: 933_902, terminal_state: 'Complete' }),
  Object.freeze({ case_id: 'large-base-one-garment-1', shape: 'large-base-one-garment',
    base_fixture: 'base-photo-ordinary.jpg', garment_count: 1,
    garment_fixtures: Object.freeze(['trousers-ordinary.jpg']),
    aggregate_submitted_bytes: 933_902, terminal_state: 'Complete' }),
  Object.freeze({ case_id: 'ordinary-base-three-garments-1', shape: 'ordinary-base-three-garments',
    base_fixture: 'base-photo-ordinary.jpg', garment_count: 3,
    garment_fixtures: Object.freeze(['trousers-ordinary.jpg', 'jacket-ordinary.jpg', 'sweater-ordinary-garment.png']),
    aggregate_submitted_bytes: 2_294_523, terminal_state: 'Complete' }),
  Object.freeze({ case_id: 'large-base-three-garments-1', shape: 'large-base-three-garments',
    base_fixture: 'base-photo-ordinary.jpg', garment_count: 3,
    garment_fixtures: Object.freeze(['trousers-ordinary.jpg', 'jacket-ordinary.jpg', 'sweater-ordinary-garment.png']),
    aggregate_submitted_bytes: 2_294_523, terminal_state: 'Complete' }),
]);

// The promoted widening candidate (#140): the exact fixture whose failed input set
// the previous 697,437 B demonstrated bound, restored at its original bytes. The
// authorised S1 `measure` run submitted it through
// `BETA_SIZING_ENVELOPE_MODE=widening-candidate` and served both burst PNG cases
// to `ready`, so a metadata-only promotion made those bytes the demonstrated bound
// (`S1_INPUT_BYTES_MAX`) and the record now says `demonstrated`. It keeps the
// promotion lineage: the former bound (`prior_bound_bytes`), the fixture, the case
// IDs that re-submit it, and the authorising issue.
//
// The candidate bound now equals the demonstrated bound, so there is no per-case
// allowance left: every submitted input is bounded by the one demonstrated bound
// in both modes. The two modes still exist because the mode selects the
// measurement case matrix - only the two burst PNG cases submit the exact PNG, and
// only in the candidate mode - and the diagnostic probe, which only that mode runs.
export const S1_WIDENING_CANDIDATE = Object.freeze({
  bound_bytes: 3_742_711,
  fixture: 'sweater-ordinary.png',
  case_ids: Object.freeze(['burst-ordinary-png-0', 'burst-ordinary-png-1']),
  prior_bound_bytes: 697_437,
  authorising_issue: 140,
  status: 'demonstrated',
});

// The PNG re-encode that stays inside the demonstrated envelope. It is used by the
// sequential PNG upload cases and by every VTO garment shape, so the VTO aggregate
// keeps its reviewed 2,294,523 B instead of gambling the run on the exact fixture.
export const S1_GARMENT_PNG_FIXTURE = 'sweater-ordinary-garment.png';

// The only two envelope modes. `demonstrated` is the default and is the only mode a
// normal (non-measurement) run may use; `widening-candidate` is accepted only by
// the `measure` operation at stage S1, where the widening evidence is produced.
export const SIZING_ENVELOPE_MODE_DEMONSTRATED = 'demonstrated';
export const SIZING_ENVELOPE_MODE_WIDENING_CANDIDATE = 'widening-candidate';
export const SIZING_ENVELOPE_MODES = Object.freeze([
  SIZING_ENVELOPE_MODE_DEMONSTRATED, SIZING_ENVELOPE_MODE_WIDENING_CANDIDATE,
]);
export const SIZING_ENVELOPE_MODE_ENV = 'BETA_SIZING_ENVELOPE_MODE';

// The non-qualifying diagnostic probe (#140 step 4): a truncated PNG with a valid
// signature and an invalid body. It is submitted only by the measure run in the
// widening-candidate mode, is expected to settle `input_image_decode_failed` in
// ONE execution with ZERO provider calls, and is recorded as `diagnostics.failure_path`
// so the sanitized code is visible in the run's own artifact rather than only in
// CloudWatch. Its expected failure is evidence, not a qualification failure.
export const S1_DIAGNOSTIC_PROBE = Object.freeze({
  case_id: 'diagnostic-truncated-png-0',
  fixture: 'diagnostic/truncated.png',
  mime: 'image/png',
  expected_failure_code: 'input_image_decode_failed',
  expected_executions: 1,
  expected_provider_calls: 0,
  status_when_not_run: 'not_run',
  qualifying: false,
  purpose: 'proves a deterministic input failure settles terminal in one execution with zero provider calls and '
    + 'that its sanitized code reaches the run artifact',
});

// Fixtures deliberately outside the constrained set. They stay excluded, and no
// case may reference them, even now that the demonstrated bound is larger. The
// reason distinguishes the two reviews: a fixture above the demonstrated bound is
// an above-envelope observation, while one below it is simply not in the reviewed
// case matrix and its exclusion is a review choice rather than an above-bound
// observation.
export const S1_INPUT_EXCLUDED_FIXTURES = Object.freeze([
  // Below the demonstrated 3,742,711 B bound, so its exclusion is a review choice
  // rather than an above-envelope observation: it is not in the reviewed case matrix.
  Object.freeze({ id: 'base-photo-large.jpg', bytes: 2_611_145, width: 2124, height: 2940,
    sha256: 'a7b6638f370cf06800211280934da7ccf00d04eac7fb86654fe54b5784c96b46',
    size_class: 'large-base', reason: 'not_in_reviewed_case_matrix' }),
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
// quantity from the per-input bound and is NOT bounded by it, even though the
// authorised `measure` run has now demonstrated it: eight generations, all
// terminal `Complete`, at 933,902 B and 2,294,523 B. Garments are ordered
// smallest-first so each shape carries the least payload it can.
//
// The pool is CONSTRAINED to the garment references the submission plan resolves
// before the VTO cases. It was a five-id list, and only three of those ids survive:
// `bag-ordinary.jpg` and `shoes-ordinary.jpg` are submitted ONLY by burst uploads,
// which launch inside the VTO loop, so no VTO case can resolve them, and
// `sweater-ordinary.webp` is outside the reviewed garment formats. The PNG pool
// garment is the GARMENT VARIANT `sweater-ordinary-garment.png` (696,168 B), not the
// restored exact fixture: the sequential PNG upload case submits the garment variant,
// so the VTO aggregate keeps its reviewed 2,294,523 B while the exact fixture is
// submitted only by the two burst PNG cases. The rule, its reason and the coverage it
// trades away are recorded in the README's "Measured S1 input envelope and its
// limits" section. The workload module refuses a pool that differs from the
// sequential uploads it resolves, and `createSizingVtoGarmentPlan` refuses a case
// whose garment the submission plan cannot resolve. A reference outside this pool is
// not resolvable and is not "maybe later": it fails.
export const S1_VTO_GARMENT_POOL = Object.freeze([
  'trousers-ordinary.jpg', 'jacket-ordinary.jpg', S1_GARMENT_PNG_FIXTURE,
]);

export const SIZING_VTO_AGGREGATE_LIMIT = 'per submitted input, not per aggregate: the VTO aggregate (base photo '
  + 'plus garments) is a separate, measured quantity recorded as aggregate_submitted_bytes per observation, and '
  + 'the per-input bound does not bound it';

// The shape identifiers are reviewed bindings, so they keep their historical
// names even where a name no longer describes the fixture. Saying so here stops a
// reader from taking `large-base-*` as still submitting a large base photo.
export const S1_VTO_SHAPE_NAMING = 'the `large-base-*` shape identifiers are historical names retained for binding '
  + 'stability, not a description of the fixture: every submitted shape uses base-photo-ordinary.jpg, and the only '
  + 'shape that carried the large base photo is the deferred five-garment one';

// Deferred rather than silently dropped: the five-garment shape also carried the
// representative larger 4K output, and its aggregate is the shape most likely to
// reproduce the VTO large-payload failure. Its 2,953,744-byte aggregate is now
// below the promoted 3,742,711-byte per-input bound, so the deferral is not about
// this bound at all: it stays deferred to the VTO base64-payload defect (#172) and
// returns when a run passes with it. Its garment-only bytes are about 79% of the
// 3,742,711-byte single input whose base64 payload exhausted the 60 s budget.
// The PNG reference is the garment variant, so the recorded 2,408,024 B and
// 2,953,744 B stay true now that the exact fixture is restored.
export const S1_DEFERRED_VTO_SHAPE = Object.freeze({
  shape: 'representative-larger-outfit-output',
  garment_count: 5,
  advanced_settings: Object.freeze({ size: '4K' }),
  // The deferred record keeps its own frozen five-garment list verbatim rather
  // than tracking the submitted pool: it is a record of the shape that is NOT
  // submitted, so it must not drift with the pool that is.
  garment_fixtures: Object.freeze([
    'bag-ordinary.jpg', 'shoes-ordinary.jpg', 'trousers-ordinary.jpg',
    'jacket-ordinary.jpg', S1_GARMENT_PNG_FIXTURE,
  ]),
  garment_only_bytes: 2_408_024,
  base_photo_bytes: 545_720,
  aggregate_submitted_bytes: 2_953_744,
  // The VTO payload is the deferred defect (#172), not this tagging-only envelope.
  // This single reviewed value is the only spelling any writer may use.
  reason: 'deferred_to_172_vto_base64_payload',
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
  input_bytes_max_basis: 'per submitted input; a VTO aggregate is a separate measured quantity that this '
    + 'per-input number does not bound',
  measured_inputs_basis: S1_INPUT_MEASURED_BASIS,
  largest_served_case_id: 'burst-ordinary-png-0',
  largest_served_bytes: S1_INPUT_BYTES_MAX,
  measured_inputs: S1_INPUT_MEASURED_CASES,
  measured_vto_cases: S1_INPUT_MEASURED_VTO_CASES,
  excluded_fixtures: S1_INPUT_EXCLUDED_FIXTURES,
  excluded_reason: 'excluded from the reviewed case matrix: inputs above the demonstrated bound stay deferred to '
    + 'the #140 large-input defect until a run passes at those sizes, while a below-bound exclusion is a review '
    + 'choice rather than evidence of failure',
  widening_candidate: S1_WIDENING_CANDIDATE,
  vto_aggregate_limit: SIZING_VTO_AGGREGATE_LIMIT,
  vto_shape_naming: S1_VTO_SHAPE_NAMING,
  deferred_vto_shape: S1_DEFERRED_VTO_SHAPE,
  description: 'The demonstrated S1 input envelope: the largest single input the authorised S1 `measure` run '
    + '39529614042 served to a terminal ready state, now 3,742,711 B per submitted input. The recorded fixture '
    + 'bytes are the committed frozen bytes. Larger inputs are excluded rather than assumed to pass: they stay '
    + 'the #140 defect until a run passes at those sizes. VTO aggregates are recorded per observation and are '
    + 'not bounded by the per-input number.',
});

export function assertSizingInputEnvelope(bytes, label, { bound = S1_INPUT_BYTES_MAX } = {}) {
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error(`${label} lacks positive frozen input bytes`);
  if (bytes > bound) {
    throw new Error(`${label} is ${bytes} B, above the demonstrated S1 input envelope of ${bound} B per submitted `
      + `input (${S1_INPUT_ENVELOPE.reference}); a case may not submit an input above the measured envelope`);
  }
  return bytes;
}

export function assertSizingEnvelopeMode(mode) {
  if (!SIZING_ENVELOPE_MODES.includes(mode)) {
    throw new Error(`Unknown sizing envelope mode ${JSON.stringify(mode)}; expected one of `
      + `${SIZING_ENVELOPE_MODES.join(', ')}`);
  }
  return mode;
}

// The environment default is the conservative mode. A typo is refused rather than
// falling back to a mode the caller did not ask for.
export function resolveSizingEnvelopeMode(value = process.env[SIZING_ENVELOPE_MODE_ENV]) {
  if (value === undefined || value === null || value === '') return SIZING_ENVELOPE_MODE_DEMONSTRATED;
  return assertSizingEnvelopeMode(value);
}

// Only the measurement operation at stage S1 may produce widening evidence. A
// normal run, or a candidate measurement at another stage, is refused before any
// fixture is loaded.
export function assertSizingEnvelopeModeScope(mode, { operation, stage } = {}) {
  assertSizingEnvelopeMode(mode);
  if (mode === SIZING_ENVELOPE_MODE_DEMONSTRATED) return mode;
  if (operation !== 'measure') {
    throw new Error(`The widening-candidate S1 input envelope is only accepted by the measure operation, not `
      + `${JSON.stringify(operation)}`);
  }
  if (stage !== 'S1') {
    throw new Error(`The widening-candidate S1 input envelope is only accepted at stage S1, not ${JSON.stringify(stage)}`);
  }
  return mode;
}

// The workload/plan record of the mode it ran under. The candidate and prior bounds
// travel with the mode as promotion lineage - the candidate bound is now the
// demonstrated bound, and `prior_bound_bytes` is the 697,437 B bound it replaced -
// so a reader never has to infer which bound applied.
export function sizingEnvelopeRecord(mode = SIZING_ENVELOPE_MODE_DEMONSTRATED) {
  assertSizingEnvelopeMode(mode);
  return Object.freeze({
    envelope_mode: mode,
    candidate_bound_bytes: S1_WIDENING_CANDIDATE.bound_bytes,
    prior_bound_bytes: S1_WIDENING_CANDIDATE.prior_bound_bytes,
  });
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

export function assertCaseInputsWithinEnvelope(fixtures, inputs,
  { mode = SIZING_ENVELOPE_MODE_DEMONSTRATED, bound } = {}) {
  // The mode no longer changes the bound - the promoted candidate bound is the
  // demonstrated bound - but it is still validated, because the mode selects the
  // case matrix and a typo must not read as a bound.
  assertSizingEnvelopeMode(mode);
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
