import assert from 'node:assert/strict';
import test from 'node:test';
import { crc32, deflateRawSync } from 'node:zlib';
import {
  DEFAULT_ENTRY_LIMIT, DEFAULT_ENTRY_NAME_LIMIT, DEFAULT_ENTRY_SIZE_LIMIT, DEFAULT_ZIP_SIZE_LIMIT,
  extractArtifactEntry, readArtifactZip,
} from './artifact-zip.mjs';

// A minimal valid ZIP builder for the hostile-input tests: every entry is written from
// the same little-endian structure the reader parses, so the mutations below are the
// exact bytes an adversary would flip.
function buildZip(entries, { method = 8 } = {}) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const compressed = method === 8 ? deflateRawSync(bytes) : Buffer.from(bytes);
    const crc = crc32(bytes) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBytes, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBytes);
    offset += local.length + nameBytes.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, eocd]);
}

// The central-directory entry offset of one entry name, so a test can flip an exact byte.
function centralEntryOffset(zip, name) {
  const nameBytes = Buffer.from(name, 'utf8');
  for (let offset = 0; offset < zip.length - 46; offset += 1) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) continue;
    const nameLength = zip.readUInt16LE(offset + 28);
    if (zip.subarray(offset + 46, offset + 46 + nameLength).equals(nameBytes)) return offset;
  }
  throw new Error(`entry ${name} not found`);
}

const evidence = () => JSON.stringify({ collected_at: '2026-10-07T00:00:00.000Z', ok: true }, null, 2);
const evidenceZip = () => buildZip([
  { name: 'tested-revisions.txt', data: 'E2E eeeeeee' },
  { name: 'deployment-evidence.json', data: evidence() },
]);

test('extracts a deflated and a stored entry and verifies their content', () => {
  const deflated = readArtifactZip(evidenceZip());
  assert.deepEqual(deflated.map(({ name }) => name), ['tested-revisions.txt', 'deployment-evidence.json']);
  assert.equal(deflated[1].data.toString('utf8'), evidence());
  const stored = buildZip([{ name: 'deployment-evidence.json', data: evidence() }], { method: 0 });
  assert.equal(extractArtifactEntry(stored, 'deployment-evidence.json').toString('utf8'), evidence());
});

test('extractArtifactEntry requires exactly one entry with the reviewed name', () => {
  assert.throws(() => extractArtifactEntry(evidenceZip(), 'other.json'),
    /must contain exactly one other\.json entry \(found 0\)/);
  assert.equal(extractArtifactEntry(evidenceZip(), 'tested-revisions.txt').toString('utf8'), 'E2E eeeeeee');
  const duplicated = buildZip([
    { name: 'deployment-evidence.json', data: evidence() },
    { name: 'deployment-evidence.json', data: '{}' },
  ]);
  assert.throws(() => readArtifactZip(duplicated), /deployment-evidence\.json is duplicated/);
});

test('refuses an encrypted entry', () => {
  const zip = evidenceZip();
  const central = centralEntryOffset(zip, 'deployment-evidence.json');
  zip.writeUInt16LE(zip.readUInt16LE(central + 8) | 0x1, central + 8);
  zip.writeUInt16LE(zip.readUInt16LE(zip.readUInt32LE(central + 42) + 6) | 0x1, zip.readUInt32LE(central + 42) + 6);
  assert.throws(() => readArtifactZip(zip), /deployment-evidence\.json is encrypted/);
});

test('refuses an oversized archive and an oversized entry', () => {
  assert.throws(() => readArtifactZip(evidenceZip(), { zipSizeLimit: 64 }),
    /ZIP input exceeds the 64-byte size limit/);
  const zip = evidenceZip();
  const central = centralEntryOffset(zip, 'deployment-evidence.json');
  zip.writeUInt32LE(DEFAULT_ENTRY_SIZE_LIMIT + 1, central + 24);
  assert.throws(() => readArtifactZip(zip),
    new RegExp(`uncompressed size ${DEFAULT_ENTRY_SIZE_LIMIT + 1} exceeds the`));
});

test('refuses a CRC-32 mismatch and a corrupt deflate stream', () => {
  const zip = evidenceZip();
  const central = centralEntryOffset(zip, 'deployment-evidence.json');
  const dataStart = zip.readUInt32LE(central + 42) + 30 + zip.readUInt16LE(zip.readUInt32LE(central + 42) + 26);
  zip[dataStart] ^= 0xff;
  assert.throws(() => readArtifactZip(zip), /deployment-evidence\.json (CRC-32 mismatch|cannot be inflated)/);
  const truncated = evidenceZip().subarray(0, evidenceZip().length - 10);
  assert.throws(() => readArtifactZip(truncated), /end-of-central-directory record missing/);
});

test('refuses path traversal, absolute and backslash entry names', () => {
  for (const name of ['../deployment-evidence.json', 'a/../../deployment-evidence.json', '/deployment-evidence.json', 'C:deployment-evidence.json', '..\\deployment-evidence.json']) {
    const zip = buildZip([{ name, data: '{}' }]);
    assert.throws(() => readArtifactZip(zip), /traverses a parent directory|is absolute|contains a backslash/, name);
  }
});

test('refuses a ZIP64 archive by signature, version and 32-bit overflow sizes', () => {
  const withLocator = Buffer.concat([evidenceZip(), Buffer.from([0x50, 0x4b, 0x06, 0x07])]);
  assert.throws(() => readArtifactZip(withLocator), /ZIP64 archives are not accepted/);
  const byVersion = evidenceZip();
  const central = centralEntryOffset(byVersion, 'deployment-evidence.json');
  byVersion.writeUInt16LE(45, central + 6);
  assert.throws(() => readArtifactZip(byVersion), /requires ZIP64, which is not accepted/);
  const bySize = evidenceZip();
  const sizeCentral = centralEntryOffset(bySize, 'deployment-evidence.json');
  bySize.writeUInt32LE(0xffffffff, sizeCentral + 24);
  assert.throws(() => readArtifactZip(bySize), /requires ZIP64, which is not accepted/);
});

test('refuses an unsupported compression method and a name/size/entry-count over the bounds', () => {
  const zip = evidenceZip();
  const central = centralEntryOffset(zip, 'deployment-evidence.json');
  zip.writeUInt16LE(9, central + 10);
  assert.throws(() => readArtifactZip(zip), /unsupported compression method 9/);
  assert.throws(() => readArtifactZip(evidenceZip(), { entryNameLimit: 8 }),
    /name length \d+ exceeds the 8-byte bound/);
  const many = buildZip(Array.from({ length: 4 }, (_, index) => ({ name: `e${index}.json`, data: '{}' })));
  assert.throws(() => readArtifactZip(many, { entryLimit: 3 }), /contains 4 entries; the bound is 3/);
  const empty = Buffer.concat([Buffer.alloc(22)]);
  empty.writeUInt32LE(0x06054b50, 0);
  assert.throws(() => readArtifactZip(empty), /contains no entries/);
});

test('refuses a local header that disagrees with the central directory', () => {
  const zip = evidenceZip();
  const central = centralEntryOffset(zip, 'deployment-evidence.json');
  const local = zip.readUInt32LE(central + 42);
  const nameLength = zip.readUInt16LE(local + 26);
  zip.writeUInt8('x'.charCodeAt(0), local + 30 + nameLength - 1);
  assert.throws(() => readArtifactZip(zip), /local header name differs/);
});

test('the default bounds are the reviewed caps', () => {
  assert.equal(DEFAULT_ENTRY_LIMIT, 64);
  assert.equal(DEFAULT_ENTRY_NAME_LIMIT, 256);
  assert.equal(DEFAULT_ENTRY_SIZE_LIMIT, 10 * 1024 * 1024);
  assert.equal(DEFAULT_ZIP_SIZE_LIMIT, 64 * 1024 * 1024);
});
