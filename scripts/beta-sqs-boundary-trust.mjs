import { createHash, createPublicKey, KeyObject } from 'node:crypto';
import { assertBoundaryFields } from './beta-sqs-boundary-protocol.mjs';

export const BOUNDARY_SIGNING_LOCATION = Object.freeze({
  repository: 'git-malu/AnyWear-E2E', environment: 'beta', secretName: 'BETA_SQS_BOUNDARY_ED25519_PRIVATE_KEY',
});

// Only a reviewed public-only source change may replace this absent pin.
export const BOUNDARY_SIGNING_TRUST_PIN = null;

export function describeBoundaryPublicKey(publicKey, keyId) {
  if (!(publicKey instanceof KeyObject) || publicKey.type !== 'public' || publicKey.asymmetricKeyType !== 'ed25519'
    || typeof keyId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(keyId)) {
    throw new Error('Boundary public trust manifest is invalid');
  }
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return Object.freeze({ schemaVersion: 1, algorithm: 'Ed25519', keyId, spkiDerBase64: der.toString('base64'),
    spkiSha256: createHash('sha256').update(der).digest('hex') });
}

export function validateBoundaryTrustPin(pin) {
  try {
    assertBoundaryFields(pin, ['schemaVersion', 'algorithm', 'keyId', 'spkiDerBase64', 'spkiSha256']);
    if (pin.schemaVersion !== 1 || pin.algorithm !== 'Ed25519' || typeof pin.spkiDerBase64 !== 'string'
      || !/^[A-Za-z0-9+/]{59}=$/.test(pin.spkiDerBase64) || typeof pin.spkiSha256 !== 'string'
      || !/^[a-f0-9]{64}$/.test(pin.spkiSha256)) {
      throw new Error();
    }
    const publicKey = createPublicKey({ key: Buffer.from(pin.spkiDerBase64, 'base64'), type: 'spki', format: 'der' });
    const canonical = describeBoundaryPublicKey(publicKey, pin.keyId);
    if (canonical.spkiDerBase64 !== pin.spkiDerBase64 || canonical.spkiSha256 !== pin.spkiSha256) throw new Error();
    return canonical;
  } catch {
    throw new Error('Boundary public trust manifest is invalid');
  }
}

export function requireImmutableBoundaryTrustPin() {
  if (!BOUNDARY_SIGNING_TRUST_PIN) throw new Error('Immutable source trust root is missing; live boundary signer cannot be constructed');
  return validateBoundaryTrustPin(BOUNDARY_SIGNING_TRUST_PIN);
}

export function assertMainOnlyBoundaryEnvironment(environment, policies) {
  if (environment?.name !== 'beta'
    || environment.url !== 'https://api.github.com/repos/git-malu/AnyWear-E2E/environments/beta'
    || environment.deployment_branch_policy?.protected_branches !== false
    || environment.deployment_branch_policy?.custom_branch_policies !== true
    || policies?.total_count !== 1 || policies.branch_policies?.length !== 1
    || policies.branch_policies[0].name !== 'main' || policies.branch_policies[0].type !== 'branch') {
    throw new Error('Beta environment main-only deployment policy is missing or mismatched');
  }
}
