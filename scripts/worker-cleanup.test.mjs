import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { findServiceCleanupRunId, serviceCleanupDispatchArgs } from '../tests/support/service-cleanup-dispatch.ts';
import { cleanupWorkerAccounts, createServiceCleanupInputs, releaseWorkerLease } from '../tests/support/worker-cleanup.ts';

const runScope = `123456789-1-${'a'.repeat(16)}`;
const workerEmail = 'e2e-beta-worker-0-chromium@anywear.local';
const subject = '10000000-0000-4000-8000-000000000001';
const execute = promisify(execFile);

function manifest(accounts = [{ email: workerEmail, subject, mode: 'worker', status: 'cleanup_pending' }]) {
  return { version: 1, runScope, accounts };
}

function cleanupIo({ serviceCleanup = async () => {}, currentEmail = workerEmail, currentSubject = subject } = {}) {
  const calls = [];
  return {
    calls,
    async runServiceCleanup(inputs) { calls.push({ service: inputs }); return serviceCleanup(inputs); },
    async getUser(email) {
      calls.push({ get: email });
      return { Username: subject, UserAttributes: [
        { Name: 'email', Value: currentEmail },
        { Name: 'sub', Value: currentSubject },
      ] };
    },
    async deleteUser(username) { calls.push({ delete: username }); },
  };
}

test('stable worker cleanup transmits the exact runScope and subject/email pair before Cognito verification/deletion', async () => {
  const io = cleanupIo();
  const count = await cleanupWorkerAccounts(manifest([
    { email: workerEmail, subject, mode: 'worker', status: 'cleanup_pending' },
    { email: 'e2e-beta-123456789-1-a1b2c3d4@example.invalid', subject, mode: 'ephemeral', status: 'cleanup_pending' },
  ]), io);

  const cleanupJson = JSON.stringify({ runScope, users: [{ sub: subject, email: workerEmail }] });
  assert.equal(count, 1);
  assert.deepEqual(io.calls, [
    { service: { action: 'cleanup', emails: '[]', cleanup_json: cleanupJson } },
    { get: workerEmail },
    { delete: subject },
  ]);
  assert.deepEqual(createServiceCleanupInputs(manifest()).cleanup_json, cleanupJson);
});

test('Service transport sends cleanup_json only as an input to the protected workflow on main', () => {
  const cleanupJson = JSON.stringify({ runScope, users: [{ sub: subject, email: workerEmail }] });
  assert.deepEqual(serviceCleanupDispatchArgs({ action: 'cleanup', emails: '[]', cleanup_json: cleanupJson }), [
    'workflow', 'run', 'beta-testers.yml',
    '--repo', 'git-malu/AnyWear-Service',
    '--ref', 'main',
    '--raw-field', 'action=cleanup',
    '--raw-field', 'emails=[]',
    '--raw-field', `cleanup_json=${cleanupJson}`,
  ]);
});

test('Service workflow correlation selects the unique matching run after dispatch and ignores unrelated runs', () => {
  const dispatchedAt = '2026-10-04T12:00:00.000Z';
  const runs = [
    { databaseId: 1, createdAt: '2026-10-04T11:59:59.000Z', event: 'workflow_dispatch', headBranch: 'main', workflowName: 'Manage Beta Tester Allowlist', displayTitle: 'Beta tester allowlist: cleanup · @tester' },
    { databaseId: 2, createdAt: '2026-10-04T12:00:01.000Z', event: 'workflow_dispatch', headBranch: 'main', workflowName: 'Manage Beta Tester Allowlist', displayTitle: 'Beta tester allowlist: cleanup · @tester' },
    { databaseId: 3, createdAt: '2026-10-04T12:00:02.000Z', event: 'workflow_dispatch', headBranch: 'main', workflowName: 'Manage Beta Tester Allowlist', displayTitle: 'Beta tester allowlist: status · @tester' },
    { databaseId: 4, createdAt: '2026-10-04T12:00:03.000Z', event: 'workflow_dispatch', headBranch: 'feature', workflowName: 'Manage Beta Tester Allowlist', displayTitle: 'Beta tester allowlist: cleanup · @tester' },
    { databaseId: 5, createdAt: '2026-10-04T12:00:04.000Z', event: 'workflow_dispatch', headBranch: 'main', workflowName: 'Other workflow', displayTitle: 'Beta tester allowlist: cleanup · @tester' },
  ];
  assert.equal(findServiceCleanupRunId(runs, dispatchedAt), '2');
  assert.equal(findServiceCleanupRunId([], dispatchedAt), undefined);
});

test('Service workflow correlation rejects ambiguous candidates instead of watching an arbitrary run', () => {
  const first = { databaseId: 2, createdAt: '2026-10-04T12:00:01.000Z', event: 'workflow_dispatch', headBranch: 'main', workflowName: 'Manage Beta Tester Allowlist', displayTitle: 'Beta tester allowlist: cleanup · @tester' };
  const second = { ...first, databaseId: 3, createdAt: '2026-10-04T12:00:02.000Z' };
  assert.throws(() => findServiceCleanupRunId([first, second], '2026-10-04T12:00:00.000Z'), /Multiple Service workflow runs/);
});

test('failed subject-bound Service cleanup never reads or deletes a Cognito identity', async () => {
  const io = cleanupIo({ serviceCleanup: async () => { throw new Error('Service cleanup refused active resources'); } });
  await assert.rejects(cleanupWorkerAccounts(manifest(), io), /Service cleanup refused/);
  assert.deepEqual(io.calls, [{
    service: {
      action: 'cleanup',
      emails: '[]',
      cleanup_json: JSON.stringify({ runScope, users: [{ sub: subject, email: workerEmail }] }),
    },
  }]);
});

test('dispatch initiation failure defers cleanup without reading or deleting Cognito identities', async () => {
  const io = cleanupIo({ serviceCleanup: async () => false });
  const count = await cleanupWorkerAccounts(manifest(), io);
  assert.equal(count, undefined);
  assert.deepEqual(io.calls, [{
    service: {
      action: 'cleanup',
      emails: '[]',
      cleanup_json: JSON.stringify({ runScope, users: [{ sub: subject, email: workerEmail }] }),
    },
  }]);
});

test('malformed or subject-less pre-existing stable identity fails closed before Service or Cognito calls', async () => {
  const io = cleanupIo();
  await assert.rejects(cleanupWorkerAccounts(manifest([
    { email: workerEmail, mode: 'worker', status: 'cleanup_pending' },
  ]), io), /captured stable worker emails and subjects/);
  assert.deepEqual(io.calls, []);
});

test('pre-existing identity quarantined during provisioning is excluded from cleanup and retained', async () => {
  const io = cleanupIo();
  const count = await cleanupWorkerAccounts(manifest([
    { email: workerEmail, mode: 'worker', status: 'quarantined' },
  ]), io);
  assert.equal(count, 0);
  assert.deepEqual(io.calls, []);
});

test('changed pre-existing Cognito identity is retained after successful Service cleanup', async () => {
  const io = cleanupIo({ currentSubject: '20000000-0000-4000-8000-000000000002' });
  await assert.rejects(cleanupWorkerAccounts(manifest(), io), /different Cognito identity/);
  assert.deepEqual(io.calls, [
    { service: {
      action: 'cleanup',
      emails: '[]',
      cleanup_json: JSON.stringify({ runScope, users: [{ sub: subject, email: workerEmail }] }),
    } },
    { get: workerEmail },
  ]);
});

test('deleted leases are excluded and an empty worker set does not dispatch cleanup', async () => {
  const io = cleanupIo();
  const count = await cleanupWorkerAccounts(manifest([
    { email: workerEmail, subject, mode: 'worker', status: 'deleted' },
  ]), io);
  assert.equal(count, 0);
  assert.deepEqual(io.calls, []);
});

test('successful worker provisioning releases its stable slot as cleanup_pending', async () => {
  const released = [];
  await releaseWorkerLease(workerEmail, true, true, async (email) => released.push(email));
  assert.deepEqual(released, [workerEmail]);
});

test('a pre-existing identity rejected during provisioning retains its quarantined lease', async () => {
  const released = [];
  await releaseWorkerLease(workerEmail, true, false, async (email) => released.push(email));
  assert.deepEqual(released, []);
  const io = cleanupIo();
  const count = await cleanupWorkerAccounts(manifest([
    { email: workerEmail, mode: 'worker', status: 'quarantined' },
  ]), io);
  assert.equal(count, 0);
  assert.deepEqual(io.calls, []);
});

// Run the actual cleanup entrypoints with isolated fake command/SDK modules.
// No Git, GitHub or AWS command/request can leave this subprocess harness.
async function withCleanupEntrypoint(script, action) {
  const directory = await mkdtemp(join(tmpdir(), 'anywear-cleanup-principal-'));
  const filename = join(directory, 'accounts.json'); const callsFile = join(directory, 'calls.jsonl');
  const original = `${JSON.stringify(manifest(), null, 2)}\n`;
  const sourceSha = 'a'.repeat(40); const operatorSha = 'b'.repeat(40);
  try {
    await writeFile(filename, original); await writeFile(callsFile, '');
    const transport = join(directory, 'transport.mjs'); const cognito = join(directory, 'cognito.mjs');
    await writeFile(transport, `
import { appendFileSync } from 'node:fs';
const record = args => appendFileSync(process.env.TEST_CLEANUP_CALLS, JSON.stringify({ command: args }) + '\\n');
export function execFileSync(command, args) {
  if (command !== 'git' || args.at(-1) !== 'HEAD') throw new Error('Unexpected fake synchronous command');
  return process.env.TEST_CLEANUP_SOURCE_SHA + '\\n';
}
export function execFile(command, args, options, callback) {
  record([command, ...args]);
  if (command !== 'gh') return callback(new Error('External commands blocked by cleanup harness'));
  const metadata = { id: 900, run_attempt: 1, repository: { full_name: 'git-malu/AnyWear-Service' },
    path: '.github/workflows/beta-testers.yml', head_sha: process.env.E2E_CLEANUP_SERVICE_SHA,
    head_branch: 'main', event: 'workflow_dispatch', status: 'completed', conclusion: 'success' };
  let result;
  if (args[0] === 'workflow' && args[1] === 'run') result = '';
  else if (args[0] === 'run' && args[1] === 'list') result = JSON.stringify([{ databaseId: 900,
    createdAt: new Date().toISOString(), event: 'workflow_dispatch', headBranch: 'main',
    workflowName: 'Manage Beta Tester Allowlist', displayTitle: 'Beta tester allowlist: cleanup · @fixture' }]);
  else if (args[0] === 'api') result = JSON.stringify(metadata);
  else if (args[0] === 'run' && args[1] === 'watch') result = '';
  else return callback(new Error('Unexpected fake GitHub command'));
  callback(null, result, '');
}
execFile[Symbol.for('nodejs.util.promisify.custom')] = (command, args, options) => new Promise((resolve, reject) => {
  execFile(command, args, options, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
});
`);
    await writeFile(cognito, `
import { appendFileSync } from 'node:fs';
const record = operation => appendFileSync(process.env.TEST_CLEANUP_CALLS, JSON.stringify({ cognito: operation }) + '\\n');
export class AdminGetUserCommand { constructor(input) { this.input = input; } }
export class AdminDeleteUserCommand { constructor(input) { this.input = input; } }
export class CognitoIdentityProviderClient {
  constructor() { record('construct'); }
  async send(command) {
    if (command instanceof AdminGetUserCommand) {
      record('get');
      if (process.env.TEST_CLEANUP_PRINCIPAL_DRIFT === 'true') process.env.E2E_AWS_PRINCIPAL_ARN = 'arn:aws:sts::650880818323:assumed-role/beta-infra-deployment-role/foreign';
      return { Username: '${subject}', UserAttributes: [
        { Name: 'email', Value: '${workerEmail}' }, { Name: 'sub', Value: '${subject}' } ] };
    }
    record('delete'); throw new Error('Cognito mutations blocked by cleanup harness');
  }
  destroy() { record('destroy'); }
}
`);
    const preload = join(directory, 'preload.mjs');
    await writeFile(preload, `
import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'node:child_process') return { url: ${JSON.stringify(pathToFileURL(transport).href)}, shortCircuit: true };
  if (specifier === '@aws-sdk/client-cognito-identity-provider') return { url: ${JSON.stringify(pathToFileURL(cognito).href)}, shortCircuit: true };
  return nextResolve(specifier, context);
} });
globalThis.fetch = async () => { throw new Error('Network blocked by cleanup harness'); };
`);
    const environment = { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, TEMP: directory, TMP: directory,
      NODE_OPTIONS: '', AWS_EC2_METADATA_DISABLED: 'true',
      GITHUB_REPOSITORY: 'git-malu/AnyWear-E2E', GITHUB_REPOSITORY_ID: '1317091305',
      GITHUB_REPOSITORY_OWNER: 'git-malu', GITHUB_REPOSITORY_OWNER_ID: '11473072',
      GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch', E2E_STAGE: 'beta', ENABLE_INFRA_E2E: 'true',
      GITHUB_SHA: sourceSha, GITHUB_WORKFLOW_SHA: sourceSha,
      GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-E2E/.github/workflows/account-recovery.yml@refs/heads/main',
      GITHUB_RUN_ID: '123456789', GITHUB_RUN_ATTEMPT: '1', AWS_ACCOUNT_ID: '650880818323', AWS_REGION: 'ap-east-1',
      E2E_CLEANUP_SERVICE_SHA: operatorSha, E2E_AWS_ACCOUNT: '650880818323',
      E2E_AWS_PRINCIPAL_ARN: 'arn:aws:sts::650880818323:assumed-role/beta-e2e-qualification-role/fixture',
      E2E_ACCOUNT_BUDGET_PATH: filename, E2E_SERVICE_CLEANUP_EVIDENCE_PATH: join(directory, 'service-cleanup.json'), USER_POOL_ID: 'fixture-pool',
      TEST_CLEANUP_CALLS: callsFile, TEST_CLEANUP_SOURCE_SHA: sourceSha, TEST_CLEANUP_PRINCIPAL_DRIFT: 'false' };
    const run = async (patch = {}) => {
      await writeFile(callsFile, '');
      let failure;
      try {
        await execute(process.execPath, ['--import', pathToFileURL(preload).href,
          fileURLToPath(new URL(script, import.meta.url))], { env: { ...environment, ...patch }, timeout: 10_000, maxBuffer: 1024 * 1024 });
      } catch (error) { failure = error; }
      assert.ok(failure, 'Cleanup entrypoint must reject the denied principal');
      assert.equal(failure.code, 1); assert.match(failure.stderr, /Authenticated dedicated E2E principal required/);
      assert.equal(await readFile(filename, 'utf8'), original, 'Denied cleanup must retain the account manifest unchanged');
      const calls = (await readFile(callsFile, 'utf8')).trim();
      return calls ? calls.split('\n').map(line => JSON.parse(line)) : [];
    };
    await action(run);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

for (const script of ['./cleanup-worker-accounts.mjs', './delete-recovered-identities.mjs']) {
  test(`${script} rejects missing or foreign captured dedicated principals before Service dispatch or Cognito access`, async () => {
    await withCleanupEntrypoint(script, async (run) => {
      for (const patch of [
        { E2E_AWS_ACCOUNT: undefined }, { E2E_AWS_ACCOUNT: '' }, { E2E_AWS_ACCOUNT: '111111111111' },
        { E2E_AWS_PRINCIPAL_ARN: undefined }, { E2E_AWS_PRINCIPAL_ARN: '' },
        { E2E_AWS_PRINCIPAL_ARN: 'arn:aws:sts::650880818323:assumed-role/beta-infra-deployment-role/fixture' },
        { E2E_AWS_PRINCIPAL_ARN: 'arn:aws:sts::650880818323:assumed-role/beta-service-runtime-role/fixture' },
        { E2E_AWS_PRINCIPAL_ARN: 'arn:aws:sts::111111111111:assumed-role/beta-e2e-qualification-role/fixture' },
        { E2E_AWS_PRINCIPAL_ARN: 'arn:aws:iam::650880818323:role/beta-e2e-qualification-role' },
      ]) assert.deepEqual(await run(patch), [], JSON.stringify(patch));
    });
  });

  test(`${script} rechecks dedicated principal after captured Cognito ownership read and prevents deletion on drift`, async () => {
    await withCleanupEntrypoint(script, async (run) => {
      const calls = await run({ TEST_CLEANUP_PRINCIPAL_DRIFT: 'true' });
      assert.equal(calls.filter(call => call.cognito === 'get').length, 1);
      assert.equal(calls.some(call => call.cognito === 'delete'), false);
      const dispatched = calls.filter(call => call.command?.[1] === 'workflow' && call.command?.[2] === 'run');
      assert.equal(dispatched.length, script === './cleanup-worker-accounts.mjs' ? 1 : 0);
      if (dispatched.length) {
        assert.deepEqual(dispatched[0].command, ['gh', ...serviceCleanupDispatchArgs(createServiceCleanupInputs(manifest()))]);
        assert.ok(calls.indexOf(dispatched[0]) < calls.findIndex(call => call.cognito === 'get'));
      }
    });
  });
}
