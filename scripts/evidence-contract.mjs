import { createHash } from 'node:crypto';

export const repositories = Object.freeze({
  client: 'git-malu/AnyWear-Client',
  service: 'git-malu/AnyWear-Service',
  infra: 'git-malu/AnyWear-Infra',
  e2e: 'git-malu/AnyWear-E2E',
});

// Declared identity for the owning account and its repositories. Workflow-run
// and artifact checks read the owner identity from the API response and compare
// it with these values; nothing here is inferred from a filesystem path or
// supplied by an unowned environment secret.
export const owner = Object.freeze({ login: 'git-malu', id: 11473072 });
export const repositoryIds = Object.freeze({
  [repositories.client]: 1176104200,
  [repositories.service]: 1158460323,
  [repositories.infra]: 1409047265,
  [repositories.e2e]: 1317091305,
});

export function requireRepository(repository, label) {
  if (!Object.hasOwn(repositoryIds, repository)) throw new Error(`${label} is not a known AnyWear repository`);
  return repository;
}

// The GitHub API exposes the owning account only as the `owner` object on
// the repository itself, alongside many unrelated repository and owner fields.
// Read the identity fields this contract depends on so a renamed, forked or
// foreign owner is rejected instead of silently compared or dereferenced.
export function requireOwnedRepository(value, repository, label) {
  requireRepository(repository, label);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} is missing`);
  if (!value.owner || typeof value.owner !== 'object' || Array.isArray(value.owner)) throw new Error(`${label} owner is required`);
  if (value.full_name !== repository || value.id !== repositoryIds[repository]
    || value.owner.login !== owner.login || value.owner.id !== owner.id
    || value.fork !== false) {
    throw new Error(`${label} is not the protected ${owner.login} repository`);
  }
  return value;
}

export function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is required`);
  return value;
}

export function requireMatch(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`${label} is malformed`);
  return value;
}

export const requireCommit = (value, label) => requireMatch(value, /^[0-9a-f]{40}$/, label);
export const requireHash = (value, label) => requireMatch(value, /^[0-9a-f]{64}$/, label);
export const requireImageDigest = (value) => requireMatch(value, /^sha256:[0-9a-f]{64}$/, 'Service image identity');

export function requireId(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}

export function exactKeys(value, required, label, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  for (const key of required) if (!Object.hasOwn(value, key)) throw new Error(`${label}.${key} is required`);
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key)) throw new Error(`${label}.${key} is unknown`);
  }
  return value;
}

export function requireHttpsUrl(value, label) {
  const url = new URL(requireString(value, label));
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error(`${label} must use HTTPS without credentials or fragment`);
  return url.toString().replace(/\/$/, '');
}

// RFC 8785 uses ECMAScript number serialization and UTF-16 key ordering. Invalid
// Unicode and non-finite/undefined values are rejected instead of normalized.
export function canonicalJson(value) {
  if (typeof value === 'string') {
    if (!value.isWellFormed()) throw new Error('JSON contains invalid Unicode');
    return JSON.stringify(value);
  }
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('JSON contains a non-finite number');
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${canonicalJson(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  throw new Error('Value is outside the JSON data model');
}

export const byteHash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const payloadDigest = (payload) => byteHash(canonicalJson(payload));

// JSON.parse silently accepts duplicate keys. Scan the original text, including
// escaped key spellings, before any security-sensitive record is interpreted.
export function parseStrictJson(bytes) {
  const source = Buffer.isBuffer(bytes) ? new TextDecoder('utf-8', { fatal: true }).decode(bytes) : String(bytes);
  if (source.length > 10 * 1024 * 1024) throw new Error('JSON input exceeds the evidence size limit');
  let position = 0;
  const whitespace = () => { while (/[ \t\r\n]/.test(source[position] ?? '') && position < source.length) position++; };
  function string() {
    const start = position++;
    while (position < source.length) {
      const character = source[position++];
      if (character === '\\') position++;
      else if (character === '"') return JSON.parse(source.slice(start, position));
    }
    throw new Error('Unterminated JSON string');
  }
  function value() {
    whitespace();
    if (source[position] === '{') {
      position++;
      const result = {};
      const seen = new Set();
      whitespace();
      if (source[position] === '}') { position++; return result; }
      while (true) {
        whitespace();
        if (source[position] !== '"') throw new Error('JSON object key is invalid');
        const key = string();
        if (seen.has(key)) throw new Error(`Duplicate JSON key: ${key}`);
        seen.add(key);
        whitespace();
        if (source[position++] !== ':') throw new Error('JSON object separator is invalid');
        Object.defineProperty(result, key, { value: value(), enumerable: true, writable: true, configurable: true });
        whitespace();
        const separator = source[position++];
        if (separator === '}') return result;
        if (separator !== ',') throw new Error('JSON object separator is invalid');
      }
    }
    if (source[position] === '[') {
      position++;
      const result = [];
      whitespace();
      if (source[position] === ']') { position++; return result; }
      while (true) {
        result.push(value());
        whitespace();
        const separator = source[position++];
        if (separator === ']') return result;
        if (separator !== ',') throw new Error('JSON array separator is invalid');
      }
    }
    if (source[position] === '"') return string();
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(source.slice(position))?.[0];
    if (!token) throw new Error('Invalid JSON value');
    position += token.length;
    return JSON.parse(token);
  }
  const parsed = value();
  whitespace();
  if (position !== source.length) throw new Error('Trailing JSON input');
  canonicalJson(parsed);
  return parsed;
}

// Compatibility v3 names two deployment producers. A record identity is either
// deferred (the producer is named, no record is pinned yet) or recorded (the exact
// run/attempt/artifact bytes are pinned). The workflow paths are reviewed here so a
// pin can never name a producer file this repository did not review.
export const PLATFORM_RECORD_WORKFLOW = '.github/workflows/runtime.yml';
export const WORKLOAD_RECORD_WORKFLOW = '.github/workflows/service-artifacts.yml';
export const DEPLOYMENT_RECORD_STATUSES = Object.freeze(['deferred', 'recorded']);
const RECORDED_IDENTITY_KEYS = Object.freeze(['producer', 'workflow_path', 'status', 'run_id', 'run_attempt', 'artifact_id', 'record_sha256']);
const DEFERRED_IDENTITY_KEYS = Object.freeze(['producer', 'workflow_path', 'status', 'reason']);
const producerWorkflows = Object.freeze({
  [repositories.infra]: Object.freeze([PLATFORM_RECORD_WORKFLOW, '.github/workflows/mutate.yml']),
  [repositories.service]: Object.freeze([WORKLOAD_RECORD_WORKFLOW]),
});

export function isDeferredRecord(identity) {
  return identity?.status === 'deferred';
}

// The exact-keys check is the shape authority: a deferred identity may not carry a
// run id and a recorded identity may not carry a reason. `producer` is explicit so a
// record cannot be reinterpreted for another repository after review.
export function validateDeploymentIdentity(value, { label, producer }) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} is required`);
  if (value.producer !== producer) throw new Error(`${label}.producer is not the pinned producer ${producer}`);
  requireMatch(value.workflow_path, /^\.github\/workflows\/[a-z0-9-]+\.yml$/, `${label}.workflow_path`);
  if (!producerWorkflows[producer]?.includes(value.workflow_path)) throw new Error(`${label}.workflow_path is not a reviewed ${producer} producer workflow`);
  if (!DEPLOYMENT_RECORD_STATUSES.includes(value.status)) throw new Error(`${label}.status must be ${DEPLOYMENT_RECORD_STATUSES.join(' or ')}`);
  if (value.status === 'deferred') {
    exactKeys(value, DEFERRED_IDENTITY_KEYS, label);
    if (typeof value.reason !== 'string' || value.reason.trim().length === 0 || value.reason.length > 512) throw new Error(`${label}.reason must be a non-empty bounded string`);
    return value;
  }
  exactKeys(value, RECORDED_IDENTITY_KEYS, label);
  for (const field of ['run_id', 'run_attempt', 'artifact_id']) requireId(value[field], `${label}.${field}`);
  requireHash(value.record_sha256, `${label}.record_sha256`);
  return value;
}

export function validateCompatibility(manifest, { allowLegacy = false } = {}) {
  if (manifest.version !== 3 && !(allowLegacy && (manifest.version === 2 || manifest.version === 1))) {
    throw new Error('Compatibility version must be 3 for qualification; v1 and v2 are historical inputs only');
  }
  if (manifest.version === 1) {
    exactKeys(manifest, ['version', 'client', 'service'], 'compatibility');
    for (const component of ['client', 'service']) requireRepositoryPin(manifest, component);
    return manifest;
  }
  const optionalMembers = manifest.version === 3 ? ['minimum_supported_client'] : [];
  exactKeys(manifest, manifest.version === 2
    ? ['version', 'client', 'service', 'infra', 'service_artifacts', 'deployment']
    : ['version', 'client', 'service', 'infra', 'platform', 'workload', 'deployment', 'service_artifacts'], 'compatibility', optionalMembers);
  // The supported-Client floor is an optional v3 member until the reviewed pin moves after
  // the deployment that first enforces it. It is never accepted on a historical v1/v2 pin.
  if (manifest.version === 3 && manifest.minimum_supported_client !== undefined) {
    exactKeys(manifest.minimum_supported_client, ['version', 'sha'], 'minimum_supported_client');
    if (!Number.isSafeInteger(manifest.minimum_supported_client.version) || manifest.minimum_supported_client.version < 0) {
      throw new Error('minimum_supported_client.version must be a non-negative safe integer');
    }
    requireCommit(manifest.minimum_supported_client.sha, 'minimum_supported_client.sha');
  }
  for (const component of ['client', 'service', 'infra']) requireRepositoryPin(manifest, component);
  const assets = exactKeys(manifest.service_artifacts, ['repository', 'release_id', 'manifest_asset_id', 'manifest_sha256'], 'service_artifacts');
  if (assets.repository !== repositories.service) throw new Error('service_artifacts.repository is unexpected');
  requireId(assets.release_id, 'Service release ID');
  requireId(assets.manifest_asset_id, 'Service manifest asset ID');
  requireHash(assets.manifest_sha256, 'Service manifest checksum');
  if (manifest.version === 2) {
    // Historical v2 pin: one Infra runtime.yml record covering every stack. It stays
    // readable as a previous pin for the strict v2 -> v3 migration, never as a live
    // v3 input.
    const deployment = exactKeys(manifest.deployment, ['repository', 'workflow_path', 'run_id', 'run_attempt', 'artifact_id', 'record_sha256'], 'deployment');
    if (deployment.repository !== repositories.infra) throw new Error('deployment.repository is unexpected');
    if (deployment.workflow_path !== PLATFORM_RECORD_WORKFLOW) throw new Error('deployment.workflow_path is unexpected');
    for (const field of ['run_id', 'run_attempt', 'artifact_id']) requireId(deployment[field], `deployment.${field}`);
    requireHash(deployment.record_sha256, 'Deployment record checksum');
    return manifest;
  }
  const platform = exactKeys(manifest.platform, ['producer', 'producer_sha', 'record'], 'platform');
  const workload = exactKeys(manifest.workload, ['producer', 'producer_sha'], 'workload');
  if (platform.producer !== repositories.infra) throw new Error('platform.producer must be the reviewed Infra repository');
  if (workload.producer !== repositories.service) throw new Error('workload.producer must be the Service release chain repository');
  requireCommit(platform.producer_sha, 'platform.producer_sha');
  requireCommit(workload.producer_sha, 'workload.producer_sha');
  validateDeploymentIdentity(platform.record, { label: 'platform.record', producer: platform.producer });
  const deployment = validateDeploymentIdentity(manifest.deployment, { label: 'deployment', producer: workload.producer });
  if (deployment.producer !== workload.producer) throw new Error('deployment.producer must equal workload.producer');
  return manifest;
}

function requireRepositoryPin(manifest, component) {
  const entry = exactKeys(manifest[component], ['repository', 'sha'], component);
  if (entry.repository !== repositories[component]) throw new Error(`${component}.repository is unexpected`);
  requireCommit(entry.sha, `${component}.sha`);
  return entry;
}

// The first differing path, not just "something differs". The comparison feeds
// deployment identity checks (AnyWear #138), where a refusal has to tell the
// operator which field moved and what the reviewed value was.
function firstDifference(actual, expected, path = '') {
  if (actual === undefined && expected === undefined) return null;
  if (actual === undefined || expected === undefined) return { path: path || '<root>', actual, expected };
  if (canonicalJson(actual) === canonicalJson(expected)) return null;
  const at = path || '<root>';
  if (Array.isArray(actual) && Array.isArray(expected)) {
    for (let index = 0; index < Math.max(actual.length, expected.length); index++) {
      if (index >= actual.length) return { path: `${at}[${index}]`, actual: undefined, expected: expected[index] };
      if (index >= expected.length) return { path: `${at}[${index}]`, actual: actual[index], expected: undefined };
      const child = firstDifference(actual[index], expected[index], `${at}[${index}]`);
      if (child) return child;
    }
  }
  const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
  if (isObject(actual) && isObject(expected)) {
    const keys = [...new Set([...Object.keys(actual), ...Object.keys(expected)])].sort();
    for (const key of keys) {
      const child = firstDifference(actual[key], expected[key], `${at}.${key}`);
      if (child) return child;
    }
  }
  return { path: at, actual, expected };
}

const describeValue = (value) => {
  if (value === undefined) return 'undefined';
  let text;
  try { text = JSON.stringify(value); } catch { text = String(value); }
  if (text === undefined) text = String(value);
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
};

export function assertEqual(actual, expected, label) {
  const difference = firstDifference(actual, expected);
  if (difference) {
    throw new Error(`${label} mismatch at ${difference.path}: expected ${describeValue(difference.expected)}, observed ${describeValue(difference.actual)}`);
  }
  return actual;
}
