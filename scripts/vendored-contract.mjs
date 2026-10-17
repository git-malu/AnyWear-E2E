// Loader assertion for the vendored v3 deployment contract.
//
// The vendored files are exact byte copies of the producer's public contract. This
// assertion is the seam that keeps them from silently drifting: it names the
// exact producer commit and hashes every vendored module before the consumer
// imports its behaviour. It checks repository identity and file bytes only; it
// does not fetch the producer, prove its review status or authorize deployment.
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { byteHash } from './evidence-contract.mjs';

const defaultRoot = new URL('./vendor/', import.meta.url);

export async function loadVendoredProvenance({ root = defaultRoot } = {}) {
  const provenance = JSON.parse(await readFile(new URL('provenance.json', root), 'utf8'));
  if (provenance.source_repository !== 'git-malu/AnyWear-Infra') throw new Error('Vendored contract source repository is unexpected');
  if (typeof provenance.source_sha !== 'string' || !/^[0-9a-f]{40}$/.test(provenance.source_sha)) throw new Error('Vendored contract source SHA is malformed');
  return provenance;
}

export async function assertVendoredProvenance({ root = defaultRoot } = {}) {
  const provenance = await loadVendoredProvenance({ root });
  const expected = Object.keys(provenance.files).sort();
  const present = (await readdir(root)).filter((name) => name.endsWith('.mjs')).sort();
  if (JSON.stringify(present) !== JSON.stringify(expected)) {
    throw new Error(`Vendored contract file set differs from provenance (present ${present.join(', ')}; expected ${expected.join(', ')})`);
  }
  for (const name of expected) {
    const expectedHash = provenance.files[name];
    if (typeof expectedHash !== 'string' || !/^[0-9a-f]{64}$/.test(expectedHash)) throw new Error(`Vendored contract hash for ${name} is malformed`);
    const actual = byteHash(await readFile(new URL(name, root)));
    if (actual !== expectedHash) throw new Error(`Vendored contract ${name} differs from ${provenance.source_repository}@${provenance.source_sha} (${actual})`);
  }
  return provenance;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const provenance = await assertVendoredProvenance();
  console.log(`Vendored contract matches ${provenance.source_repository}@${provenance.source_sha}: ${Object.keys(provenance.files).sort().join(', ')}`);
}
