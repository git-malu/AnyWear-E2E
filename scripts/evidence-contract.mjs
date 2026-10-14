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

export function validateCompatibility(manifest, { allowLegacy = false } = {}) {
  if (manifest.version !== 2 && !(allowLegacy && manifest.version === 1)) throw new Error('Compatibility version must be 2 for Infra qualification');
  const keys = manifest.version === 1 ? ['version', 'client', 'service'] : ['version', 'client', 'service', 'infra', 'service_artifacts', 'deployment'];
  exactKeys(manifest, keys, 'compatibility');
  for (const component of manifest.version === 1 ? ['client', 'service'] : ['client', 'service', 'infra']) {
    const entry = exactKeys(manifest[component], ['repository', 'sha'], component);
    if (entry.repository !== repositories[component]) throw new Error(`${component}.repository is unexpected`);
    requireCommit(entry.sha, `${component}.sha`);
  }
  if (manifest.version === 1) return manifest;
  const assets = exactKeys(manifest.service_artifacts, ['repository', 'release_id', 'manifest_asset_id', 'manifest_sha256'], 'service_artifacts');
  if (assets.repository !== repositories.service) throw new Error('service_artifacts.repository is unexpected');
  requireId(assets.release_id, 'Service release ID');
  requireId(assets.manifest_asset_id, 'Service manifest asset ID');
  requireHash(assets.manifest_sha256, 'Service manifest checksum');
  const deployment = exactKeys(manifest.deployment, ['repository', 'workflow_path', 'run_id', 'run_attempt', 'artifact_id', 'record_sha256'], 'deployment');
  if (deployment.repository !== repositories.infra) throw new Error('deployment.repository is unexpected');
  requireMatch(deployment.workflow_path, /^\.github\/workflows\/[a-z0-9-]+\.yml$/, 'Deployment workflow path');
  for (const field of ['run_id', 'run_attempt', 'artifact_id']) requireId(deployment[field], `deployment.${field}`);
  requireHash(deployment.record_sha256, 'Deployment record checksum');
  return manifest;
}

export function assertEqual(actual, expected, label) {
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error(`${label} mismatch`);
}
