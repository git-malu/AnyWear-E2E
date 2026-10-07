import { createPrivateKey, createPublicKey } from 'node:crypto';
import { createSourceOnlyBoundarySession } from './beta-sqs-boundary-consumer.mjs';
import { assertBoundaryFields } from './beta-sqs-boundary-protocol.mjs';
import {
  BOUNDARY_SIGNING_LOCATION, describeBoundaryPublicKey, requireImmutableBoundaryTrustPin, validateBoundaryTrustPin,
} from './beta-sqs-boundary-trust.mjs';

function loadMatchedPrivateKey(secretBytes, trustPin) {
  let der;
  try {
    const pin = validateBoundaryTrustPin(trustPin);
    if (!Buffer.isBuffer(secretBytes) || secretBytes.length !== 64
      || !/^[A-Za-z0-9+/]{64}$/.test(secretBytes.toString('utf8'))) throw new Error();
    der = Buffer.from(secretBytes.toString('utf8'), 'base64');
    const privateKey = createPrivateKey({ key: der, type: 'pkcs8', format: 'der' });
    if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error();
    const derived = describeBoundaryPublicKey(createPublicKey(privateKey), pin.keyId);
    if (derived.spkiDerBase64 !== pin.spkiDerBase64 || derived.spkiSha256 !== pin.spkiSha256) throw new Error();
    return privateKey;
  } catch {
    throw new Error('Boundary in-memory signing key does not match reviewed public trust');
  } finally { der?.fill(0); }
}

function pinnedSession(secretBytes, pin, options) {
  const privateKey = loadMatchedPrivateKey(secretBytes, pin);
  return createSourceOnlyBoundarySession({ keyId: pin.keyId, privateKey, ...options });
}

// No asserted boolean, callback, or process-local Set can establish first-boot authority.
function claimDurableFirstBootSignerAuthority() {
  throw new Error('Verified durable first-boot signer authority is not implemented; secret loading is blocked');
}

export function loadBetaSqsBoundarySigner() {
  const pin = requireImmutableBoundaryTrustPin();
  const authority = claimDurableFirstBootSignerAuthority();
  let secretBytes;
  try {
    const secretName = BOUNDARY_SIGNING_LOCATION.secretName;
    secretBytes = Buffer.from(process.env[secretName] ?? '', 'utf8');
    delete process.env[secretName];
    return pinnedSession(secretBytes, pin, authority);
  } catch {
    throw new Error('Protected Beta signing key could not be loaded; boundary remains disarmed');
  } finally { secretBytes?.fill(0); }
}

// Fixture pins/bytes can exercise cryptography but never configure the live source trust root.
export function createSourceOnlyPinnedBoundarySession(options) {
  assertBoundaryFields(options, ['secretBytes', 'trustPin', 'listenerKeyId', 'listenerPublicKey',
    'binding', 'intentId', 'sequence', 'deadline', 'clock']);
  const { secretBytes, trustPin, ...sessionOptions } = options;
  return pinnedSession(secretBytes, validateBoundaryTrustPin(trustPin), sessionOptions);
}

export function restoreBetaBoundarySigner() { throw new Error('Restart aborts/disarms the boundary; signer restoration is forbidden'); }
