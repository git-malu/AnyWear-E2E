import { createPublicKey, KeyObject, sign } from 'node:crypto';
import {
  assertBetaBoundaryChain, assertBoundaryFields, assertFreshBoundaryAttestation,
  boundaryDocumentHash, boundaryIntentHash, boundarySigningBytes, boundaryTimestamp,
  canonicalBoundaryJson, parseBetaBoundaryBinding, parseBetaBoundaryDocument, parseBoundaryAttestation,
  verifyBetaBoundarySignature,
} from './beta-sqs-boundary-protocol.mjs';

// No reviewed public key has been delivered. Environment or fixture injection cannot replace source trust.
const IMMUTABLE_SOURCE_TRUST_ROOT = null;

export function createBetaSqsBoundaryConsumer() {
  if (!IMMUTABLE_SOURCE_TRUST_ROOT) throw new Error('Immutable source trust root is missing; live boundary signer cannot be constructed');
  throw new Error('Authenticated worker proof and durable boundary adapter are not implemented');
}

export function resumeBoundarySigner() { throw new Error('Boundary signer cannot be restored or restarted from a snapshot'); }

// Offline wire-contract fixtures only: no transport callback, durable store, CLI, or live authority.
export function createSourceOnlyBoundarySession(options) {
  assertBoundaryFields(options, ['keyId', 'listenerKeyId', 'privateKey', 'listenerPublicKey', 'binding', 'intentId', 'sequence', 'deadline', 'clock']);
  let privateKey = options.privateKey;
  const listenerPublicKey = options.listenerPublicKey;
  if (!(privateKey instanceof KeyObject) || privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519'
    || !(listenerPublicKey instanceof KeyObject) || listenerPublicKey.type !== 'public' || listenerPublicKey.asymmetricKeyType !== 'ed25519'
    || typeof options.keyId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(options.keyId)
    || typeof options.listenerKeyId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(options.listenerKeyId)
    || options.listenerKeyId === options.keyId || typeof options.clock !== 'function') {
    throw new Error('Offline boundary session requires separate in-memory Ed25519 runner and listener keys');
  }
  const publicKey = createPublicKey(privateKey);
  if (publicKey.equals(listenerPublicKey)) throw new Error('Runner signing key cannot impersonate the listener');
  const binding = parseBetaBoundaryBinding(options.binding);
  const { keyId, listenerKeyId, intentId, sequence, deadline, clock } = options;
  const expiry = boundaryTimestamp(deadline);
  if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > Number.MAX_SAFE_INTEGER - 2) throw new Error('Offline sequence is not bounded');
  let phase = 'idle';
  let currentSequence = sequence;
  let lastTime = -Infinity;
  let fireCount = 0;
  let arm;
  let ack;
  let timer;
  const retire = (reason) => {
    privateKey = null;
    clearTimeout(timer);
    if (phase === 'firing' || phase === 'unknown-outcome') phase = 'unknown-outcome';
    else if (!['fired', 'rejected'].includes(phase)) phase = reason;
  };
  const now = () => {
    let time;
    try { time = clock(); }
    catch {
      retire('closed');
      throw new Error('Boundary clock failed; signing authority retired');
    }
    if (!Number.isFinite(time) || time < lastTime) {
      retire('closed');
      throw new Error('Boundary clock is invalid or regressed; signing authority retired');
    }
    lastTime = time;
    if (time >= expiry) retire('expired');
    return time;
  };
  const fresh = () => {
    const time = now();
    if (!privateKey || ['closed', 'expired'].includes(phase)) throw new Error('Boundary signing lifetime is closed or expired');
    return time;
  };
  const resolvePublicKey = (kind, id) => kind === 'ACK'
    ? id === listenerKeyId ? listenerPublicKey : undefined
    : id === keyId ? publicKey : undefined;
  const signedDocument = (payload) => {
    if (payload.kind !== 'ARM' && payload.kind !== 'FIRE') throw new Error('Runner must never sign an ACK');
    const time = fresh();
    const document = { ...payload, intentHash: boundaryIntentHash(payload),
      signature: { algorithm: 'Ed25519', keyId, value: Buffer.alloc(64).toString('base64') } };
    parseBetaBoundaryDocument(document);
    assertFreshBoundaryAttestation(payload.attestation, time);
    document.signature.value = sign(null, boundarySigningBytes(document), privateKey).toString('base64');
    return parseBetaBoundaryDocument(document);
  };
  const initialTime = fresh();
  if (expiry - initialTime > 2_147_483_647) {
    retire('closed');
    throw new Error('Boundary deadline exceeds the absolute retirement timer bound');
  }
  timer = setTimeout(() => retire('expired'), expiry - initialTime);
  timer.unref();
  // Drop the original input reference so the returned closures do not retain its private key.
  // eslint-disable-next-line no-useless-assignment
  options = null;

  return Object.freeze({
    arm(attestation, visibilitySeconds) {
      const time = fresh();
      if (phase !== 'idle') throw new Error('ARM cannot be replayed or rebound');
      const parsed = parseBoundaryAttestation(attestation, binding);
      assertFreshBoundaryAttestation(parsed, time);
      arm = signedDocument({ schemaVersion: 1, kind: 'ARM', intentId, sequence, deadline, binding,
        operation: 'change-visibility', visibilitySeconds, attestation: parsed });
      phase = 'armed';
      return arm;
    },
    acknowledge(value) {
      const time = fresh();
      if (phase !== 'armed') throw new Error('ACK is not expected in this session');
      const document = parseBetaBoundaryDocument(value);
      if (document.kind !== 'ACK' || !verifyBetaBoundarySignature(document, resolvePublicKey('ACK', document.signature.keyId))
        || document.armHash !== boundaryDocumentHash(arm) || document.intentId !== intentId || document.sequence !== sequence + 1
        || document.deadline !== deadline || canonicalBoundaryJson(document.binding) !== canonicalBoundaryJson(binding)
        || canonicalBoundaryJson(document.attestation) !== canonicalBoundaryJson(arm.attestation)) {
        throw new Error('ACK is not signed by the exact separate fixture listener or has binding drift');
      }
      assertFreshBoundaryAttestation(document.attestation, time);
      ack = document;
      currentSequence = document.sequence;
      phase = 'acknowledged';
    },
    fire() {
      const time = fresh();
      if (phase !== 'acknowledged' || fireCount !== 0) throw new Error('FIRE cannot be replayed or issued without ACK');
      assertFreshBoundaryAttestation(arm.attestation, time);
      const fire = signedDocument({ schemaVersion: 1, kind: 'FIRE', intentId, sequence: sequence + 2, deadline, binding,
        armHash: boundaryDocumentHash(arm), ackHash: boundaryDocumentHash(ack), attestation: arm.attestation });
      assertBetaBoundaryChain(arm, ack, fire, resolvePublicKey);
      phase = 'firing';
      currentSequence = fire.sequence;
      fireCount = 1;
      privateKey = null;
      return fire;
    },
    recordFixtureOutcome(result) {
      now();
      if (phase !== 'firing' || !['applied', 'rejected', 'response-loss'].includes(result)) throw new Error('Fixture FIRE outcome is not expected');
      phase = result === 'applied' ? 'fired' : result === 'rejected' ? 'rejected' : 'unknown-outcome';
      clearTimeout(timer);
    },
    close() { retire('closed'); },
    snapshot() {
      now();
      return Object.freeze({ mode: 'source-contract-only', phase, intentId, sequence: currentSequence, deadline, fireCount,
        awsIdentityProven: false, durableAuthority: false, liveExecutionEnabled: false });
    },
  });
}
