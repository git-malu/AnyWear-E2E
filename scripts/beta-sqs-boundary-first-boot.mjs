import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { randomBytes } from 'node:crypto';
import { assertBoundaryFields, boundarySha256, boundaryTimestamp, BOUNDARY_ACCOUNT, BOUNDARY_PRODUCER_SHA,
  BOUNDARY_QUEUE_ARN, BOUNDARY_REGION, canonicalBoundaryJson } from './beta-sqs-boundary-protocol.mjs';
import { BOUNDARY_CONTROLLER_ROLE_ARN, takeBetaBoundaryRunCredentials } from './beta-sqs-boundary-run-context.mjs';
import { requireImmutableBoundaryTrustPin, validateBoundaryTrustPin } from './beta-sqs-boundary-trust.mjs';

export const BOUNDARY_FIRST_BOOT_BUCKET = 'beta-anywear-sqs-control-650880818323-ap-east-1';
const SAFE_FAILURE = 'Beta signer first boot is existing, failed, or unknown; signer loading and restart are refused';

function validateFirstBootContext(context) {
  assertBoundaryFields(context, ['schemaVersion', 'mode', 'runScope', 'accountId', 'region', 'repository', 'environment', 'ref',
    'e2eSha', 'serviceSha', 'roleArn', 'principalArn', 'principalId', 'oidcSubject', 'workflowRef', 'deadline', 'issuedAt', 'oidcIdentityProven']);
  const runId = typeof context.runScope === 'string' && /^([1-9][0-9]{0,19})-1-[a-f0-9]{16}$/.exec(context.runScope)?.[1];
  if (!runId || context.schemaVersion !== 1 || context.accountId !== BOUNDARY_ACCOUNT || context.region !== BOUNDARY_REGION
    || context.repository !== 'git-malu/AnyWear-E2E' || context.environment !== 'beta' || context.ref !== 'refs/heads/main'
    || typeof context.e2eSha !== 'string' || !/^[a-f0-9]{40}$/.test(context.e2eSha) || context.serviceSha !== BOUNDARY_PRODUCER_SHA
    || context.roleArn !== BOUNDARY_CONTROLLER_ROLE_ARN || context.oidcSubject !== 'repo:git-malu/AnyWear-E2E:environment:beta'
    || typeof context.principalArn !== 'string'
    || !new RegExp(`^arn:aws:sts:${BOUNDARY_ACCOUNT}:assumed-role/beta-anywear-sqs-boundary-controller/beta-sqs-${runId}-[a-f0-9]{16}$`).test(context.principalArn)
    || typeof context.principalId !== 'string' || !context.principalId.endsWith(`:${context.principalArn.split('/').at(-1)}`)
    || typeof context.workflowRef !== 'string'
    || !/^git-malu\/AnyWear-E2E\/\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml@refs\/heads\/main$/.test(context.workflowRef)) throw new Error();
  boundaryTimestamp(context.issuedAt); boundaryTimestamp(context.deadline);
}

async function createClaim(context, trustPin, io, mode) {
  try {
    validateFirstBootContext(context);
    const pin = validateBoundaryTrustPin(trustPin);
    let lastTime = -Infinity;
    const fresh = () => {
      const now = io.clock(); const expiry = boundaryTimestamp(context.deadline);
      if (!Number.isFinite(now) || now < lastTime || now < boundaryTimestamp(context.issuedAt)
        || now >= expiry || expiry - now > 15 * 60_000) throw new Error();
      lastTime = now;
      return now;
    };
    const now = fresh(); const nonce = io.nonce();
    if (typeof nonce !== 'string' || !/^[a-f0-9]{64}$/.test(nonce)) throw new Error();
    const marker = Object.freeze({ schemaVersion: 1, kind: 'signer-first-boot', runScope: context.runScope,
      accountId: BOUNDARY_ACCOUNT, region: BOUNDARY_REGION, queueArn: BOUNDARY_QUEUE_ARN,
      repository: context.repository, environment: 'beta', ref: 'refs/heads/main', e2eSha: context.e2eSha, serviceSha: context.serviceSha,
      principalArn: context.principalArn, principalId: context.principalId, oidcSubject: context.oidcSubject,
      workflowRef: context.workflowRef, bootNonce: nonce, issuedAt: new Date(now).toISOString(), deadline: context.deadline,
      keyId: pin.keyId, spkiSha256: pin.spkiSha256 });
    const body = canonicalBoundaryJson(marker); const digest = boundarySha256(body);
    const key = `sqs-boundary/v1/runs/${context.runScope}/signer/first-boot.json`;
    const put = await io.send(new PutObjectCommand({ Bucket: BOUNDARY_FIRST_BOOT_BUCKET, Key: key, ExpectedBucketOwner: BOUNDARY_ACCOUNT,
      IfNoneMatch: '*', Body: body, ContentType: 'application/json', ServerSideEncryption: 'AES256', Metadata: { sha256: digest } }),
    { abortSignal: AbortSignal.timeout(15_000) });
    fresh();
    if (put.$metadata?.httpStatusCode !== 200 || typeof put.ETag !== 'string' || !put.ETag) throw new Error();
    const read = await io.send(new GetObjectCommand({ Bucket: BOUNDARY_FIRST_BOOT_BUCKET, Key: key, ExpectedBucketOwner: BOUNDARY_ACCOUNT }),
      { abortSignal: AbortSignal.timeout(15_000) });
    if (read.$metadata?.httpStatusCode !== 200 || read.ContentType !== 'application/json' || read.ETag !== put.ETag
      || read.Metadata?.sha256 !== digest || read.ContentLength !== Buffer.byteLength(body)
      || read.ContentLength > 8192 || typeof read.Body?.transformToByteArray !== 'function') throw new Error();
    const bytes = await read.Body.transformToByteArray();
    if (bytes.byteLength !== read.ContentLength || Buffer.from(bytes).toString('utf8') !== body) throw new Error();
    fresh();
    return Object.freeze({ mode, marker, markerKey: key, markerSha256: digest,
      durableAuthority: mode === 'durable-beta-first-boot', permitsRestore: false, liveExecutionEnabled: false });
  } catch { throw new Error(SAFE_FAILURE); }
}

export async function claimBetaBoundarySignerFirstBoot(context) {
  const pin = requireImmutableBoundaryTrustPin();
  const credentials = takeBetaBoundaryRunCredentials(context);
  const client = new S3Client({ region: BOUNDARY_REGION, maxAttempts: 1, credentials });
  try { return await createClaim(context, pin, { send: (command, options) => client.send(command, options),
    clock: Date.now, nonce: () => randomBytes(32).toString('hex') }, 'durable-beta-first-boot'); }
  finally { client.destroy(); }
}

export function createSourceOnlyFirstBootHarness(options) {
  assertBoundaryFields(options, ['context', 'trustPin', 'send', 'clock', 'nonce']);
  return Object.freeze({ claim: () => createClaim(options.context, options.trustPin, options, 'source-only-first-boot-fixture') });
}
