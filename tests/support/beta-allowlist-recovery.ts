import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { awsJson, buildBetaRecoveryManifest, cognitoCleanupIo } from './beta-allowlist-session.ts';
import { deleteCapturedCognitoIdentity, verifyCapturedCognitoIdentity } from './cognito-cleanup.ts';

const exec = promisify(execFile);
const uuidShape = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
type RecoveryManifest = ReturnType<typeof buildBetaRecoveryManifest>;
type AdmissionSnapshot = { intake_open: string; admission_suspended: string; tester_allowlist: string };

function exactRecord(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some((key) => !(key in value))) {
    throw new Error('Recovery manifest must contain only its explicit resource fields');
  }
  return value as Record<string, unknown>;
}

export function parseBetaRecoveryManifest(json: string): RecoveryManifest {
  if (Buffer.byteLength(json, 'utf8') > 16_384) throw new Error('Recovery manifest exceeds its bounded payload size');
  const manifest = exactRecord(JSON.parse(json), ['schema_version', 'record_type', 'stage', 'aws_account_id', 'aws_region',
    'run_scope', 'service_commit', 'image_digest', 'user_pool_id', 'users', 'cognito_users', 'objects', 'cleanup_completed']);
  if (manifest.schema_version !== 1 || manifest.record_type !== 'anywear_beta_allowlist_recovery'
    || manifest.stage !== 'beta' || manifest.aws_account_id !== '650880818323' || manifest.aws_region !== 'ap-east-1'
    || typeof manifest.run_scope !== 'string' || !/^[1-9][0-9]{0,19}-[1-9][0-9]{0,5}-[a-f0-9]{16}$/.test(manifest.run_scope)
    || typeof manifest.service_commit !== 'string' || !/^[a-f0-9]{40}$/.test(manifest.service_commit)
    || typeof manifest.image_digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(manifest.image_digest)
    || typeof manifest.user_pool_id !== 'string' || !/^ap-east-1_[a-zA-Z0-9]+$/.test(manifest.user_pool_id)
    || typeof manifest.cleanup_completed !== 'boolean') throw new Error('Recovery requires an exact Beta deployment and run scope');
  const emailPattern = new RegExp(`^e2e-beta-allowlist-${manifest.run_scope}-[a-z][a-z0-9]{0,23}@anywear\\.local$`);
  const validEmail = (value: unknown): value is string => typeof value === 'string'
    && emailPattern.test(value) && value.split('@')[0].length <= 64;
  for (const name of ['users', 'cognito_users', 'objects']) {
    if (!Array.isArray(manifest[name]) || manifest[name].length > 50) throw new Error('Recovery lists must contain at most fifty exact resources');
  }
  const users = (manifest.users as unknown[]).map((value) => {
    const user = exactRecord(value, ['email', 'sub']);
    if (!validEmail(user.email) || typeof user.sub !== 'string' || !uuidShape.test(user.sub)) {
      throw new Error('Recovery database users must match the synthetic scope and UUID-shaped Cognito subject');
    }
    return { email: user.email, sub: user.sub };
  });
  const cognitoUsers = (manifest.cognito_users as unknown[]).map((value) => {
    const user = exactRecord(value, ['email', 'sub']);
    if (!validEmail(user.email) || typeof user.sub !== 'string' || !uuidShape.test(user.sub)) {
      throw new Error('Recovery Cognito users require a captured subject from the current synthetic scope');
    }
    return { email: user.email, sub: user.sub };
  });
  if (new Set(users.map(({ email }) => email)).size !== users.length || new Set(users.map(({ sub }) => sub)).size !== users.length
    || new Set(cognitoUsers.map(({ email }) => email)).size !== cognitoUsers.length
    || new Set(cognitoUsers.map(({ sub }) => sub)).size !== cognitoUsers.length || users.length !== cognitoUsers.length
    || users.some(({ email, sub }) => !cognitoUsers.some((user) => user.email === email && user.sub === sub))) throw new Error('Recovery identities must be unique and consistent');
  const objects = (manifest.objects as unknown[]).map((value) => {
    const object = exactRecord(value, ['bucket', 'key']);
    const segments = typeof object.key === 'string' ? object.key.split('/') : [];
    if (typeof object.bucket !== 'string' || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(object.bucket)
      || segments.length !== 4 || !['wearable-items', 'base-photos'].includes(segments[0])
      || !users.some(({ sub }) => sub === segments[1]) || !uuidShape.test(segments[2])
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.(png|jpe?g|webp)$/.test(segments[3])) {
      throw new Error('Recovery S3 keys must be exact fixture paths beneath an owned synthetic subject');
    }
    return { bucket: object.bucket, key: object.key as string };
  });
  if (new Set(objects.map(({ bucket, key }) => `${bucket}/${key}`)).size !== objects.length) throw new Error('Recovery S3 objects must be unique');
  return { ...manifest, users, cognito_users: cognitoUsers, objects } as RecoveryManifest;
}

export function assertRecoveryBinding(manifest: RecoveryManifest, health: Record<string, unknown>, poolId: string, bucket: string): void {
  if (health.status !== 'ok' || health.service_commit !== manifest.service_commit || health.image_digest !== manifest.image_digest
    || typeof health.schema_version !== 'number' || health.schema_version < 16) throw new Error('Recovery helper must match the currently ready Beta revision and schema');
  if (manifest.user_pool_id !== poolId || manifest.objects.some((object) => object.bucket !== bucket)) {
    throw new Error('Recovery identity pool and captured buckets must match the deployed Beta platform');
  }
}

interface RecoveryIo {
  policy(): Promise<AdmissionSnapshot>;
  verifyIdentity(email: string, sub: string): Promise<void>;
  cleanup(): Promise<void>;
  deleteObject(bucket: string, key: string): Promise<void>;
  deleteIdentity(email: string, sub: string): Promise<void>;
}

export async function recoverManifestResources(manifest: RecoveryManifest, io: RecoveryIo): Promise<void> {
  const before = await io.policy();
  if (before.intake_open !== 'false' || before.admission_suspended !== 'true'
    || !Array.isArray(JSON.parse(before.tester_allowlist))) throw new Error('Recovery requires suspended Beta admission with public intake closed');
  const errors: unknown[] = [];
  try {
    for (const { email, sub } of manifest.cognito_users) await io.verifyIdentity(email, sub);
    await io.cleanup();
    for (const { bucket, key } of manifest.objects) await io.deleteObject(bucket, key);
    for (const { email, sub } of manifest.cognito_users) await io.deleteIdentity(email, sub);
  } catch (error) { errors.push(error); }
  try {
    const after = await io.policy();
    if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error('Recovery admission policy changed during resource cleanup');
  } catch (error) { errors.push(error); }
  if (errors.length > 0) throw new AggregateError(errors, 'Beta recovery failed; retained resources need investigation');
}

async function readPolicy(): Promise<AdmissionSnapshot> {
  const entries = await Promise.all(['intake_open', 'admission_suspended', 'tester_allowlist'].map(async (name) => {
    const response = await awsJson(['ssm', 'get-parameter', '--name', `/anywear/beta/${name}`]);
    return [name, (response.Parameter as { Value: string }).Value];
  }));
  return Object.fromEntries(entries) as AdmissionSnapshot;
}

async function recoverLive(): Promise<void> {
  if (process.env.E2E_STAGE !== 'beta' || process.env.AWS_ACCOUNT_ID !== '650880818323'
    || process.env.AWS_REGION !== 'ap-east-1' || process.env.GITHUB_REPOSITORY !== 'git-malu/AnyWear-Service'
    || process.env.BETA_ALLOWLIST_LOCK !== 'service-runtime-workflow') throw new Error('Recovery only runs under the protected Beta Service runtime lock');
  const manifest = parseBetaRecoveryManifest(process.env.BETA_ALLOWLIST_RECOVERY_JSON ?? '');
  const identity = await awsJson(['sts', 'get-caller-identity']);
  if (identity.Account !== manifest.aws_account_id) throw new Error('Recovery AWS identity is outside Beta NonProd');
  const checkout = process.env.E2E_SERVICE_CHECKOUT;
  if (!checkout) throw new Error('Recovery requires the pinned Service operator checkout');
  const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd: checkout });
  if (stdout.trim() !== manifest.service_commit) throw new Error('Recovery operator checkout differs from the manifest revision');
  const [platform, workload, pool] = await Promise.all([
    awsJson(['cloudformation', 'describe-stacks', '--stack-name', 'AnyWearPlatformStack-beta']),
    awsJson(['cloudformation', 'describe-stacks', '--stack-name', 'AnyWearWorkloadStack-beta']),
    awsJson(['ssm', 'get-parameter', '--name', '/anywear/beta/cognito_user_pool_id']),
  ]);
  const outputs = Object.fromEntries((platform.Stacks as { Outputs: { OutputKey: string; OutputValue: string }[] }[])[0].Outputs
    .map(({ OutputKey, OutputValue }) => [OutputKey, OutputValue]));
  const workloadOutputs = Object.fromEntries((workload.Stacks as { Outputs: { OutputKey: string; OutputValue: string }[] }[])[0].Outputs
    .map(({ OutputKey, OutputValue }) => [OutputKey, OutputValue]));
  if (outputs.BetaActive !== 'true' || outputs.EcsClusterName !== 'beta-anywear') throw new Error('Recovery requires the active Beta platform');
  const serviceUrl = new URL(process.env.E2E_SERVICE_URL ?? '');
  if (serviceUrl.protocol !== 'https:' || serviceUrl.origin !== workloadOutputs.ApiBaseUrl || workloadOutputs.BetaActive !== 'true') {
    throw new Error('Recovery readiness must use the active deployed Beta HTTPS service');
  }
  const response = await fetch(new URL('/readyz', serviceUrl), { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error('Beta readiness failed before recovery');
  assertRecoveryBinding(manifest, await response.json() as Record<string, unknown>, (pool.Parameter as { Value: string }).Value, outputs.WardrobeBucketName);
  const cognito = cognitoCleanupIo(manifest.user_pool_id);
  await recoverManifestResources(manifest, {
    policy: readPolicy,
    async verifyIdentity(email, sub) { await verifyCapturedCognitoIdentity({ email, sub }, cognito); },
    async cleanup() {
      try {
        const result = await exec('bash', ['.github/scripts/run-one-shot-task.sh', 'beta', 'tester-cleanup',
          manifest.image_digest, manifest.service_commit, '', JSON.stringify({ runScope: manifest.run_scope, users: manifest.users })],
        { cwd: checkout, maxBuffer: 10 * 1024 * 1024 });
        process.stdout.write(result.stdout);
        process.stderr.write(result.stderr);
      } catch { throw new Error('Pinned Beta database cleanup refused recovery; no S3 or Cognito resources were deleted'); }
    },
    async deleteObject(bucket, key) {
      await awsJson(['s3api', 'delete-object', '--bucket', bucket, '--key', key]);
      try { await awsJson(['s3api', 'head-object', '--bucket', bucket, '--key', key]); }
      catch (error) { if (/\(404\)|Not Found/.test((error as Error).message)) return; throw error; }
      throw new Error('Captured fixture object still exists after recovery');
    },
    deleteIdentity: (email, sub) => deleteCapturedCognitoIdentity({ email, sub }, cognito),
  });
  console.log('Recovered only the manifest synthetic records, captured S3 objects, and Cognito identities; admission policy unchanged');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href && process.argv[2] === '--recover-manifest') {
  await recoverLive();
}
