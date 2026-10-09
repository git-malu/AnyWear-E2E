import { readFile } from 'node:fs/promises';
import {
  AdminDeleteUserCommand,
  AdminGetUserCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { markAccountDeleted } from '../tests/support/account-budget.ts';
import { runCleanupOperation } from '../tests/support/service-cleanup-operation.ts';
import { cleanupWorkerAccounts } from '../tests/support/worker-cleanup.ts';
import { assertE2EExecution } from './execution-guard.mjs';
import { parseStrictJson } from './evidence-contract.mjs';
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
    const count = await cleanupWorkerAccounts(manifest, {
      ...io,
      runServiceCleanup: async (inputs) => {
        assertE2EExecution();
        const result = await runCleanupOperation(inputs);
        assertE2EExecution();
        return result === undefined ? false : true;
      },
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
  console.error(error instanceof Error ? error.message : 'E2E worker cleanup failed; identities were retained');
  process.exitCode = 1;
}
