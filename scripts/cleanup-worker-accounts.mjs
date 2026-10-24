import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import {
  AdminDeleteUserCommand,
  AdminGetUserCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { markAccountDeleted } from '../tests/support/account-budget.ts';
import { runCleanupOperation } from '../tests/support/service-cleanup-operation.ts';
import { cleanupWorkerAccounts, isAdmittedCleanupWorker } from '../tests/support/worker-cleanup.ts';
import { assertE2EExecution } from './execution-guard.mjs';
import { parseStrictJson } from './evidence-contract.mjs';

// The ordinary per-run cleanup step of `full` and `smoke` (#217). It transmits the exact
// captured `{runScope, users}` request to the reviewed Service cleanup, deletes only the
// identities whose committed cleanup it can prove, reads their absence back, and marks the
// ledger record `deleted`. A leftover it cannot resolve stays `cleanup_pending`/`retained`
// and is cleared by the `reconcile` operation inside its bound; there is no manual recovery
// dispatch, no diagnostic tuple and no original-evidence replay any more.

const manifestPath = process.env.E2E_ACCOUNT_BUDGET_PATH ?? 'test-results/account-budget.json';

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

export async function runCapturedWorkerCleanup(manifest, environment, io, operation = runCleanupOperation) {
  return cleanupWorkerAccounts(manifest, { ...io, runServiceCleanup: async inputs => {
    const result = await operation(inputs, environment);
    if (result === undefined) return false;
    if (result.operation?.proof_status !== 'verified') throw new Error('Service cleanup did not prove the committed result; identities retained');
    return true;
  } });
}

/**
 * The ledger half of the cleanup: every worker the request admitted reached a verified delete
 * and absence readback, so its record becomes `deleted`. The predicate is the same one the
 * request used, so an unproven retained record is never marked. `markAccountDeleted` rewrites
 * only status and `updatedAt`, which keeps the original retention reason and bound.
 */
export async function markRepairedWorkerAccounts(manifest) {
  const admitted = manifest.accounts.filter(account => isAdmittedCleanupWorker(account, manifest));
  for (const account of admitted) await markAccountDeleted(account.email);
  return admitted;
}

/** A worker record the step left non-deleted: neither cleaned nor already deleted. */
export function skippedWorkerAccounts(manifest, admitted) {
  return manifest.accounts.filter(account => account.mode === 'worker'
    && account.status !== 'deleted' && !admitted.includes(account));
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
      }, async (...args) => { assertE2EExecution(); const result = await runCleanupOperation(...args); assertE2EExecution(); return result; });
      if (count === undefined) {
        process.stdout.write('Deferred exact E2E worker cleanup; the account manifest stays pending for the reconcile operation.\n');
        process.exitCode = 1;
      } else {
        const admitted = await markRepairedWorkerAccounts(manifest);
        // A record that is neither cleaned nor already `deleted` was skipped. Report it and
        // fail the step: the identity and its reason stay in the manifest for reconcile.
        const skipped = skippedWorkerAccounts(manifest, admitted);
        process.stdout.write(`Cleaned ${count} exact E2E worker identity record(s).\n`);
        if (skipped.length > 0) {
          process.stderr.write(`Cleanup left ${skipped.length} worker record(s) non-deleted: ${skipped.map(account => `${account.email} (${account.status})`).join(', ')}\n`);
          process.exitCode = 1;
        }
      }
    } finally {
      io.destroy();
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'E2E worker cleanup failed; identities were retained');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
