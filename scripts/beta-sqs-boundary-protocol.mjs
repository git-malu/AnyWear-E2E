import { createHash, KeyObject, verify } from 'node:crypto';

export const BOUNDARY_PRODUCER_SHA = '80bb9deebec57e6c302439c2a6030c1744ef7a9e';
export const BOUNDARY_ACCOUNT = '650880818323';
export const BOUNDARY_REGION = 'ap-east-1';
export const BOUNDARY_QUEUE_ARN = 'arn:aws:sqs:ap-east-1:650880818323:beta-anywear-auto-tagging';
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UUID = /^(?:[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i;
const DIGEST = /^[a-f0-9]{64}$/;
const RUN_SCOPE = /^[1-9][0-9]{0,19}-[1-9][0-9]{0,5}-[a-f0-9]{16}$/;
const WORKER_ARN = /^arn:aws:ecs:ap-east-1:650880818323:task\/[A-Za-z0-9_-]+\/[A-Fa-f0-9-]{16,64}$/;
const BASE_KEYS = ['schemaVersion', 'intentId', 'sequence', 'deadline', 'binding', 'intentHash', 'signature', 'kind', 'attestation'];

export function assertBoundaryFields(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))
    || Object.values(Object.getOwnPropertyDescriptors(value)).some((entry) => !Object.hasOwn(entry, 'value') || !entry.enumerable)) {
    throw new Error('Boundary object has missing, unknown, or non-data fields');
  }
}

function matches(value, pattern) { return typeof value === 'string' && pattern.test(value); }

export function boundaryTimestamp(value) {
  const match = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match) throw new Error('Boundary timestamp is not a valid offset ISO datetime');
  const [, y, m, d, h, minute, second, zh = '0', zm = '0'] = match;
  const days = new Date(Date.UTC(Number(y), Number(m), 0)).getUTCDate();
  if (Number(m) < 1 || Number(m) > 12 || Number(d) < 1 || Number(d) > days
    || Number(h) > 23 || Number(minute) > 59 || Number(second) > 59 || Number(zh) > 23 || Number(zm) > 59
    || !Number.isFinite(Date.parse(value))) throw new Error('Boundary timestamp is not a valid offset ISO datetime');
  return Date.parse(value);
}

// Match the producer's sorted-key JSON bytes, refusing values JSON would silently discard.
export function canonicalBoundaryJson(value) {
  const seen = new Set();
  let nodes = 0;
  const normalize = (entry, depth = 0) => {
    if (++nodes > 1024 || depth > 32) throw new Error('Boundary JSON exceeds source-contract bounds');
    if (entry === null || typeof entry === 'string' || typeof entry === 'boolean') return entry;
    if (typeof entry === 'number' && Number.isFinite(entry)) return entry;
    if (!entry || typeof entry !== 'object' || seen.has(entry)) throw new Error('Boundary JSON is not plain finite JSON');
    seen.add(entry);
    let result;
    if (Array.isArray(entry)) {
      if (Object.getPrototypeOf(entry) !== Array.prototype || Reflect.ownKeys(entry).length !== entry.length + 1) {
        throw new Error('Boundary JSON array is not plain and dense');
      }
      result = [];
      for (let index = 0; index < entry.length; index += 1) {
        const child = Object.getOwnPropertyDescriptor(entry, String(index));
        if (!child || !Object.hasOwn(child, 'value') || !child.enumerable) throw new Error('Boundary JSON array has non-data elements');
        result.push(normalize(child.value, depth + 1));
      }
    } else {
      if (Object.getPrototypeOf(entry) !== Object.prototype
        || Reflect.ownKeys(entry).length !== Object.keys(entry).length
        || Object.values(Object.getOwnPropertyDescriptors(entry)).some((child) => !Object.hasOwn(child, 'value'))) {
        throw new Error('Boundary JSON is not a plain data object');
      }
      result = Object.fromEntries(Object.entries(entry).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, child]) => [key, normalize(child, depth + 1)]));
    }
    seen.delete(entry);
    return result;
  };
  const json = JSON.stringify(normalize(value));
  if (Buffer.byteLength(json, 'utf8') > 65_536) throw new Error('Boundary JSON exceeds source-contract bounds');
  return json;
}

export function boundarySha256(value) { return createHash('sha256').update(value, 'utf8').digest('hex'); }

export function boundaryIntentHash(document) {
  return boundarySha256(canonicalBoundaryJson(Object.fromEntries(Object.entries(document)
    .filter(([key]) => key !== 'intentHash' && key !== 'signature'))));
}

export function boundarySigningBytes(document) {
  return Buffer.from(canonicalBoundaryJson(Object.fromEntries(Object.entries(document).filter(([key]) => key !== 'signature'))), 'utf8');
}

export function boundaryDocumentHash(document) { return boundarySha256(canonicalBoundaryJson(parseBetaBoundaryDocument(document))); }

export function parseBetaBoundaryBinding(binding) {
  assertBoundaryFields(binding, ['runScope', 'taskId', 'messageId', 'bodyDigest', 'receiptDigest', 'queue',
    'accountId', 'region', 'queueArn', 'workerTaskArn', 'listenerId']);
  if (!matches(binding.runScope, RUN_SCOPE) || !matches(binding.taskId, UUID) || !matches(binding.messageId, ID)
    || !matches(binding.bodyDigest, DIGEST) || !matches(binding.receiptDigest, DIGEST) || !matches(binding.listenerId, ID)
    || binding.queue !== 'auto-tagging' || binding.accountId !== BOUNDARY_ACCOUNT || binding.region !== BOUNDARY_REGION
    || binding.queueArn !== BOUNDARY_QUEUE_ARN || !matches(binding.workerTaskArn, WORKER_ARN)) {
    throw new Error('Boundary binding is not the exact Beta auto-tagging worker receipt');
  }
  return Object.freeze({ ...binding });
}

export function parseBoundaryAttestation(attestation, binding) {
  assertBoundaryFields(attestation, ['kind', 'taskArn', 'listenerId', 'messageId', 'bodyDigest', 'receiptDigest',
    'receiveCount', 'credentialId', 'issuedAt', 'expiresAt', 'proofDigest']);
  if (attestation.kind !== 'task-listener-credential' || attestation.receiveCount !== 1
    || !matches(attestation.credentialId, ID) || !matches(attestation.proofDigest, DIGEST)
    || attestation.taskArn !== binding.workerTaskArn || attestation.listenerId !== binding.listenerId
    || attestation.messageId !== binding.messageId || attestation.bodyDigest !== binding.bodyDigest
    || attestation.receiptDigest !== binding.receiptDigest
    || boundaryTimestamp(attestation.expiresAt) <= boundaryTimestamp(attestation.issuedAt)) {
    throw new Error('Boundary attestation schema is not bound to the first worker receipt');
  }
  return Object.freeze({ ...attestation });
}

export function assertFreshBoundaryAttestation(attestation, now) {
  if (!Number.isFinite(now) || boundaryTimestamp(attestation.issuedAt) > now || boundaryTimestamp(attestation.expiresAt) <= now) {
    throw new Error('Boundary attestation time window is stale or in the future');
  }
}

export function parseBetaBoundaryDocument(value) {
  const kind = Object.getOwnPropertyDescriptor(value ?? {}, 'kind')?.value;
  const extras = kind === 'ARM' ? ['operation', 'visibilitySeconds'] : kind === 'ACK' ? ['armHash'] : kind === 'FIRE' ? ['armHash', 'ackHash'] : null;
  if (!extras) throw new Error('Unsupported boundary document kind');
  assertBoundaryFields(value, [...BASE_KEYS, ...extras]);
  assertBoundaryFields(value.signature, ['algorithm', 'keyId', 'value']);
  if (value.schemaVersion !== 1 || !matches(value.intentId, UUID) || !Number.isSafeInteger(value.sequence) || value.sequence < 1
    || !matches(value.intentHash, DIGEST) || value.signature.algorithm !== 'Ed25519' || !matches(value.signature.keyId, ID)
    || !matches(value.signature.value, /^[A-Za-z0-9+/]{86}==$/)
    || Buffer.from(value.signature.value, 'base64').toString('base64') !== value.signature.value
    || (kind === 'ARM' && (value.operation !== 'change-visibility' || !Number.isInteger(value.visibilitySeconds)
      || value.visibilitySeconds < 0 || value.visibilitySeconds > 43200))
    || (kind !== 'ARM' && !matches(value.armHash, DIGEST)) || (kind === 'FIRE' && !matches(value.ackHash, DIGEST))) {
    throw new Error('Boundary document schema is invalid');
  }
  boundaryTimestamp(value.deadline);
  const binding = parseBetaBoundaryBinding(value.binding);
  const attestation = parseBoundaryAttestation(value.attestation, binding);
  if (value.intentHash !== boundaryIntentHash(value)) throw new Error('Boundary document intent hash does not match canonical content');
  return Object.freeze({ ...value, binding, attestation, signature: Object.freeze({ ...value.signature }) });
}

export function verifyBetaBoundarySignature(document, publicKey) {
  const parsed = parseBetaBoundaryDocument(document);
  if (!(publicKey instanceof KeyObject) || publicKey.type !== 'public' || publicKey.asymmetricKeyType !== 'ed25519') return false;
  return verify(null, boundarySigningBytes(parsed), publicKey, Buffer.from(parsed.signature.value, 'base64'));
}

export function assertBetaBoundaryChain(arm, ack, fire, resolvePublicKey) {
  const documents = [arm, ack, fire].map(parseBetaBoundaryDocument);
  if (documents.some((document, index) => document.kind !== ['ARM', 'ACK', 'FIRE'][index]
    || !verifyBetaBoundarySignature(document, resolvePublicKey?.(document.kind, document.signature.keyId)))) {
    throw new Error('Boundary document signature is not trusted for its role');
  }
  if (ack.armHash !== boundaryDocumentHash(arm) || fire.armHash !== boundaryDocumentHash(arm) || fire.ackHash !== boundaryDocumentHash(ack)
    || ack.intentId !== arm.intentId || fire.intentId !== arm.intentId || ack.sequence !== arm.sequence + 1 || fire.sequence !== ack.sequence + 1
    || ack.deadline !== arm.deadline || fire.deadline !== arm.deadline
    || documents.some((document) => canonicalBoundaryJson(document.binding) !== canonicalBoundaryJson(arm.binding)
      || canonicalBoundaryJson(document.attestation) !== canonicalBoundaryJson(arm.attestation))) {
    throw new Error('Boundary document chain has hash, sequence, deadline, or receipt-proof drift');
  }
}
