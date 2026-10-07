import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { assertBoundaryFields } from './beta-sqs-boundary-protocol.mjs';
import { assertMainOnlyBoundaryEnvironment, BOUNDARY_SIGNING_LOCATION, BOUNDARY_SIGNING_TRUST_PIN,
  describeBoundaryPublicKey } from './beta-sqs-boundary-trust.mjs';

export const INITIAL_SIGNER_PROVISIONING_CONFIRMATION = 'INITIAL_BETA_SQS_SIGNER_git-malu/AnyWear-E2E_beta';
const API = `repos/${BOUNDARY_SIGNING_LOCATION.repository}/environments/${BOUNDARY_SIGNING_LOCATION.environment}`;
const TIMEOUT_MS = 30_000;
const SAFE_FAILURE = 'Initial Beta signer provisioning failed or is ambiguous; do not retry or rotate automatically';

function runGh(spawnProcess, args, input) {
  return new Promise((resolve, reject) => {
    let child;
    let timer;
    let settled = false;
    let bytes = 0;
    const chunks = [];
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) {
        try { child?.kill(); } catch { /* Failure remains ambiguous even if process termination fails. */ }
        reject(new Error(SAFE_FAILURE));
      } else resolve(result);
    };
    try {
      child = spawnProcess('gh', args, { shell: false, windowsHide: true,
        stdio: [input ? 'pipe' : 'ignore', input ? 'ignore' : 'pipe', 'ignore'] });
      timer = setTimeout(() => finish(true), TIMEOUT_MS);
      child.on('error', () => finish(true));
      child.on('close', (code) => {
        if (code !== 0) return finish(true);
        if (input) return finish(false);
        try { finish(false, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { finish(true); }
      });
      if (input) {
        child.stdin.on('error', () => finish(true));
        child.stdin.end(input);
      } else {
        child.stdout.on('error', () => finish(true));
        child.stdout.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > 65_536) return finish(true);
          chunks.push(Buffer.from(chunk));
        });
      }
    } catch { finish(true); }
  });
}

function listedSecrets(response) {
  if (!Number.isSafeInteger(response?.total_count) || response.total_count < 0 || response.total_count > 100
    || !Array.isArray(response.secrets) || response.secrets.length !== response.total_count
    || response.secrets.some((secret) => typeof secret?.name !== 'string')
    || new Set(response.secrets.map((secret) => secret.name.toUpperCase())).size !== response.total_count) {
    throw new Error(SAFE_FAILURE);
  }
  return response.secrets.map((secret) => secret.name.toUpperCase());
}

async function provisionWithProcess(options, spawnProcess, generateKeys, mode) {
  let der;
  let secretInput;
  try {
    assertBoundaryFields(options, ['confirmation']);
    if (options.confirmation !== INITIAL_SIGNER_PROVISIONING_CONFIRMATION || BOUNDARY_SIGNING_TRUST_PIN !== null) throw new Error();
    const environment = await runGh(spawnProcess, ['api', API]);
    const policies = await runGh(spawnProcess, ['api', `${API}/deployment-branch-policies?per_page=100`]);
    assertMainOnlyBoundaryEnvironment(environment, policies);
    const list = () => runGh(spawnProcess, ['api', `${API}/secrets?per_page=100`]);
    const secretName = BOUNDARY_SIGNING_LOCATION.secretName;
    if (listedSecrets(await list()).includes(secretName)) throw new Error();
    const keys = generateKeys();
    const publicDescriptor = describeBoundaryPublicKey(keys.publicKey, 'initial-candidate');
    const publicPin = describeBoundaryPublicKey(keys.publicKey, `beta-sqs-boundary-${publicDescriptor.spkiSha256.slice(0, 24)}`);
    der = keys.privateKey.export({ type: 'pkcs8', format: 'der' });
    secretInput = Buffer.from(der.toString('base64'), 'ascii');
    // gh secret set is an upsert. A root-owned exclusive window is required; this recheck is not CAS.
    if (listedSecrets(await list()).includes(secretName)) throw new Error();
    await runGh(spawnProcess, ['secret', 'set', secretName, '--repo', BOUNDARY_SIGNING_LOCATION.repository,
      '--env', BOUNDARY_SIGNING_LOCATION.environment], secretInput);
    if (!listedSecrets(await list()).includes(secretName)) throw new Error();
    return Object.freeze({ mode, ...BOUNDARY_SIGNING_LOCATION, publicPin,
      storageConfirmation: 'command-success-and-secret-name-readback', secretContentReadback: false });
  } catch { throw new Error(SAFE_FAILURE); }
  finally { der?.fill(0); secretInput?.fill(0); }
}

// This function is intentionally not a CLI entry point and is never executed during source verification.
export function provisionBetaBoundarySigner(options) {
  return provisionWithProcess(options, spawn, () => generateKeyPairSync('ed25519'), 'initial-beta-provisioning');
}

export function createSourceOnlyProvisioningHarness(options) {
  assertBoundaryFields(options, ['spawnProcess', 'generateFixtureKeys']);
  if (typeof options.spawnProcess !== 'function' || typeof options.generateFixtureKeys !== 'function') throw new Error(SAFE_FAILURE);
  const { spawnProcess, generateFixtureKeys } = options;
  return Object.freeze({ provision: (confirmation) => provisionWithProcess({ confirmation }, spawnProcess,
    generateFixtureKeys, 'source-only-fake-process') });
}
