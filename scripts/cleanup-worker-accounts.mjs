import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import {
  AdminDeleteUserCommand,
  AdminGetUserCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { markAccountDeleted } from '../tests/support/account-budget.ts';
import { findServiceCleanupRunId, serviceCleanupDispatchArgs } from '../tests/support/service-cleanup-dispatch.ts';
import { cleanupWorkerAccounts } from '../tests/support/worker-cleanup.ts';

const exec = promisify(execFile);
const manifestPath = process.env.E2E_ACCOUNT_BUDGET_PATH ?? 'test-results/account-budget.json';

async function runServiceCleanup(inputs) {
  const dispatchedAt = new Date().toISOString();
  try {
    await exec('gh', serviceCleanupDispatchArgs(inputs), { maxBuffer: 1024 * 1024 });
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'unknown';
    console.warn(`Subject-bound Service cleanup dispatch unavailable (gh exit ${code}); cleanup deferred and identities retained`);
    return false;
  }
  let runId;
  const deadline = Date.now() + 90_000;
  while (!runId && Date.now() < deadline) {
    let output;
    try {
      ({ stdout: output } = await exec('gh', [
        'run', 'list', '--repo', 'git-malu/AnyWear-Service', '--workflow', 'beta-testers.yml',
        '--branch', 'main', '--event', 'workflow_dispatch', '--limit', '20',
        '--json', 'databaseId,createdAt,event,headBranch,workflowName,displayTitle',
      ], { maxBuffer: 1024 * 1024 }));
      runId = findServiceCleanupRunId(JSON.parse(output), dispatchedAt);
    } catch (error) {
      throw new Error('Service cleanup run could not be safely correlated; Cognito identities were retained', { cause: error });
    }
    if (!runId) await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  if (!runId) throw new Error('Service cleanup run was not observed; Cognito identities were retained');
  try {
    await exec('gh', ['run', 'watch', runId, '--repo', 'git-malu/AnyWear-Service', '--exit-status'], { maxBuffer: 1024 * 1024 });
  } catch {
    throw new Error('Subject-bound Service cleanup did not succeed; Cognito identities were retained');
  }
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
      await client.send(new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: username }));
    },
    destroy() { client.destroy(); },
  };
}

try {
  let manifest;
  try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')); }
  catch (error) {
    if (error?.code === 'ENOENT') process.exit(0);
    throw error;
  }
  const io = await cognitoIo();
  try {
    const count = await cleanupWorkerAccounts(manifest, { ...io, runServiceCleanup });
    if (count === undefined) {
      process.stdout.write('Deferred exact E2E worker cleanup; the account manifest remains cleanup_pending for protected recovery.\n');
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
