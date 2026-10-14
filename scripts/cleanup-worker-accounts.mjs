import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  AdminDeleteUserCommand,
  AdminGetUserCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { markAccountDeleted } from '../tests/support/account-budget.ts';
import { runCleanupOperation, runRecoveryCleanupOperation } from '../tests/support/service-cleanup-operation.ts';
import { cleanupWorkerAccounts } from '../tests/support/worker-cleanup.ts';
import { assertE2EExecution } from './execution-guard.mjs';
import { byteHash, parseStrictJson } from './evidence-contract.mjs';
import { validateDiagnosticRecord } from './beta-cleanup-diagnostic.mjs';
import { validateAccountRecoverySelection } from './account-recovery-inputs.mjs';
const manifestPath = process.env.E2E_ACCOUNT_BUDGET_PATH ?? 'test-results/account-budget.json';
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const VERSION_ARN = /^arn:aws:states:ap-east-1:650880818323:stateMachine:beta-anywear-tester-cleanup:([1-9][0-9]*)$/;

export async function readCleanupDiagnostic(environment) {
  const path = environment.E2E_BETA_CLEANUP_DIAGNOSTIC_PATH;
  if (!path) throw new Error('Validated Beta cleanup diagnostic path is required; identities were retained');
  const bytes = await readFile(path);
  const expectedHash = environment.E2E_BETA_CLEANUP_DIAGNOSTIC_SHA256;
  if (!/^[a-f0-9]{64}$/.test(expectedHash ?? '') || byteHash(bytes) !== expectedHash) {
    throw new Error('Validated Beta cleanup diagnostic path/hash binding failed; identities were retained');
  }
  const record = parseStrictJson(bytes);
  validateDiagnosticRecord(record);
  return record;
}

export function bindCleanupEnvironment(environment, diagnostic) {
  const source = diagnostic?.service?.source_sha;
  const image = diagnostic?.service?.image_digest;
  const versionArn = diagnostic?.capability?.state_machine_version_arn;
  if (!SHA.test(source ?? '') || !DIGEST.test(image ?? '') || !VERSION_ARN.test(versionArn ?? '')) {
    throw new Error('Validated Beta cleanup diagnostic tuple is incomplete; identities were retained');
  }
  for (const [key, expected] of [
    ['E2E_CLEANUP_SERVICE_SHA', source],
    ['E2E_CLEANUP_SERVICE_SOURCE_SHA', source],
    ['E2E_CLEANUP_SERVICE_IMAGE_DIGEST', image],
    ['BETA_CLEANUP_STATE_MACHINE_VERSION_ARN', versionArn],
  ]) {
    if (environment[key] && environment[key] !== expected) throw new Error(`Cleanup ${key} differs from validated diagnostic tuple; identities were retained`);
  }
  return { ...environment,
    E2E_CLEANUP_SERVICE_SHA: source,
    E2E_CLEANUP_SERVICE_SOURCE_SHA: source,
    E2E_CLEANUP_SERVICE_IMAGE_DIGEST: image,
    BETA_CLEANUP_STATE_MACHINE_VERSION_ARN: versionArn,
  };
}

async function cognitoIo() {
  const userPoolId = process.env.USER_POOL_ID;
  if (!userPoolId) throw new Error('Missing USER_POOL_ID; Cognito identities were retained');
  const client = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
  return {
    async getUser(email) {
      const user = await client.send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: email }));
      return { Username: user.Username, UserAttributes: user.UserAttributes };
    },
    async deleteUser(username) {
      assertE2EExecution();
      await client.send(new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: username }));
    },
    destroy() { client.destroy(); },
  };
}

export async function runCapturedWorkerCleanup(manifest, environment, io,
  operations = { normal: runCleanupOperation, recovery: runRecoveryCleanupOperation },
  diagnosticLoader = readCleanupDiagnostic) {
  const mode = environment.E2E_CLEANUP_OPERATION_MODE ?? 'normal';
  const requiresDiagnostic = mode === 'recovery' || Boolean(environment.E2E_BETA_CLEANUP_DIAGNOSTIC_PATH);
  const diagnostic = requiresDiagnostic ? await diagnosticLoader(environment) : undefined;
  const cleanupEnvironment = diagnostic ? bindCleanupEnvironment(environment, diagnostic) : environment;
  let captured = manifest;
  let canonicalRequest;
  if (mode === 'recovery') {
    validateAccountRecoverySelection(environment);
    const original = parseStrictJson(await readFile(environment.E2E_CLEANUP_ORIGINAL_EVIDENCE_PATH));
    canonicalRequest = original.operation?.input?.cleanup_request;
    const request = parseStrictJson(canonicalRequest);
    if (request.runScope !== manifest.runScope || !Array.isArray(request.users) || request.users.length < 1 || request.users.length > 8) throw new Error('Recovery canonical owner request is invalid');
    const users = request.users;
    for (const user of users) {
      const accounts = manifest.accounts.filter(account => account.mode === 'worker' && account.email === user.email && account.subject === user.sub);
      if (accounts.length !== 1 || !['cleanup_pending', 'deleted'].includes(accounts[0].status)) throw new Error('Recovery drops or changes a captured worker identity');
    }
    if (manifest.accounts.some(account => account.mode === 'worker' && account.status === 'cleanup_pending'
      && !users.some(user => user.email === account.email && user.sub === account.subject))) throw new Error('Recovery adds an unowned worker identity');
    captured = { ...manifest, accounts: users.map(user => ({ email: user.email, subject: user.sub, mode: 'worker', status: 'cleanup_pending' })) };
  } else if (mode !== 'normal' || environment.E2E_CLEANUP_RECOVERY_ATTEMPT) throw new Error('Cleanup mode/attempt is invalid');
  return cleanupWorkerAccounts(captured, { ...io, runServiceCleanup: async inputs => {
    if (canonicalRequest !== undefined && inputs.cleanup_json !== canonicalRequest) throw new Error('Recovery changes canonical captured request bytes');
    const result = await operations[mode](inputs, cleanupEnvironment);
    if (result === undefined) return false;
    if (result.operation?.proof_status !== 'verified') throw new Error('Service cleanup did not prove the committed result; identities retained');
    return true;
  } });
}

async function main() {
try {
  assertE2EExecution();
  let manifest;
  try { manifest = parseStrictJson(await readFile(manifestPath)); }
  catch (error) {
    if (error?.code === 'ENOENT') process.exit(0);
    throw error;
  }
  const io = await cognitoIo();
  try {
    const count = await runCapturedWorkerCleanup(manifest, process.env, {
      ...io,
    }, {
      normal: async (...args) => { assertE2EExecution(); const result = await runCleanupOperation(...args); assertE2EExecution(); return result; },
      recovery: async (...args) => { assertE2EExecution(); const result = await runRecoveryCleanupOperation(...args); assertE2EExecution(); return result; },
    });
    if (count === undefined) {
      process.stdout.write('Deferred exact E2E worker cleanup; the account manifest remains cleanup_pending for protected recovery.\n');
      process.exitCode = 1;
    } else {
      for (const account of manifest.accounts) {
        if (account.mode === 'worker' && account.status === 'cleanup_pending') await markAccountDeleted(account.email);
      }
      process.stdout.write(`Cleaned ${count} exact E2E worker identity record(s).\n`);
    }
  } finally {
    io.destroy();
  }
} catch (error) {
  const directory = dirname(manifestPath);
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, 'account-recovery-failure.json'), `${JSON.stringify({ schema_version: 1,
    record_type: 'anywear_e2e_account_recovery_failure', phase: 'cleanup', proof_status: 'refused', identities_retained: true })}\n`);
  console.error(error instanceof Error ? error.message : 'E2E worker cleanup failed; identities were retained');
  process.exitCode = 1;
}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
