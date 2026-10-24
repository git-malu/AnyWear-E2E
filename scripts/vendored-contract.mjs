// Loader assertion for the vendored Infra contract.
//
// The vendored files are ordinary AnyWear-Infra source pinned by commit, not a
// published artifact. This assertion is the seam that keeps them from silently
// drifting: it names the exact producer commit, requires a producer path for every
// vendored file, hashes every vendored module, and for a file that carries a
// declared import rewrite it reconstructs the raw producer bytes, hashes those too,
// and refuses any difference the declaration does not explain. A provenance that
// still declares a package, or that declares producer bytes with an empty rewrite
// list, is refused outright. It checks repository identity and file bytes only; it
// does not fetch the producer, prove its review status or authorize deployment.
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { byteHash } from './evidence-contract.mjs';

const defaultRoot = new URL('./vendor/', import.meta.url);
const HASH = /^[0-9a-f]{64}$/;

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function requireHash(value, label) {
  if (typeof value !== 'string' || !HASH.test(value)) throw new Error(`${label} is malformed`);
  return value;
}

export async function loadVendoredProvenance({ root = defaultRoot } = {}) {
  const provenance = JSON.parse(await readFile(new URL('provenance.json', root), 'utf8'));
  if (provenance.source_repository !== 'git-malu/AnyWear-Infra') throw new Error('Vendored contract source repository is unexpected');
  if (typeof provenance.source_sha !== 'string' || !/^[0-9a-f]{40}$/.test(provenance.source_sha)) throw new Error('Vendored contract source SHA is malformed');
  // The producer is ordinary source: there is no packed or published artifact left to
  // pin. A `package` block would describe the retired artifact, so refuse it and name
  // the artifact the block still claims.
  if (hasOwn(provenance, 'package')) {
    const declared = isObject(provenance.package) ? provenance.package : {};
    const artifact = typeof declared.name === 'string'
      ? `${declared.name}${typeof declared.version === 'string' ? `@${declared.version}` : ''}`
      : 'an unnamed package artifact';
    throw new Error(`Vendored contract provenance declares a package block for the retired artifact ${artifact}; vendored files are ordinary producer source named by producer_paths`);
  }
  return provenance;
}

// Every vendored file names the producer path it was copied from, and the map is
// exactly the vendored set: a file with no producer path is a copy nobody can
// re-derive, and a path with no file is a stale claim.
function validateProducerPaths(provenance, expected) {
  if (!isObject(provenance.producer_paths)) throw new Error('Vendored contract producer_paths is malformed');
  const declared = Object.keys(provenance.producer_paths).sort();
  const missing = expected.filter((name) => !hasOwn(provenance.producer_paths, name));
  if (missing.length > 0) {
    throw new Error(`Vendored contract producer_paths must cover exactly the files key set (missing ${missing.join(', ')}; expected ${expected.join(', ')})`);
  }
  const extra = declared.filter((name) => !expected.includes(name));
  if (extra.length > 0) {
    throw new Error(`Vendored contract producer_paths names files that are not vendored (${extra.join(', ')}; expected ${expected.join(', ')})`);
  }
  for (const name of expected) {
    const producerPath = provenance.producer_paths[name];
    if (typeof producerPath !== 'string' || producerPath.length === 0) {
      throw new Error(`Vendored contract producer path for ${name} is malformed`);
    }
  }
}

// One declared rewrite is one exact textual substitution. Both halves are
// non-empty and distinct; the batch is applied in order, so each one must be
// unambiguous in the text it reads.
function validateImportRewrites(name, rewrites) {
  if (!Array.isArray(rewrites)) throw new Error(`Vendored contract import rewrite set for ${name} is malformed`);
  return rewrites.map((rewrite) => {
    if (!isObject(rewrite) || Object.keys(rewrite).sort().join(',') !== 'from,to'
      || typeof rewrite.from !== 'string' || typeof rewrite.to !== 'string'
      || rewrite.from.length === 0 || rewrite.to.length === 0 || rewrite.from === rewrite.to) {
      throw new Error(`Vendored contract import rewrite for ${name} is malformed`);
    }
    return rewrite;
  });
}

function applyImportRewrites(name, text, rewrites, sourceKey, targetKey) {
  let rewritten = text;
  for (const rewrite of rewrites) {
    const source = rewrite[sourceKey];
    if (rewritten.split(source).length !== 2) {
      throw new Error(`Vendored contract import rewrite for ${name} is not applied exactly once`);
    }
    rewritten = rewritten.replace(source, rewrite[targetKey]);
  }
  return rewritten;
}

// Reconstruct the raw producer bytes by reversing exactly the declared rewrites,
// then assert the producer hash and re-apply the declaration forward. A committed
// file that differs from the producer by anything undeclared fails the hash; a
// declared rewrite that no longer appears fails its one-occurrence check.
function assertProducerBytes(name, committed, provenance) {
  const producerHash = requireHash(provenance.producer_files[name], `Vendored contract producer hash for ${name}`);
  if (!isObject(provenance.import_rewrites) || !hasOwn(provenance.import_rewrites, name)) {
    throw new Error(`Vendored contract producer file ${name} has no declared import rewrite for its producer copy`);
  }
  const rewrites = validateImportRewrites(name, provenance.import_rewrites[name]);
  const committedText = committed.toString('utf8');
  const producerText = applyImportRewrites(name, committedText, rewrites, 'to', 'from');
  const producer = Buffer.from(producerText, 'utf8');
  const actual = byteHash(producer);
  if (actual !== producerHash) {
    throw new Error(`Vendored contract ${name} differs from its raw ${provenance.source_repository}@${provenance.source_sha} producer bytes beyond the declared import rewrites (${actual})`);
  }
  const forwarded = Buffer.from(applyImportRewrites(name, producerText, rewrites, 'from', 'to'), 'utf8');
  if (!forwarded.equals(committed)) throw new Error(`Vendored contract ${name} contains an undeclared rewrite`);
  return producer;
}

export async function assertVendoredProvenance({ root = defaultRoot } = {}) {
  const provenance = await loadVendoredProvenance({ root });
  const expected = Object.keys(provenance.files).sort();
  const present = (await readdir(root)).filter((name) => name.endsWith('.mjs')).sort();
  if (JSON.stringify(present) !== JSON.stringify(expected)) {
    throw new Error(`Vendored contract file set differs from provenance (present ${present.join(', ')}; expected ${expected.join(', ')})`);
  }
  validateProducerPaths(provenance, expected);
  const producerFiles = provenance.producer_files;
  const rewrites = provenance.import_rewrites;
  if ((producerFiles === undefined) !== (rewrites === undefined)
    || (producerFiles !== undefined && (!isObject(producerFiles) || !isObject(rewrites)))) {
    throw new Error('Vendored contract producer rewrite declarations are malformed');
  }
  if (producerFiles !== undefined) {
    for (const name of Object.keys(producerFiles)) {
      if (!hasOwn(rewrites, name)) {
        throw new Error(`Vendored contract producer file ${name} has no declared import rewrite`);
      }
      // Producer bytes are only trustworthy when a declared rewrite explains why the
      // committed copy differs from them; an empty list would make the "reversal"
      // vacuous and let a hand-edited byte copy pass as producer output.
      if (!Array.isArray(rewrites[name]) || rewrites[name].length === 0) {
        throw new Error(`Vendored contract ${name} declares producer bytes with an empty import rewrite list; an empty rewrite list with producer bytes is refused`);
      }
    }
    for (const name of Object.keys(rewrites)) {
      if (!hasOwn(producerFiles, name)) throw new Error(`Vendored contract import rewrite for ${name} is undeclared in producer_files`);
    }
  }
  for (const name of expected) {
    const expectedHash = requireHash(provenance.files[name], `Vendored contract hash for ${name}`);
    const bytes = await readFile(new URL(name, root));
    const actual = byteHash(bytes);
    if (actual !== expectedHash) throw new Error(`Vendored contract ${name} differs from ${provenance.source_repository}@${provenance.source_sha} (${actual})`);
    if (producerFiles !== undefined && hasOwn(producerFiles, name)) assertProducerBytes(name, bytes, provenance);
  }
  return provenance;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const provenance = await assertVendoredProvenance();
  console.log(`Vendored contract matches ${provenance.source_repository}@${provenance.source_sha}: ${Object.keys(provenance.files).sort().join(', ')}`);
}
