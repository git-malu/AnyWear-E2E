import { AssumeRoleWithWebIdentityCommand, GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { randomBytes } from 'node:crypto';
import { assertBoundaryFields, boundaryTimestamp, BOUNDARY_ACCOUNT, BOUNDARY_PRODUCER_SHA, BOUNDARY_REGION } from './beta-sqs-boundary-protocol.mjs';
import { assertMainOnlyBoundaryEnvironment, BOUNDARY_SIGNING_LOCATION, requireImmutableBoundaryTrustPin } from './beta-sqs-boundary-trust.mjs';

export const BOUNDARY_CONTROLLER_ROLE_ARN = 'arn:aws:iam::650880818323:role/beta-anywear-sqs-boundary-controller';
const SUBJECT = 'repo:git-malu/AnyWear-E2E:environment:beta';
const SAFE_FAILURE = 'Beta signer run identity is unverified; boundary remains disarmed';
const credentialsByContext = new WeakMap();

async function fetchBoundedJson(url, options) {
  const response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(15_000) });
  if (!response.ok || !response.body) throw new Error();
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 65_536) { await response.body.cancel().catch(() => {}); throw new Error(); }
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function validateEnvironment(environment, now) {
  if (environment.GITHUB_REPOSITORY !== BOUNDARY_SIGNING_LOCATION.repository || environment.GITHUB_REF !== 'refs/heads/main'
    || environment.GITHUB_EVENT_NAME !== 'workflow_dispatch' || environment.GITHUB_RUN_ATTEMPT !== '1'
    || !/^[1-9][0-9]{0,19}$/.test(environment.GITHUB_RUN_ID ?? '') || !/^[a-f0-9]{40}$/.test(environment.GITHUB_SHA ?? '')
    || environment.BETA_SQS_BOUNDARY_SERVICE_SHA !== BOUNDARY_PRODUCER_SHA
    || !new RegExp(`^${environment.GITHUB_RUN_ID}-1-[a-f0-9]{16}$`).test(environment.BETA_SQS_BOUNDARY_RUN_SCOPE ?? '')) throw new Error();
  const deadline = boundaryTimestamp(environment.BETA_SQS_BOUNDARY_DEADLINE);
  if (!Number.isFinite(now) || deadline <= now || deadline - now > 15 * 60_000) throw new Error();
  const oidcUrl = new URL(environment.ACTIONS_ID_TOKEN_REQUEST_URL);
  if (oidcUrl.protocol !== 'https:' || !oidcUrl.hostname.endsWith('.actions.githubusercontent.com')
    || oidcUrl.username || oidcUrl.password || oidcUrl.port || oidcUrl.hash
    || typeof environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN !== 'string' || !environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN
    || typeof environment.GITHUB_TOKEN !== 'string' || !environment.GITHUB_TOKEN) throw new Error();
  oidcUrl.searchParams.set('audience', 'sts.amazonaws.com');
  return { oidcUrl: oidcUrl.href, deadline };
}

function authenticatedClaims(token, environment, now) {
  const parts = typeof token === 'string' && token.length <= 32_768 ? token.split('.') : [];
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) throw new Error();
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  if (claims.iss !== 'https://token.actions.githubusercontent.com' || claims.aud !== 'sts.amazonaws.com' || claims.sub !== SUBJECT
    || claims.repository !== BOUNDARY_SIGNING_LOCATION.repository || claims.environment !== 'beta'
    || claims.ref !== 'refs/heads/main' || claims.ref_type !== 'branch' || claims.run_id !== environment.GITHUB_RUN_ID
    || claims.run_attempt !== '1' || claims.sha !== environment.GITHUB_SHA || claims.workflow_sha !== environment.GITHUB_SHA
    || typeof claims.workflow_ref !== 'string'
    || !/^git-malu\/AnyWear-E2E\/\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml@refs\/heads\/main$/.test(claims.workflow_ref)
    || !Number.isSafeInteger(claims.exp) || !Number.isSafeInteger(claims.nbf) || claims.nbf * 1000 > now
    || claims.exp * 1000 <= now) throw new Error();
  return claims;
}

async function attestRun(environment, io, mode) {
  let initialClient;
  let identityClient;
  try {
    const now = io.clock(); const { oidcUrl, deadline } = validateEnvironment(environment, now);
    const api = 'https://api.github.com/repos/git-malu/AnyWear-E2E/environments/beta';
    const headers = { Authorization: `Bearer ${environment.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' };
    const policy = await io.fetchJson(api, { headers });
    const branches = await io.fetchJson(`${api}/deployment-branch-policies?per_page=100`, { headers });
    assertMainOnlyBoundaryEnvironment(policy, branches);
    const tokenResponse = await io.fetchJson(oidcUrl, { headers: { Authorization: `Bearer ${environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` } });
    const token = tokenResponse?.value;
    // Decoding does not authenticate. STS must verify this same token before its claims grant authority.
    const claims = authenticatedClaims(token, environment, io.clock());
    const sessionName = `beta-sqs-${environment.GITHUB_RUN_ID}-${io.nonce()}`;
    if (!/^beta-sqs-[1-9][0-9]{0,19}-[a-f0-9]{16}$/.test(sessionName)) throw new Error();
    initialClient = io.stsClient({ region: BOUNDARY_REGION, maxAttempts: 1 });
    const response = await initialClient.send(new AssumeRoleWithWebIdentityCommand({ RoleArn: BOUNDARY_CONTROLLER_ROLE_ARN,
      RoleSessionName: sessionName, WebIdentityToken: token, DurationSeconds: 900 }), { abortSignal: AbortSignal.timeout(15_000) });
    const expectedArn = `arn:aws:sts:${BOUNDARY_ACCOUNT}:assumed-role/beta-anywear-sqs-boundary-controller/${sessionName}`;
    const credentials = response.Credentials;
    if (response.SubjectFromWebIdentityToken !== claims.sub || response.Audience !== 'sts.amazonaws.com'
      || response.AssumedRoleUser?.Arn !== expectedArn || typeof response.AssumedRoleUser?.AssumedRoleId !== 'string'
      || !response.AssumedRoleUser.AssumedRoleId.endsWith(`:${sessionName}`)
      || !/^ASIA[A-Z0-9]{16}$/.test(credentials?.AccessKeyId ?? '') || typeof credentials?.SecretAccessKey !== 'string'
      || credentials.SecretAccessKey.length !== 40 || typeof credentials.SessionToken !== 'string' || !credentials.SessionToken
      || !(credentials.Expiration instanceof Date) || credentials.Expiration.getTime() < deadline) throw new Error();
    const sessionCredentials = { accessKeyId: credentials.AccessKeyId, secretAccessKey: credentials.SecretAccessKey,
      sessionToken: credentials.SessionToken, expiration: credentials.Expiration };
    identityClient = io.stsClient({ region: BOUNDARY_REGION, maxAttempts: 1, credentials: sessionCredentials });
    const identity = await identityClient.send(new GetCallerIdentityCommand({}), { abortSignal: AbortSignal.timeout(15_000) });
    if (identity.Account !== BOUNDARY_ACCOUNT || identity.Arn !== expectedArn || identity.UserId !== response.AssumedRoleUser.AssumedRoleId
      || io.clock() >= deadline) throw new Error();
    const context = Object.freeze({ schemaVersion: 1, mode, runScope: environment.BETA_SQS_BOUNDARY_RUN_SCOPE,
      accountId: BOUNDARY_ACCOUNT, region: BOUNDARY_REGION, repository: BOUNDARY_SIGNING_LOCATION.repository, environment: 'beta',
      ref: 'refs/heads/main', e2eSha: claims.sha, serviceSha: BOUNDARY_PRODUCER_SHA,
      roleArn: BOUNDARY_CONTROLLER_ROLE_ARN, principalArn: identity.Arn, principalId: identity.UserId,
      oidcSubject: SUBJECT, workflowRef: claims.workflow_ref, deadline: environment.BETA_SQS_BOUNDARY_DEADLINE,
      issuedAt: new Date(io.clock()).toISOString(), oidcIdentityProven: mode === 'server-attested-beta-run' });
    if (mode === 'server-attested-beta-run') credentialsByContext.set(context, sessionCredentials);
    return context;
  } catch { throw new Error(SAFE_FAILURE); }
  finally { initialClient?.destroy(); identityClient?.destroy(); }
}

export async function createBetaBoundaryRunContext() {
  requireImmutableBoundaryTrustPin();
  return attestRun(process.env, { fetchJson: fetchBoundedJson, stsClient: (config) => new STSClient(config),
    clock: Date.now, nonce: () => randomBytes(8).toString('hex') }, 'server-attested-beta-run');
}

export function takeBetaBoundaryRunCredentials(context) {
  const credentials = credentialsByContext.get(context);
  credentialsByContext.delete(context);
  if (!credentials || context.mode !== 'server-attested-beta-run') throw new Error(SAFE_FAILURE);
  return credentials;
}

export function createSourceOnlyRunContextHarness(options) {
  assertBoundaryFields(options, ['environment', 'fetchJson', 'stsClient', 'clock', 'nonce']);
  return Object.freeze({ attest: () => attestRun(options.environment, options, 'source-only-server-response-fixture') });
}
