import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertE2EExecution } from './execution-guard.mjs';
import { assertEqual, byteHash, canonicalJson, exactKeys, parseStrictJson, requireCommit, requireHash, repositories, validateCompatibility } from './evidence-contract.mjs';

const defaultRoot = fileURLToPath(new URL('..', import.meta.url));
const compatibilityPath = Buffer.from('compatibility.json').toString('base64');
export const SIZING_DEPLOYMENT_FIELDS = Object.freeze(['run_id', 'run_attempt', 'artifact_id', 'record_sha256']);
const git = (root, args, binary = false) => execFileSync('git', ['--no-replace-objects', '-C', root,
  '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', ...args], {
  encoding: binary ? undefined : 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 30_000,
  env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
});
const text = (root, args) => git(root, args).trim();
const blobHash = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const inventoryHash = inventory => byteHash(canonicalJson(inventory.filter(entry => entry.path_base64 !== compatibilityPath)));

function pathBytes(entry) {
  const bytes = Buffer.from(entry.path_base64 ?? '', 'base64');
  if (!bytes.length || bytes.toString('base64') !== entry.path_base64 || bytes.includes(0)
    || bytes[0] === 47 || bytes.toString('utf8').split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('Malformed canonical Git inventory path');
  }
  return bytes;
}

function inventoryAt(root, sha) {
  const raw = git(root, ['ls-tree', '-r', '-z', '--full-tree', sha], true);
  if (!raw.length || raw.at(-1) !== 0) throw new Error('Complete Git source inventory unavailable');
  const inventory = [];
  let start = 0;
  for (let end = 0; end < raw.length; end++) {
    if (raw[end] !== 0) continue;
    const entry = raw.subarray(start, end); start = end + 1;
    const tab = entry.indexOf(9);
    const match = /^(100644|100755|120000|160000) (blob|commit) ([a-f0-9]{40})$/.exec(entry.subarray(0, tab).toString('ascii'));
    if (tab < 0 || !match) throw new Error('Unsupported Git source entry');
    inventory.push({ path_base64: entry.subarray(tab + 1).toString('base64'), mode: match[1], type: match[2], object: match[3] });
  }
  inventory.sort((a, b) => Buffer.compare(pathBytes(a), pathBytes(b)));
  return inventory;
}

function requireRepository(root, expectedSha, { clean = false, origin = false } = {}) {
  if (realpathSync(text(root, ['rev-parse', '--show-toplevel'])) !== realpathSync(root)) throw new Error('Sizing source must be the exact repository root');
  if (text(root, ['for-each-ref', '--format=%(refname)', 'refs/replace'])) throw new Error('Sizing source has Git replacement refs');
  if (origin && ![`https://github.com/${repositories.e2e}`, `https://github.com/${repositories.e2e}.git`].includes(text(root, ['remote', 'get-url', 'origin']))) {
    throw new Error('Unexpected sizing source repository origin');
  }
  if (text(root, ['rev-parse', `${expectedSha}^{commit}`]) !== expectedSha) throw new Error('Actual sizing source commit unavailable');
  if (clean) {
    if (text(root, ['rev-parse', 'HEAD']) !== expectedSha) throw new Error('Sizing checkout differs from actual protected source');
    if (text(root, ['ls-files', '-v']).split('\n').some(line => /^[a-zS]/.test(line))) throw new Error('Sizing source hides changes through Git index flags');
    if (text(root, ['status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none'])) throw new Error('Sizing source has local changes');
    for (const entry of inventoryAt(root, expectedSha)) {
      const name = new TextDecoder('utf-8', { fatal: true }).decode(pathBytes(entry));
      const child = resolve(root, name);
      const stat = lstatSync(child);
      if (entry.type === 'blob') {
        const symbolic = entry.mode === '120000';
        if (stat.isSymbolicLink() !== symbolic || !symbolic && !stat.isFile()) throw new Error('Sizing tracked source file type changed');
        const bytes = symbolic ? readlinkSync(child, { encoding: 'buffer' }) : readFileSync(child);
        if (blobHash(bytes) !== entry.object || !symbolic && process.platform !== 'win32'
          && Boolean(stat.mode & 0o111) !== (entry.mode === '100755')) throw new Error('Sizing tracked source bytes/mode changed');
        continue;
      }
      if (lstatSync(child).isSymbolicLink() || !realpathSync(child).startsWith(`${realpathSync(root)}/`)
        && !realpathSync(child).startsWith(`${realpathSync(root)}\\`)) throw new Error('Sizing submodule must be an initialized contained repository');
      requireRepository(child, entry.object, { clean: true });
    }
  }
}

export function reconstructSizingSource(root, expectedSha) {
  requireCommit(expectedSha, 'Actual E2E source');
  requireRepository(root, expectedSha, { origin: true });
  const inventory = inventoryAt(root, expectedSha);
  const entry = inventory.find(item => item.path_base64 === compatibilityPath);
  if (!entry || entry.mode !== '100644' || entry.type !== 'blob') throw new Error('Tracked regular compatibility.json is required');
  const bytes = git(root, ['cat-file', 'blob', entry.object], true);
  const compatibility = validateCompatibility(parseStrictJson(bytes));
  return { schema_version: 1, repository: repositories.e2e, e2e_sha: expectedSha,
    tree_sha: text(root, ['rev-parse', `${expectedSha}^{tree}`]), inventory,
    benchmark_source_sha256: inventoryHash(inventory), compatibility_blob: entry.object,
    compatibility_bytes_base64: bytes.toString('base64'), compatibility_sha256: byteHash(bytes), compatibility };
}

export function validateSizingSource(proof, { e2eSha, runId, runAttempt, compatibility } = {}) {
  exactKeys(proof, ['schema_version', 'repository', 'e2e_sha', 'tree_sha', 'inventory', 'benchmark_source_sha256',
    'compatibility_blob', 'compatibility_bytes_base64', 'compatibility_sha256', 'compatibility', 'run_id', 'run_attempt'], 'Sizing source proof');
  if (proof.schema_version !== 1 || proof.repository !== repositories.e2e || proof.e2e_sha !== e2eSha
    || proof.run_id !== runId || proof.run_attempt !== runAttempt
    || !/^[1-9]\d*$/.test(proof.run_id) || !/^[1-9]\d*$/.test(proof.run_attempt)
    || !Number.isSafeInteger(Number(proof.run_id)) || !Number.isSafeInteger(Number(proof.run_attempt))) throw new Error('Sizing proof actual run/source binding mismatch');
  for (const field of ['e2e_sha', 'tree_sha', 'compatibility_blob']) requireCommit(proof[field], `Sizing proof ${field}`);
  requireHash(proof.benchmark_source_sha256, 'Complete benchmark source digest');
  requireHash(proof.compatibility_sha256, 'Compatibility byte digest');
  if (!Array.isArray(proof.inventory) || proof.inventory.length < 2) throw new Error('Complete sizing source inventory required');
  let previous;
  for (const entry of proof.inventory) {
    exactKeys(entry, ['path_base64', 'mode', 'type', 'object'], 'Sizing inventory entry');
    const path = pathBytes(entry);
    if (previous && Buffer.compare(previous, path) >= 0) throw new Error('Sizing inventory must have unique canonical path ordering');
    previous = path;
    if (!['100644', '100755', '120000', '160000'].includes(entry.mode)
      || entry.type !== (entry.mode === '160000' ? 'commit' : 'blob')) throw new Error('Sizing inventory mode/type mismatch');
    requireCommit(entry.object, 'Sizing inventory object');
  }
  const entry = proof.inventory.find(item => item.path_base64 === compatibilityPath);
  if (!entry || entry.type !== 'blob' || entry.mode !== '100644' || entry.object !== proof.compatibility_blob
    || inventoryHash(proof.inventory) !== proof.benchmark_source_sha256) throw new Error('Complete sizing source inventory binding mismatch');
  const bytes = Buffer.from(proof.compatibility_bytes_base64 ?? '', 'base64');
  if (bytes.toString('base64') !== proof.compatibility_bytes_base64 || byteHash(bytes) !== proof.compatibility_sha256
    || blobHash(bytes) !== proof.compatibility_blob) throw new Error('Compatibility source blob/byte binding mismatch');
  validateCompatibility(proof.compatibility);
  assertEqual(parseStrictJson(bytes), proof.compatibility, 'Committed compatibility bytes');
  if (compatibility) assertEqual(proof.compatibility, compatibility, 'Actual deployment compatibility');
  return true;
}

export function captureSizingSource(environment = process.env, { root = defaultRoot } = {}) {
  const sha = text(root, ['rev-parse', 'HEAD']);
  assertE2EExecution(environment, { sourceSha: sha });
  if (environment.GITHUB_WORKFLOW_REF !== `${repositories.e2e}/.github/workflows/beta-qualification.yml@refs/heads/main`) throw new Error('Sizing source requires protected qualification workflow');
  requireRepository(root, sha, { clean: true, origin: true });
  const proof = { ...reconstructSizingSource(root, sha), run_id: environment.GITHUB_RUN_ID, run_attempt: environment.GITHUB_RUN_ATTEMPT };
  if (!lstatSync(resolve(root, 'compatibility.json')).isFile()
    || byteHash(readFileSync(resolve(root, 'compatibility.json'))) !== proof.compatibility_sha256) throw new Error('Sizing compatibility checkout bytes changed');
  validateSizingSource(proof, { e2eSha: sha, runId: proof.run_id, runAttempt: proof.run_attempt });
  return proof;
}

// This verifies commit contents, not GitHub run/artifact authenticity. Acceptance
// also requires independent authentication of those native records.
export function verifySizingSourceAtCommit(proof, { root = defaultRoot, expectedSha } = {}) {
  validateSizingSource(proof, { e2eSha: expectedSha, runId: proof.run_id, runAttempt: proof.run_attempt });
  const source = { ...proof }; delete source.run_id; delete source.run_attempt;
  assertEqual(source, reconstructSizingSource(root, expectedSha), 'Trusted actual E2E commit inventory');
  return true;
}

export function assertSizingSourceRun(proof, trustedRun) {
  if (!trustedRun || trustedRun.repository?.full_name !== repositories.e2e
    || trustedRun.path !== '.github/workflows/beta-qualification.yml' || trustedRun.head_branch !== 'main'
    || trustedRun.event !== 'workflow_dispatch' || trustedRun.status !== 'completed' || trustedRun.conclusion !== 'success'
    || trustedRun.head_sha !== proof?.e2e_sha || String(trustedRun.id) !== proof?.run_id
    || String(trustedRun.run_attempt) !== proof?.run_attempt) throw new Error('Native completed-success qualification run/source binding required');
  validateSizingSource(proof, { e2eSha: trustedRun.head_sha, runId: String(trustedRun.id), runAttempt: String(trustedRun.run_attempt) });
  return true;
}

export function assertSizingCompatibilityEqual(candidate, baseline) {
  const normalized = input => {
    validateCompatibility(input);
    const value = structuredClone(input);
    for (const field of SIZING_DEPLOYMENT_FIELDS) delete value.deployment[field];
    return value;
  };
  assertEqual(normalized(candidate), normalized(baseline), 'S1 strict compatibility outside four deployment record fields');
  return true;
}
