import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { SIZING_WORKLOAD } from './beta-sizing-benchmark.mjs';

export const hashBytes = bytes => createHash('sha256').update(bytes).digest('hex');
export const SIZING_PROVIDER_ENVELOPE = Object.freeze({
  schema_version: 1,
  model: 'doubao-seedream-5-0-260128', default_output: '2K', larger_output: '4K',
  output_format: 'png', stream: true, sequential_image_generation: 'disabled', watermark: false,
  supported_input_basis: 'Reviewed Client 10 MiB acceptance plus successful common S1 cases; no product garment-count maximum exists',
  provider_pdf_sha256: '4e025a952a9592d9256418f5bca563f2fec92b80ee92d262a39ffdbd82007465',
  provider_pdf_applicability: '5.0-lite documentation differs from deployed 5.0 model; bounds are provisional until real S1 succeeds',
  fixture_bytes_max: 9_750_000, fixture_pixels_max: 35_000_000,
  larger_outfit_garment_references: 5,
});

export async function loadSizingFixtures(directory) {
  const bytes = await readFile(new URL('fixture-manifest.json', directory));
  const manifest = JSON.parse(bytes);
  if (manifest.schema_version !== 1 || !Array.isArray(manifest.fixtures)) throw new Error('Unsupported sizing fixture manifest');
  const fixtures = new Map();
  for (const fixture of manifest.fixtures) {
    if (!/^[a-z-]+\.(jpg|png|webp)$/.test(fixture.file) || fixture.id !== fixture.file
      || fixtures.has(fixture.id) || !SIZING_WORKLOAD.image_formats.includes(fixture.mime)
      || !Number.isInteger(fixture.bytes) || fixture.bytes <= 0 || fixture.bytes > SIZING_PROVIDER_ENVELOPE.fixture_bytes_max
      || !Number.isInteger(fixture.width) || !Number.isInteger(fixture.height)
      || Math.min(fixture.width, fixture.height) <= 14 || fixture.width * fixture.height > SIZING_PROVIDER_ENVELOPE.fixture_pixels_max
      || Math.max(fixture.width / fixture.height, fixture.height / fixture.width) > 16) throw new Error('Invalid frozen image envelope');
    const data = await readFile(new URL(fixture.file, directory));
    if (hashBytes(data) !== fixture.sha256 || data.length !== fixture.bytes) throw new Error(`Frozen fixture bytes changed: ${fixture.id}`);
    fixtures.set(fixture.id, { ...fixture, data });
  }
  return { fixtures, manifestSha256: hashBytes(bytes), envelopeSha256: hashBytes(JSON.stringify(SIZING_PROVIDER_ENVELOPE)) };
}

export function sizingUploadCases() {
  const cases = [];
  const extraGarments = ['trousers', 'jacket', 'shoes', 'bag'];
  let extra = 0;
  for (const submission of ['sequential', 'burst']) {
    for (const size of ['ordinary', 'near-supported-limit']) {
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
  return cases;
}

export function sizingVtoCases() {
  return [0, 1].flatMap(repeat => SIZING_WORKLOAD.vto_shapes.map((shape, index) => ({
    case_id: `${shape}-${repeat}`, shape,
    base_fixture: shape.startsWith('large-') || index === 4 ? 'base-photo-large.jpg' : 'base-photo-ordinary.jpg',
    garment_count: index < 2 ? 1 : index < 4 ? 3 : 5,
    advanced_settings: index === 4 ? { size: SIZING_PROVIDER_ENVELOPE.larger_output } : undefined,
  })));
}
