import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { SIZING_WORKLOAD, sizingUploadCases } from './beta-sizing-benchmark.mjs';
import { S1_INPUT_BYTES_MAX, S1_INPUT_ENVELOPE, S1_INPUT_EXCLUDED_FIXTURES, S1_DEFERRED_VTO_SHAPE,
  S1_VTO_GARMENT_POOL, S1_WIDENING_CANDIDATE, S1_DIAGNOSTIC_PROBE, SIZING_ENVELOPE_MODE_DEMONSTRATED,
  assertCaseInputsWithinEnvelope, assertSizingEnvelopeMode, assertSizingInputEnvelope,
  orderedSizingGarments } from './beta-sizing-envelope.mjs';
export { sizingUploadCases } from './beta-sizing-benchmark.mjs';
// Pass-through of the frozen envelope this workload is built from, so a caller
// reads the bound, the pool and the case set from one module.
export * from './beta-sizing-envelope.mjs';

// The pool: the reviewed garment references, restricted to the formats the VTO
// cases carry - the ordinary JPEGs and the ordinary PNG. The sequential half submits
// six cases over four distinct fixtures; the pool holds three of them, because
// `sweater-ordinary.webp` is the WebP format-coverage fixture rather than a reviewed
// garment reference. The PNG entry is the garment variant
// (`sweater-ordinary-garment.png`, 696,168 B), not the restored exact fixture: the
// sequential PNG case carries the garment variant, so the exact fixture enters the
// run only through the two burst PNG cases. Every pool fixture is submitted by a
// sequential upload case, which runs before the first VTO case, so each garment is
// resolved by the time a VTO case needs it. The fixtures left out are
// `bag-ordinary.jpg` and `shoes-ordinary.jpg`, which ONLY burst uploads carry: those
// uploads launch inside the VTO loop, so they cannot resolve a garment before it is
// needed - that is the shape of the previous five-id list's failure.
// `S1_VTO_GARMENT_POOL` is the value this selection must reproduce; one that names
// anything else, in any other order, is refused. See the README for the reason and
// the accepted coverage trade.
export const VTO_GARMENT_FORMATS = Object.freeze(['image/jpeg', 'image/png']);

// The fixtures the plan submits before the first VTO case in a reviewed garment
// format, in submission order. This is the rule the pool must equal; it needs the
// frozen manifest's mime types, so callers pass them and callers without them fall
// back to the pool's own membership.
export function sequentialGarmentUploads(fixtures, mode = SIZING_ENVELOPE_MODE_DEMONSTRATED) {
  const ordered = [];
  for (const entry of sizingUploadCases(mode)) {
    if (entry.submission !== 'sequential') continue;
    const reviewed = fixtures
      ? VTO_GARMENT_FORMATS.includes(fixtures.get(entry.fixture)?.mime)
      : S1_VTO_GARMENT_POOL.includes(entry.fixture);
    if (!reviewed) continue;
    if (!ordered.includes(entry.fixture)) ordered.push(entry.fixture);
  }
  return ordered;
}

// The constraint that stops a VTO case naming a garment the submission plan cannot
// resolve: it was a five-id list, and the two ids no pre-VTO upload produces were
// the two fixtures only the burst half carries.
export function assertVtoGarmentPoolIsSubmitted(fixtures, mode = SIZING_ENVELOPE_MODE_DEMONSTRATED) {
  const submitted = sequentialGarmentUploads(fixtures, mode);
  if (submitted.join() !== S1_VTO_GARMENT_POOL.join()) {
    throw new Error(`The VTO garment pool ${S1_VTO_GARMENT_POOL.join(', ')} must be the sequential uploads of the `
      + `reviewed garment formats the submission plan resolves before the VTO cases, which are `
      + `${submitted.join(', ')}`);
  }
  return S1_VTO_GARMENT_POOL;
}

// The upload cases that submit the pool, in the pool's smallest-first order. They
// run before the first VTO case, so every garment a VTO case names is a real
// wardrobe item the API resolves and not merely a fixture the plan names. Derived
// from the plan rather than hardcoded, so a plan that stops submitting a pool
// garment fails here by name.
export function sizingVtoGarmentUploadCases(mode = SIZING_ENVELOPE_MODE_DEMONSTRATED) {
  const sequential = sizingUploadCases(mode).filter(item => item.submission === 'sequential');
  return assertVtoGarmentPoolIsSubmitted(undefined, mode).map(fixture => {
    const entry = sequential.find(item => item.fixture === fixture);
    if (!entry) {
      throw new Error(`VTO garment ${fixture} is submitted by no sequential upload case, so no VTO case can `
        + `resolve its wardrobe item before the VTO loop starts`);
    }
    return entry;
  });
}

// Route chosen for this defect: a VTO case resolves its garment ids from the
// frozen case plan built once from the COMPLETE set of fixtures the run submits,
// never from the uploads recorded so far. The plan names every fixture and the
// upload case that produces its wardrobe item, so submission order and VTO order
// are independent: reordering either half cannot make a garment unresolvable, and
// a reference the plan cannot resolve fails here, naming the fixture and the case,
// rather than surfacing as a `false`.
export function createSizingVtoGarmentPlan(mode = SIZING_ENVELOPE_MODE_DEMONSTRATED) {
  const caseIdsByFixture = new Map();
  for (const entry of sizingUploadCases(mode)) {
    const cases = caseIdsByFixture.get(entry.fixture) ?? [];
    cases.push(entry.case_id);
    caseIdsByFixture.set(entry.fixture, cases);
  }
  const plan = {
    schema_version: 1,
    issue: 95,
    pool: [...assertVtoGarmentPoolIsSubmitted(undefined, mode)],
    submitted_fixtures: [...caseIdsByFixture.keys()],
    fixture_case_ids: Object.fromEntries(caseIdsByFixture),
    // Fixture id -> the wardrobe item the plan's upload for that fixture creates,
    // recorded as that upload is submitted. Mapped from the plan, never from the
    // uploads observed so far.
    item_resource_id: new Map(),
    // Reports what is actually missing, so the next occurrence names it instead of
    // surfacing as a bare `false`.
    resolveGarmentId: (caseId, fixture) => {
      const { fixture_case_ids: caseIds, item_resource_id: ids } = plan;
      if (!caseIds[fixture]) {
        throw new Error(`VTO case ${caseId} references garment ${fixture}, which the sizing submission plan does `
          + `not submit; the plan submits ${plan.submitted_fixtures.join(', ')}`);
      }
      if (!ids.has(fixture)) {
        throw new Error(`VTO case ${caseId} cannot resolve garment ${fixture}: its planned upload `
          + `(${caseIds[fixture].join(', ')}) has not been submitted yet`);
      }
      return ids.get(fixture);
    },
  };
  return assertVtoCasesResolvableInPlan(plan);
}

// The focused assertion. Without `requireResolved` it checks the plan itself:
// every garment any VTO case can reference is a fixture the submission plan
// submits. With it, run after the pool's uploads and before the first VTO case, it
// also requires the wardrobe item the plan's upload allocated, so the VTO loop
// never depends on how far the upload half has progressed or on the order it runs
// in. Either way an unresolvable reference fails by name, not as a bare `false`.
export function assertVtoCasesResolvableInPlan(plan, { requireResolved = false } = {}) {
  for (const entry of sizingVtoCases()) {
    for (const fixture of entry.garment_fixtures) {
      if (!plan.pool.includes(fixture)) {
        throw new Error(`VTO case ${entry.case_id} references garment ${fixture}, which the sizing submission plan `
          + `does not submit; the plan submits ${plan.submitted_fixtures.join(', ')}`);
      }
      if (requireResolved) plan.resolveGarmentId(entry.case_id, fixture);
    }
  }
  return plan;
}

const FIXTURE_FILE = /^[a-z-]+\.(jpg|png|webp)$/;
const HASH = /^[a-f0-9]{64}$/;
const EXCLUDED_IDS = new Set(S1_INPUT_EXCLUDED_FIXTURES.map(fixture => fixture.id));

export const hashBytes = bytes => createHash('sha256').update(bytes).digest('hex');
export const SIZING_PROVIDER_ENVELOPE = Object.freeze({
  schema_version: 1,
  model: 'doubao-seedream-5-0-260128', default_output: '2K', larger_output: '4K',
  output_format: 'png', stream: true, sequential_image_generation: 'disabled', watermark: false,
  supported_input_basis: 'Reviewed Client 10 MiB acceptance plus successful common S1 cases; no product garment-count maximum exists',
  provider_pdf_sha256: '4e025a952a9592d9256418f5bca563f2fec92b80ee92d262a39ffdbd82007465',
  provider_pdf_applicability: `5.0-lite documentation differs from deployed 5.0 model; the measured S1 input envelope is ${S1_INPUT_BYTES_MAX} B`
    + ` (${S1_INPUT_ENVELOPE.reference})`,
  fixture_bytes_max: 9_750_000, fixture_pixels_max: 35_000_000,
  // The product has no garment-count maximum. The submitted shapes stay at one or
  // three references; the five-garment shape is deferred to #172 with the tagging
  // defect's #140 envelope record (S1_DEFERRED_VTO_SHAPE).
  larger_outfit_garment_references: 5,
});

// The manifest's declared envelope mirrors the reviewed constants. The frozen
// fixture bytes decide what a case can submit, so the manifest must state the
// same bound the loader enforces and must carry removed oversized fixtures as
// explicit, non-submittable records. The widening candidate is a separate record:
// it never raises `input_bytes_max`, and its bound, fixture and case IDs are held
// to the module's reviewed values.
function validateDeclaredEnvelope(manifest) {
  const declared = manifest.s1_input_envelope;
  if (!declared) throw new Error('Frozen sizing manifest must declare the demonstrated S1 input envelope');
  for (const field of ['reference', 'run_url', 'stage', 'e2e_sha']) {
    if (declared[field] !== S1_INPUT_ENVELOPE[field]) throw new Error(`Declared sizing input envelope ${field} changed`);
  }
  if (declared.input_bytes_max !== S1_INPUT_BYTES_MAX
    || declared.largest_served_bytes !== S1_INPUT_ENVELOPE.largest_served_bytes) {
    throw new Error('Declared sizing input envelope bound differs from the enforced S1 input bound');
  }
  // The bound is only meaningful with its basis: per submitted input. A manifest
  // that drops that, the measured-inputs basis, the aggregate split or the note on
  // the historical shape names would let a reader take an aggregate as bounded by
  // the same number, or `large-base-*` as still submitting a large base photo.
  if (declared.input_bytes_max_basis !== S1_INPUT_ENVELOPE.input_bytes_max_basis
    || declared.measured_inputs_basis !== S1_INPUT_ENVELOPE.measured_inputs_basis
    || declared.vto_aggregate_limit !== S1_INPUT_ENVELOPE.vto_aggregate_limit
    || declared.vto_shape_naming !== S1_INPUT_ENVELOPE.vto_shape_naming) {
    throw new Error('Declared sizing input envelope must state the per-input basis, the separate VTO aggregate and '
      + 'the historical VTO shape names');
  }
  const candidate = declared.widening_candidate;
  if (!candidate || candidate.bound_bytes !== S1_WIDENING_CANDIDATE.bound_bytes
    || candidate.fixture !== S1_WIDENING_CANDIDATE.fixture
    || candidate.prior_bound_bytes !== S1_WIDENING_CANDIDATE.prior_bound_bytes
    || candidate.authorising_issue !== S1_WIDENING_CANDIDATE.authorising_issue
    || candidate.status !== S1_WIDENING_CANDIDATE.status
    || JSON.stringify(candidate.case_ids) !== JSON.stringify(S1_WIDENING_CANDIDATE.case_ids)) {
    throw new Error('Declared widening candidate must mirror the reviewed bound, fixture, case IDs and status');
  }
  const deferred = declared.deferred_vto_shape;
  const expectedDeferred = S1_DEFERRED_VTO_SHAPE;
  if (!deferred || deferred.shape !== expectedDeferred.shape
    || deferred.garment_count !== expectedDeferred.garment_count
    || deferred.advanced_settings?.size !== expectedDeferred.advanced_settings.size
    || deferred.aggregate_submitted_bytes !== expectedDeferred.aggregate_submitted_bytes
    || deferred.reason !== expectedDeferred.reason
    || JSON.stringify(deferred.garment_fixtures) !== JSON.stringify(expectedDeferred.garment_fixtures)) {
    throw new Error('Declared S1 input envelope must record the deferred VTO shape with its aggregate and reason');
  }
  const excluded = declared.excluded_fixtures;
  if (!Array.isArray(excluded) || excluded.length !== S1_INPUT_EXCLUDED_FIXTURES.length) {
    throw new Error('Declared sizing input envelope must record every excluded oversized fixture');
  }
  for (const [index, fixture] of excluded.entries()) {
    const expected = S1_INPUT_EXCLUDED_FIXTURES[index];
    if (fixture.id !== expected.id || fixture.bytes !== expected.bytes || !HASH.test(fixture.sha256 ?? '')) {
      throw new Error(`Declared excluded sizing fixture ${fixture.id} differs from the reviewed exclusion`);
    }
    if (fixture.bytes <= S1_INPUT_BYTES_MAX || !EXCLUDED_IDS.has(fixture.id)) {
      throw new Error(`Declared excluded sizing fixture ${fixture.id} is not an above-envelope fixture`);
    }
    // Two reviews, two reasons: a fixture above the widening candidate is above the
    // envelope under measurement; one between the demonstrated and candidate bounds
    // is a review choice that must say it is outside the reviewed case matrix. Any
    // other spelling is refused rather than accepted as free text.
    const reviewedReason = fixture.bytes > S1_WIDENING_CANDIDATE.bound_bytes
      ? 'input_bytes_above_envelope' : 'not_in_reviewed_case_matrix';
    if (fixture.reason !== reviewedReason) {
      throw new Error(`Declared excluded sizing fixture ${fixture.id} needs the reviewed reason ${reviewedReason}`);
    }
    if (fixture.reason !== expected.reason) {
      throw new Error(`Declared excluded sizing fixture ${fixture.id} differs from the reviewed exclusion reason`);
    }
  }
}

// The diagnostic probe's manifest record. It is deliberately NOT a frozen fixture:
// its body is invalid by design, so it must never enter the case matrix or the
// frozen-image envelope. The bytes are still bound by size and SHA-256, and its
// truncation property is checked rather than trusted.
function loadDiagnosticProbe(manifest, directory) {
  const declared = manifest.diagnostic;
  if (!declared) throw new Error('Frozen sizing manifest must record the non-qualifying diagnostic probe');
  if (declared.case_id !== S1_DIAGNOSTIC_PROBE.case_id || declared.file !== S1_DIAGNOSTIC_PROBE.fixture
    || declared.mime !== S1_DIAGNOSTIC_PROBE.mime
    || declared.expected_failure_code !== S1_DIAGNOSTIC_PROBE.expected_failure_code
    || declared.qualifying !== false) {
    throw new Error('Declared diagnostic probe differs from the reviewed non-qualifying probe');
  }
  if (!Number.isInteger(declared.bytes) || declared.bytes <= 0 || !HASH.test(declared.sha256 ?? '')) {
    throw new Error('Declared diagnostic probe needs exact size and SHA-256');
  }
  return readFile(new URL(declared.file, directory)).then(data => {
    if (data.length !== declared.bytes || hashBytes(data) !== declared.sha256) {
      throw new Error('Diagnostic probe bytes changed');
    }
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (!data.subarray(0, 8).equals(signature)) throw new Error('Diagnostic probe must carry a valid PNG signature');
    if (data.includes(Buffer.from('IEND'))) throw new Error('Diagnostic probe must be truncated before IEND');
    return { ...declared, data };
  });
}

export async function loadSizingFixtures(directory, mode = SIZING_ENVELOPE_MODE_DEMONSTRATED) {
  assertSizingEnvelopeMode(mode);
  const bytes = await readFile(new URL('fixture-manifest.json', directory));
  const manifest = JSON.parse(bytes);
  if (manifest.schema_version !== 1 || !Array.isArray(manifest.fixtures)) throw new Error('Unsupported sizing fixture manifest');
  validateDeclaredEnvelope(manifest);
  const diagnostic = await loadDiagnosticProbe(manifest, directory);
  const fixtures = new Map();
  for (const fixture of manifest.fixtures) {
    if (!FIXTURE_FILE.test(fixture.file) || fixture.id !== fixture.file
      || fixtures.has(fixture.id) || !SIZING_WORKLOAD.image_formats.includes(fixture.mime)
      || !Number.isInteger(fixture.bytes) || fixture.bytes <= 0 || fixture.bytes > SIZING_PROVIDER_ENVELOPE.fixture_bytes_max
      || !Number.isInteger(fixture.width) || !Number.isInteger(fixture.height)
      || Math.min(fixture.width, fixture.height) <= 14 || fixture.width * fixture.height > SIZING_PROVIDER_ENVELOPE.fixture_pixels_max
      || Math.max(fixture.width / fixture.height, fixture.height / fixture.width) > 16) throw new Error('Invalid frozen image envelope');
    if (EXCLUDED_IDS.has(fixture.id)) throw new Error(`Above-envelope sizing fixture ${fixture.id} must not be frozen for submission`);
    // The restored exact fixture is committed above the demonstrated bound because
    // it is the widening candidate. It may be loaded (so its hash is checked) but
    // only the candidate case IDs can submit it, which
    // `assertCaseInputsWithinEnvelope` enforces below. Every other fixture stays on
    // the demonstrated bound.
    const loadBound = fixture.id === S1_WIDENING_CANDIDATE.fixture
      ? S1_WIDENING_CANDIDATE.bound_bytes : S1_INPUT_BYTES_MAX;
    assertSizingInputEnvelope(fixture.bytes, `Frozen sizing fixture ${fixture.id}`, { bound: loadBound });
    const data = await readFile(new URL(fixture.file, directory));
    if (hashBytes(data) !== fixture.sha256 || data.length !== fixture.bytes) throw new Error(`Frozen fixture bytes changed: ${fixture.id}`);
    fixtures.set(fixture.id, { ...fixture, data });
  }
  assertCaseInputsWithinEnvelope(fixtures, [...sizingUploadCases(mode), ...sizingVtoCases()], { mode });
  // A garment reference outside the pool the submission plan resolves is dead on
  // arrival: no case can name it and no upload yields an id for it. The frozen
  // manifest's own mime types decide it here.
  assertVtoGarmentPoolIsSubmitted(fixtures, mode);
  // A VTO case submits the base photo plus its garment list; each input and the
  // canonical smallest-first order are checked here, where the frozen bytes are.
  for (const entry of sizingVtoCases()) {
    const canonical = orderedSizingGarments(fixtures, entry.garment_count);
    if (entry.garment_fixtures.join() !== canonical.map(item => item.id).join()) {
      throw new Error(`VTO case ${entry.case_id} must submit its garments smallest-first`);
    }
  }
  return { fixtures, manifestSha256: hashBytes(bytes), envelopeSha256: hashBytes(JSON.stringify(SIZING_PROVIDER_ENVELOPE)),
    envelopeMode: mode, diagnostic };
}

// Every VTO generation sends the base photo plus the selected garments. Each of
// those inputs is inside the per-input bound, but the aggregate they add up to is
// a different quantity and stays unproven: no VTO generation has run in this
// workload. Garments are ordered smallest-first so each shape carries the least
// payload it can; the PNG garment is the 696,168-byte garment variant, not the
// exact fixture. The five-garment shape that also carried the representative
// larger 4K output is deferred to #172 with its aggregate recorded in
// `S1_DEFERRED_VTO_SHAPE` rather than silently dropped.
export function sizingVtoCases() {
  return [0, 1].flatMap(repeat => SIZING_WORKLOAD.vto_shapes.map((shape, index) => {
    const garment_count = index < 2 ? 1 : 3;
    return { case_id: `${shape}-${repeat}`, shape, base_fixture: 'base-photo-ordinary.jpg',
      garment_count, garment_fixtures: S1_VTO_GARMENT_POOL.slice(0, garment_count) };
  }));
}
