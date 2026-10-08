import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import {
  AdminDeleteUserCommand,
  AdminGetUserCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { markAccountDeleted } from '../tests/support/account-budget.ts';
import { assertServiceCleanupRunSource, findServiceCleanupRunId, serviceCleanupDispatchArgs } from '../tests/support/service-cleanup-dispatch.ts';
import { cleanupWorkerAccounts } from '../tests/support/worker-cleanup.ts';
import { assertE2EWriterWindow } from './writer-window.mjs';
import { byteHash, parseStrictJson, requireCommit } from './evidence-contract.mjs';

const exec = promisify(execFile);
const manifestPath = process.env.E2E_ACCOUNT_BUDGET_PATH ?? 'test-results/account-budget.json';

async function runServiceCleanup(inputs) {
  assertE2EWriterWindow();
  const operatorSha = requireCommit(process.env.E2E_CLEANUP_SERVICE_SHA, 'Reviewed Service data-cleanup operator source');
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
  const metadata = async () => parseStrictJson((await exec('gh', ['api', `repos/git-malu/AnyWear-Service/actions/runs/${runId}`], { maxBuffer: 1024 * 1024 })).stdout);
  const started = await metadata();
  if (started.id !== Number(runId)) throw new Error('Service cleanup run ID mismatch');
  const attempt = assertServiceCleanupRunSource(started, operatorSha);
  try {
    await exec('gh', ['run', 'watch', runId, '--repo', 'git-malu/AnyWear-Service', '--exit-status'], { maxBuffer: 1024 * 1024 });
  } catch {
    throw new Error('Subject-bound Service cleanup did not succeed; Cognito identities were retained');
  }
  const completed = await metadata();
  if (completed.id !== Number(runId)) throw new Error('Service cleanup run ID changed');
  assertServiceCleanupRunSource(completed, operatorSha, attempt);
  if (completed.status !== 'completed' || completed.conclusion !== 'success') throw new Error('Exact Service cleanup attempt did not complete successfully');
  const evidencePath = process.env.E2E_SERVICE_CLEANUP_EVIDENCE_PATH ?? 'test-results/service-cleanup-run.json';
  await mkdir(dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify({
    schema_version: 1, record_type: 'anywear_e2e_service_cleanup',
    e2e: { repository: process.env.GITHUB_REPOSITORY, sha: process.env.GITHUB_SHA,
      run_id: Number(process.env.GITHUB_RUN_ID), run_attempt: Number(process.env.GITHUB_RUN_ATTEMPT) },
    writer_record_url: process.env.E2E_WRITER_RECORD_URL,
    operator_sha: operatorSha, dispatched_at: dispatchedAt, verified_at: new Date().toISOString(),
    cleanup_request_sha256: byteHash(Buffer.from(inputs.cleanup_json)),
    cleanup_request: parseStrictJson(inputs.cleanup_json), service_run: completed,
  }, null, 2)}\n`, { mode: 0o600 });
  assertE2EWriterWindow();
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
      assertE2EWriterWindow();
      await client.send(new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: username }));
    },
    destroy() { client.destroy(); },
  };
}

try {
  assertE2EWriterWindow();
  let manifest;
  try { manifest = parseStrictJson(await readFile(manifestPath)); }
  catch (error) {
    if (error?.code === 'ENOENT') process.exit(0);
    throw error;
  }
  const io = await cognitoIo();
  try {
    const count = await cleanupWorkerAccounts(manifest, { ...io, runServiceCleanup });
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
