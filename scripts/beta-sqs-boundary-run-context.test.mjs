import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { BOUNDARY_PRODUCER_SHA } from './beta-sqs-boundary-protocol.mjs';
import { BOUNDARY_CONTROLLER_ROLE_ARN, createBetaBoundaryRunContext, createSourceOnlyRunContextHarness,
  takeBetaBoundaryRunCredentials } from './beta-sqs-boundary-run-context.mjs';

function fixture(changes = {}) {
  const now = Date.parse('2026-10-07T00:00:00Z'); const e2eSha = 'a'.repeat(40);
  const environment = { GITHUB_REPOSITORY: 'git-malu/AnyWear-E2E', GITHUB_REF: 'refs/heads/main',
    GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: e2eSha,
    BETA_SQS_BOUNDARY_SERVICE_SHA: BOUNDARY_PRODUCER_SHA, BETA_SQS_BOUNDARY_RUN_SCOPE: '123-1-0123456789abcdef',
    BETA_SQS_BOUNDARY_DEADLINE: '2026-10-07T00:05:00Z', ACTIONS_ID_TOKEN_REQUEST_URL: 'https://fixture.actions.githubusercontent.com/oidc',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'fake-request-token', GITHUB_TOKEN: 'fake-repository-token', ...changes.environment };
  const claims = { iss: 'https://token.actions.githubusercontent.com', aud: 'sts.amazonaws.com',
    sub: 'repo:git-malu/AnyWear-E2E:environment:beta', repository: 'git-malu/AnyWear-E2E', environment: 'beta',
    ref: 'refs/heads/main', ref_type: 'branch', run_id: '123', run_attempt: '1', sha: e2eSha, workflow_sha: e2eSha,
    workflow_ref: 'git-malu/AnyWear-E2E/.github/workflows/future-signer.yml@refs/heads/main',
    nbf: now / 1000 - 1, exp: now / 1000 + 600, ...changes.claims };
  const token = `fixture.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.fixture`;
  const calls = []; const configs = []; let destroyed = 0;
  const nonce = '0123456789abcdef'; const sessionName = `beta-sqs-123-${nonce}`;
  const arn = `arn:aws:sts:650880818323:assumed-role/beta-anywear-sqs-boundary-controller/${sessionName}`;
  const id = `AROAFIXTURE:${sessionName}`;
  const harness = createSourceOnlyRunContextHarness({ environment, clock: () => now, nonce: () => nonce,
    fetchJson: async (url) => {
      calls.push({ url });
      if (url.includes('deployment-branch-policies')) return { total_count: 1, branch_policies: [{ name: 'main', type: 'branch' }] };
      if (url.startsWith('https://api.github.com')) return changes.policy ?? { name: 'beta',
        url: 'https://api.github.com/repos/git-malu/AnyWear-E2E/environments/beta',
        deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } };
      return { value: token };
    },
    stsClient: (config) => {
      configs.push(config);
      return { destroy: () => { destroyed += 1; }, send: async (command) => {
        calls.push({ name: command.constructor.name, input: command.input });
        if (changes.serverFailure) throw new Error('private-server-response-sentinel');
        if (command.constructor.name === 'AssumeRoleWithWebIdentityCommand') return {
          Audience: 'sts.amazonaws.com', SubjectFromWebIdentityToken: claims.sub,
          AssumedRoleUser: { Arn: arn, AssumedRoleId: id }, Credentials: { AccessKeyId: `ASIA${'A'.repeat(16)}`,
            SecretAccessKey: 'S'.repeat(40), SessionToken: 'fake-session-token', Expiration: new Date(now + 900_000) }, ...changes.assume };
        return { Account: '650880818323', Arn: arn, UserId: id, ...changes.identity };
      } };
    } });
  return { harness, calls, configs, destroyed: () => destroyed };
}

test('hermetic context binds signed-token-shaped main run and exact server STS subject/role/session/identity without granting live authority', async () => {
  const f = fixture(); const context = await f.harness.attest();
  assert.equal(context.mode, 'source-only-server-response-fixture'); assert.equal(context.oidcIdentityProven, false);
  assert.equal(context.serviceSha, BOUNDARY_PRODUCER_SHA); assert.equal(context.roleArn, BOUNDARY_CONTROLLER_ROLE_ARN);
  const assume = f.calls.find((call) => call.name === 'AssumeRoleWithWebIdentityCommand');
  assert.equal(assume.input.RoleArn, BOUNDARY_CONTROLLER_ROLE_ARN);
  assert.equal(assume.input.RoleSessionName, 'beta-sqs-123-0123456789abcdef');
  assert.equal(assume.input.DurationSeconds, 900);
  assert.ok(f.calls.some((call) => call.name === 'GetCallerIdentityCommand'));
  assert.ok(f.configs.every((config) => config.region === 'ap-east-1' && config.maxAttempts === 1));
  assert.equal(f.destroyed(), 2);
  assert.doesNotMatch(JSON.stringify(context), /SecretAccessKey|secretAccessKey|SessionToken|sessionToken|fake-session-token/);
  assert.throws(() => takeBetaBoundaryRunCredentials(context), /unverified/);
});

test('actual context constructor refuses absent source pin before network, and plain context cannot manufacture credentials', async () => {
  await assert.rejects(() => createBetaBoundaryRunContext({ verified: true }), /Immutable source trust root is missing/);
  assert.throws(() => takeBetaBoundaryRunCredentials({ mode: 'server-attested-beta-run', oidcIdentityProven: true }), /unverified/);
});

test('foreign repo/ref/env/run/sha/workflow and stale token claims cannot bind even successful-looking STS replies', async () => {
  for (const claims of [{ repository: 'foreign/repo' }, { ref: 'refs/heads/other' }, { environment: 'prod' }, { run_id: '124' },
    { run_attempt: '2' }, { sha: 'b'.repeat(40) }, { workflow_sha: 'b'.repeat(40) },
    { workflow_ref: 'foreign/repo/.github/workflows/a.yml@refs/heads/main' }, { exp: 1 }, { nbf: 9_000_000_000 },
    { sub: 'repo:git-malu/AnyWear-E2E:ref:refs/heads/main' }, { aud: 'foreign' }]) {
    const f = fixture({ claims });
    await assert.rejects(() => f.harness.attest(), /unverified/);
  }
});

test('unprotected environment, attempted restarts and foreign OIDC URL fail before any AWS call', async () => {
  for (const changes of [{ policy: { name: 'beta', deployment_branch_policy: null } },
    { environment: { GITHUB_RUN_ATTEMPT: '2' } }, { environment: { GITHUB_REF: 'refs/heads/other' } },
    { environment: { ACTIONS_ID_TOKEN_REQUEST_URL: 'https://evil.example/token' } },
    { environment: { BETA_SQS_BOUNDARY_RUN_SCOPE: '124-1-0123456789abcdef' } },
    { environment: { BETA_SQS_BOUNDARY_SERVICE_SHA: 'b'.repeat(40) } }]) {
    const f = fixture(changes); await assert.rejects(() => f.harness.attest(), /unverified/);
    assert.equal(f.configs.length, 0);
  }
});

test('role name alone, foreign account/session/principal, changed audience and server failure never grant context', async () => {
  for (const changes of [{ assume: { SubjectFromWebIdentityToken: 'foreign-subject' } }, { assume: { Audience: 'foreign' } },
    { assume: { AssumedRoleUser: { Arn: BOUNDARY_CONTROLLER_ROLE_ARN, AssumedRoleId: 'role-name-only' } } },
    { identity: { Account: '123456789012' } }, { identity: { Arn: 'foreign-session' } },
    { identity: { UserId: 'changed-principal' } }, { serverFailure: true }]) {
    const f = fixture(changes);
    await assert.rejects(() => f.harness.attest(), (error) => error.message === 'Beta signer run identity is unverified; boundary remains disarmed');
    assert.ok(f.calls.filter((call) => call.name === 'AssumeRoleWithWebIdentityCommand').length <= 1);
  }
});

test('context source uses official server STS verification, memory-only credentials and no file/log/CLI operations', async () => {
  const source = await readFile(new URL('./beta-sqs-boundary-run-context.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /node:fs|node:child_process|console\.|writeFile|process\.stdout|process\.stderr/);
  assert.match(source, /AssumeRoleWithWebIdentityCommand/); assert.match(source, /GetCallerIdentityCommand/);
});
