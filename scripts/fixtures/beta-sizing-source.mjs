import { createHash } from 'node:crypto';
import { byteHash, canonicalJson } from '../evidence-contract.mjs';
import { qualificationFixture } from './infra-qualification.mjs';

export function sizingSourceFixture({ e2eSha = 'b'.repeat(40), compatibility = qualificationFixture().compatibility,
  runId = '1', runAttempt = '1' } = {}) {
  const bytes = Buffer.from(`${JSON.stringify(compatibility, null, 2)}\n`);
  const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  const inventory = [{ path_base64: Buffer.from('compatibility.json').toString('base64'), mode: '100644', type: 'blob', object: blob },
    { path_base64: Buffer.from('scripts/benchmark.mjs').toString('base64'), mode: '100644', type: 'blob', object: 'a'.repeat(40) }];
  return { schema_version: 1, repository: 'git-malu/AnyWear-E2E', e2e_sha: e2eSha, tree_sha: 'c'.repeat(40), inventory,
    benchmark_source_sha256: byteHash(canonicalJson(inventory.slice(1))), compatibility_blob: blob,
    compatibility_bytes_base64: bytes.toString('base64'), compatibility_sha256: byteHash(bytes), compatibility,
    run_id: runId, run_attempt: runAttempt };
}
