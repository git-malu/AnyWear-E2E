import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { SIZING_WORKLOAD, sizingUploadCases } from './beta-sizing-benchmark.mjs';
import { S1_INPUT_BYTES_MAX, S1_INPUT_ENVELOPE, S1_INPUT_EXCLUDED_FIXTURES, S1_DEFERRED_VTO_SHAPE,
  S1_VTO_GARMENT_ORDER, assertCaseInputsWithinEnvelope, assertSizingInputEnvelope,
  orderedSizingGarments } from './beta-sizing-envelope.mjs';
export { sizingUploadCases } from './beta-sizing-benchmark.mjs';
export { S1_INPUT_BYTES_MAX, S1_INPUT_ENVELOPE, S1_INPUT_EXCLUDED_FIXTURES, S1_DEFERRED_VTO_SHAPE,
  S1_VTO_GARMENT_ORDER, S1_VTO_SHAPE_NAMING, SIZING_VTO_AGGREGATE_LIMIT, orderedSizingGarments,
  vtoAggregateSubmittedBytes } from './beta-sizing-envelope.mjs';

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
  // three references; the five-garment shape is deferred to #140 (S1_DEFERRED_VTO_SHAPE).
  larger_outfit_garment_references: 5,
});

// The manifest's declared envelope mirrors the reviewed constants. The frozen
// fixture bytes decide what a case can submit, so the manifest must state the
// same bound the loader enforces and must carry removed oversized fixtures as
// explicit, non-submittable records.
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
    if (fixture.reason !== expected.reason) throw new Error(`Declared excluded sizing fixture ${fixture.id} needs a review reason`);
  }
}

export async function loadSizingFixtures(directory) {
  const bytes = await readFile(new URL('fixture-manifest.json', directory));
  const manifest = JSON.parse(bytes);
  if (manifest.schema_version !== 1 || !Array.isArray(manifest.fixtures)) throw new Error('Unsupported sizing fixture manifest');
  validateDeclaredEnvelope(manifest);
  const fixtures = new Map();
  for (const fixture of manifest.fixtures) {
    if (!FIXTURE_FILE.test(fixture.file) || fixture.id !== fixture.file
      || fixtures.has(fixture.id) || !SIZING_WORKLOAD.image_formats.includes(fixture.mime)
      || !Number.isInteger(fixture.bytes) || fixture.bytes <= 0 || fixture.bytes > SIZING_PROVIDER_ENVELOPE.fixture_bytes_max
      || !Number.isInteger(fixture.width) || !Number.isInteger(fixture.height)
      || Math.min(fixture.width, fixture.height) <= 14 || fixture.width * fixture.height > SIZING_PROVIDER_ENVELOPE.fixture_pixels_max
      || Math.max(fixture.width / fixture.height, fixture.height / fixture.width) > 16) throw new Error('Invalid frozen image envelope');
    if (EXCLUDED_IDS.has(fixture.id)) throw new Error(`Above-envelope sizing fixture ${fixture.id} must not be frozen for submission`);
    assertSizingInputEnvelope(fixture.bytes, `Frozen sizing fixture ${fixture.id}`);
    const data = await readFile(new URL(fixture.file, directory));
    if (hashBytes(data) !== fixture.sha256 || data.length !== fixture.bytes) throw new Error(`Frozen fixture bytes changed: ${fixture.id}`);
    fixtures.set(fixture.id, { ...fixture, data });
  }
  assertCaseInputsWithinEnvelope(fixtures, [...sizingUploadCases(), ...sizingVtoCases()]);
  // A VTO case submits the base photo plus its garment list; each input and the
  // canonical smallest-first order are checked here, where the frozen bytes are.
  for (const entry of sizingVtoCases()) {
    const canonical = orderedSizingGarments(fixtures, entry.garment_count);
    if (entry.garment_fixtures.join() !== canonical.map(item => item.id).join()) {
      throw new Error(`VTO case ${entry.case_id} must submit its garments smallest-first`);
    }
  }
  return { fixtures, manifestSha256: hashBytes(bytes), envelopeSha256: hashBytes(JSON.stringify(SIZING_PROVIDER_ENVELOPE)) };
}

// Every VTO generation sends the base photo plus the selected garments. Each of
// those inputs is inside the per-input bound, but the aggregate they add up to is
// a different quantity and stays unproven: no VTO generation has run in this
// workload. Garments are ordered smallest-first so each shape carries the least
// payload it can. The five-garment shape that also carried the representative
// larger 4K output is deferred to #140 with its aggregate recorded in
// `S1_DEFERRED_VTO_SHAPE` rather than silently dropped.
export function sizingVtoCases() {
  return [0, 1].flatMap(repeat => SIZING_WORKLOAD.vto_shapes.map((shape, index) => {
    const garment_count = index < 2 ? 1 : 3;
    return { case_id: `${shape}-${repeat}`, shape, base_fixture: 'base-photo-ordinary.jpg',
      garment_count, garment_fixtures: S1_VTO_GARMENT_ORDER.slice(0, garment_count) };
  }));
}
