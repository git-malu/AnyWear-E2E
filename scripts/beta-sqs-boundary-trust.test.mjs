import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import {
  BOUNDARY_SIGNING_LOCATION, BOUNDARY_SIGNING_TRUST_PIN, describeBoundaryPublicKey,
  requireImmutableBoundaryTrustPin, validateBoundaryTrustPin,
} from './beta-sqs-boundary-trust.mjs';

test('live source pin is absent and fixed Beta signing location is immutable', () => {
  assert.equal(BOUNDARY_SIGNING_TRUST_PIN, null);
  assert.deepEqual(BOUNDARY_SIGNING_LOCATION, { repository: 'git-malu/AnyWear-E2E', environment: 'beta',
    secretName: 'BETA_SQS_BOUNDARY_ED25519_PRIVATE_KEY' });
  assert.ok(Object.isFrozen(BOUNDARY_SIGNING_LOCATION));
  assert.throws(() => requireImmutableBoundaryTrustPin(), /Immutable source trust root is missing/);
  assert.throws(() => requireImmutableBoundaryTrustPin(describeBoundaryPublicKey(generateKeyPairSync('ed25519').publicKey, 'fixture')), /missing/);
});

test('public-only manifest independently matches canonical Ed25519 SPKI and SHA256', () => {
  const keys = generateKeyPairSync('ed25519');
  const pin = describeBoundaryPublicKey(keys.publicKey, 'fixture-public');
  const der = keys.publicKey.export({ type: 'spki', format: 'der' });
  assert.deepEqual(pin, { schemaVersion: 1, algorithm: 'Ed25519', keyId: 'fixture-public',
    spkiDerBase64: der.toString('base64'), spkiSha256: createHash('sha256').update(der).digest('hex') });
  assert.deepEqual(validateBoundaryTrustPin(pin), pin);
  assert.ok(Object.isFrozen(pin));
  assert.doesNotMatch(JSON.stringify(pin), /PRIVATE|pkcs8|secretBytes/);
});

test('malformed, private, foreign-algorithm, accessor and hash-mismatched manifests fail sanitized', () => {
  const keys = generateKeyPairSync('ed25519');
  const pin = describeBoundaryPublicKey(keys.publicKey, 'fixture-public');
  const sentinel = 'sensitive-manifest-sentinel';
  const invalid = [null, { ...pin, secretBytes: sentinel }, { ...pin, schemaVersion: 2 }, { ...pin, algorithm: 'RSA' },
    { ...pin, keyId: 'bad/key' }, { ...pin, spkiSha256: 'a'.repeat(64) }, { ...pin, spkiDerBase64: pin.spkiDerBase64 + '\n' },
    { ...pin, spkiDerBase64: keys.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64') },
    { ...pin, get keyId() { throw new Error(sentinel); } }];
  for (const value of invalid) {
    assert.throws(() => validateBoundaryTrustPin(value), (error) => error.message === 'Boundary public trust manifest is invalid');
  }
  assert.throws(() => describeBoundaryPublicKey(keys.privateKey, 'fixture'), /public trust/);
  assert.throws(() => describeBoundaryPublicKey(generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey, 'fixture'), /public trust/);
});
