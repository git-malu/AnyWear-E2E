import { crc32, inflateRawSync } from 'node:zlib';

// A strict minimal ZIP reader (#228). The drift gate downloads GitHub artifact ZIPs and
// must extract one JSON entry from them without trusting the archive: only store and
// deflate entries via `node:zlib`, CRC-32 verification, bounded entry count/name/size,
// and refusal of encryption, ZIP64, unsafe entry names and structural lies. No new
// runtime dependency enters `package.json` for this; `@actions/artifact` stays an unused
// devDependency.
//
// Entry name safety is the extraction contract: an entry name must be a plain relative
// POSIX path with no parent-directory traversal, no absolute path, no drive letter and
// no backslash, so a hostile archive cannot escape the caller's entry selection.

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const ZIP64_EOCD_LOCATOR = Buffer.from([0x50, 0x4b, 0x06, 0x07]);

export const DEFAULT_ENTRY_LIMIT = 64;
export const DEFAULT_ENTRY_NAME_LIMIT = 256;
export const DEFAULT_ENTRY_SIZE_LIMIT = 10 * 1024 * 1024;
export const DEFAULT_ZIP_SIZE_LIMIT = 64 * 1024 * 1024;

const readU16 = (buffer, offset) => buffer.readUInt16LE(offset);
const readU32 = (buffer, offset) => buffer.readUInt32LE(offset);

// The end-of-central-directory record sits at most 22 + 65535 bytes from the end, after
// the optional comment. Only an offset whose structure validates is accepted, so a
// signature-shaped byte run inside the comment cannot be mistaken for the record.
function findEocd(buffer) {
  const minimum = Math.max(0, buffer.length - 22 - 65535);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (readU32(buffer, offset) !== EOCD_SIGNATURE) continue;
    const commentLength = readU16(buffer, offset + 20);
    if (offset + 22 + commentLength !== buffer.length) continue;
    if (readU16(buffer, offset + 4) !== 0 || readU16(buffer, offset + 6) !== 0) continue;
    if (readU16(buffer, offset + 8) !== readU16(buffer, offset + 10)) continue;
    return offset;
  }
  return -1;
}

function assertSafeEntryName(name) {
  if (typeof name !== 'string' || name.length === 0) throw new Error('ZIP entry name is empty');
  if (name.includes('\0')) throw new Error(`ZIP entry ${name} name contains a NUL byte`);
  if (name.includes('\\')) throw new Error(`ZIP entry ${name} name contains a backslash`);
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) throw new Error(`ZIP entry ${name} name is absolute`);
  if (name.split('/').includes('..')) throw new Error(`ZIP entry ${name} name traverses a parent directory`);
}

// Parse the whole archive and return one `{name, data}` row per entry. Every structural
// check is a refusal: a hostile archive is never partially accepted.
export function readArtifactZip(zipBytes, {
  entryLimit = DEFAULT_ENTRY_LIMIT,
  entryNameLimit = DEFAULT_ENTRY_NAME_LIMIT,
  entrySizeLimit = DEFAULT_ENTRY_SIZE_LIMIT,
  zipSizeLimit = DEFAULT_ZIP_SIZE_LIMIT,
} = {}) {
  const buffer = Buffer.isBuffer(zipBytes) ? zipBytes : Buffer.from(zipBytes);
  if (buffer.length > zipSizeLimit) {
    throw new Error(`ZIP input exceeds the ${zipSizeLimit}-byte size limit`);
  }
  if (buffer.includes(ZIP64_EOCD_LOCATOR)) {
    throw new Error('ZIP64 archives are not accepted');
  }
  const eocd = findEocd(buffer);
  if (eocd < 0) throw new Error('ZIP end-of-central-directory record missing');
  const entryCount = readU16(buffer, eocd + 8);
  if (entryCount === 0) throw new Error('ZIP contains no entries');
  if (entryCount > entryLimit) {
    throw new Error(`ZIP contains ${entryCount} entries; the bound is ${entryLimit}`);
  }
  const cdSize = readU32(buffer, eocd + 12);
  const cdOffset = readU32(buffer, eocd + 16);
  if (cdOffset + cdSize > eocd) throw new Error('ZIP central directory is out of bounds');

  const entries = [];
  let cursor = cdOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (readU32(buffer, cursor) !== CENTRAL_SIGNATURE) {
      throw new Error('ZIP central directory entry signature is missing');
    }
    const entry = {
      versionNeeded: readU16(buffer, cursor + 6),
      flags: readU16(buffer, cursor + 8),
      method: readU16(buffer, cursor + 10),
      crc: readU32(buffer, cursor + 16),
      compressedSize: readU32(buffer, cursor + 20),
      uncompressedSize: readU32(buffer, cursor + 24),
      nameLength: readU16(buffer, cursor + 28),
      extraLength: readU16(buffer, cursor + 30),
      commentLength: readU16(buffer, cursor + 32),
      localOffset: readU32(buffer, cursor + 42),
    };
    entry.name = buffer.toString('utf8', cursor + 46, cursor + 46 + entry.nameLength);
    entries.push(entry);
    cursor += 46 + entry.nameLength + entry.extraLength + entry.commentLength;
  }
  if (cursor !== cdOffset + cdSize) throw new Error('ZIP central directory size mismatch');

  const seenNames = new Set();
  const extracted = [];
  for (const entry of entries) {
    if (entry.versionNeeded >= 45 || entry.compressedSize === 0xffffffff || entry.uncompressedSize === 0xffffffff) {
      throw new Error(`ZIP entry ${entry.name} requires ZIP64, which is not accepted`);
    }
    if ((entry.flags & 0x1) !== 0) throw new Error(`ZIP entry ${entry.name} is encrypted`);
    if (entry.method !== 0 && entry.method !== 8) {
      throw new Error(`ZIP entry ${entry.name} uses unsupported compression method ${entry.method}`);
    }
    if (entry.nameLength > entryNameLimit) {
      throw new Error(`ZIP entry name length ${entry.nameLength} exceeds the ${entryNameLimit}-byte bound`);
    }
    assertSafeEntryName(entry.name);
    if (seenNames.has(entry.name)) throw new Error(`ZIP entry ${entry.name} is duplicated`);
    seenNames.add(entry.name);
    if (entry.uncompressedSize > entrySizeLimit) {
      throw new Error(`ZIP entry ${entry.name} uncompressed size ${entry.uncompressedSize} exceeds the ${entrySizeLimit}-byte bound`);
    }
    if (entry.localOffset + 30 > buffer.length) throw new Error(`ZIP entry ${entry.name} local header is out of bounds`);
    if (readU32(buffer, entry.localOffset) !== LOCAL_SIGNATURE) {
      throw new Error(`ZIP entry ${entry.name} is missing its local header`);
    }
    const localNameLength = readU16(buffer, entry.localOffset + 26);
    const localExtraLength = readU16(buffer, entry.localOffset + 28);
    const dataStart = entry.localOffset + 30 + localNameLength + localExtraLength;
    const localName = buffer.toString('utf8', entry.localOffset + 30, entry.localOffset + 30 + localNameLength);
    if (localName !== entry.name) throw new Error(`ZIP entry ${entry.name} local header name differs`);
    if (dataStart + entry.compressedSize > buffer.length) throw new Error(`ZIP entry ${entry.name} data is out of bounds`);
    const compressed = buffer.subarray(dataStart, dataStart + entry.compressedSize);
    let data;
    try {
      data = entry.method === 8 ? inflateRawSync(compressed) : Buffer.from(compressed);
    } catch (error) {
      throw new Error(`ZIP entry ${entry.name} cannot be inflated (${error.message})`, { cause: error });
    }
    if (data.length !== entry.uncompressedSize) {
      throw new Error(`ZIP entry ${entry.name} inflated size ${data.length} differs from its declared ${entry.uncompressedSize}`);
    }
    if ((crc32(data) >>> 0) !== entry.crc) throw new Error(`ZIP entry ${entry.name} CRC-32 mismatch`);
    extracted.push({ name: entry.name, data });
  }
  return extracted;
}

// The drift gate's extraction: exactly one entry with the reviewed name.
export function extractArtifactEntry(zipBytes, name, options) {
  const matches = readArtifactZip(zipBytes, options).filter((entry) => entry.name === name);
  if (matches.length !== 1) {
    throw new Error(`Artifact ZIP must contain exactly one ${name} entry (found ${matches.length})`);
  }
  return matches[0].data;
}
