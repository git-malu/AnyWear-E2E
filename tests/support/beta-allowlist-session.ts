import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { deleteCapturedCognitoIdentity, verifyCapturedCognitoIdentity, type CapturedIdentity, type CognitoCleanupIo } from './cognito-cleanup.ts';

const exec = promisify(execFile);
const parameterPrefix = '/anywear/beta/';

interface SyntheticIdentity { email: string; sub?: string }
interface SessionState {
  runScope: string;
  serviceCommit: string;
  imageDigest: string;
  original: { testerEmails: string[]; admissionSuspended: boolean };
  identities: SyntheticIdentity[];
  objects: { bucket: string; key: string }[];
  restored: boolean;
}

interface CleanupIo {
  oneShot(role: 'lifecycle' | 'tester-cleanup', action: string, payload?: string): Promise<void>;
  verifyIdentity(email: string, sub: string): Promise<void>;
  deleteObject(bucket: string, key: string): Promise<void>;
  deleteIdentity(email: string, sub: string): Promise<void>;
  save(): Promise<void>;
}

export function buildBetaRecoveryManifest(state: SessionState, userPoolId: string) {
  const captured = state.identities.filter((identity): identity is CapturedIdentity => typeof identity.sub === 'string')
    .map(({ email, sub }) => ({ email, sub }));
  return {
    schema_version: 1,
    record_type: 'anywear_beta_allowlist_recovery',
    stage: 'beta',
    aws_account_id: '650880818323',
    aws_region: 'ap-east-1',
    run_scope: state.runScope,
    service_commit: state.serviceCommit,
    image_digest: state.imageDigest,
    user_pool_id: userPoolId,
    users: captured,
    cognito_users: captured.map(({ email, sub }) => ({ email, sub })),
    objects: state.objects.map(({ bucket, key }) => ({ bucket, key })),
    cleanup_completed: state.restored,
  };
}

export async function restoreBetaSession(state: SessionState, io: CleanupIo): Promise<void> {
  if (state.restored) return;
  const errors: unknown[] = [];
  const attempt = async (action: () => Promise<void>) => { try { await action(); } catch (error) { errors.push(error); } };
  await attempt(() => io.oneShot('lifecycle', 'close'));
  const users = state.identities.filter((identity): identity is CapturedIdentity => typeof identity.sub === 'string');
  let identitiesVerified = true;
  for (const { email, sub } of users) await attempt(async () => {
    try { await io.verifyIdentity(email, sub); }
    catch (error) { identitiesVerified = false; throw error; }
  });
  let recordsCleaned = identitiesVerified && users.length === 0;
  if (identitiesVerified && users.length > 0) await attempt(async () => {
    await io.oneShot('tester-cleanup', '', JSON.stringify({ runScope: state.runScope, users }));
    recordsCleaned = true;
  });
  for (const { bucket, key } of recordsCleaned ? state.objects : []) {
    await attempt(() => io.deleteObject(bucket, key));
  }
  for (const { email, sub } of recordsCleaned ? users : []) {
    await attempt(() => io.deleteIdentity(email, sub));
  }
  await attempt(() => io.oneShot('lifecycle', 'configure-testers', JSON.stringify(state.original.testerEmails)));
  if (state.original.admissionSuspended) await attempt(() => io.oneShot('lifecycle', 'close'));
  if (errors.length > 0) throw new AggregateError(errors, 'Beta acceptance cleanup or original policy restoration failed');
  state.restored = true;
  await io.save();
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing controlled Beta test setting: ${name}`);
  return value;
}

function assertEnvironment(): void {
  if (process.env.E2E_STAGE !== 'beta' || process.env.AWS_ACCOUNT_ID !== '650880818323'
    || process.env.AWS_REGION !== 'ap-east-1') throw new Error('Allowlist acceptance only targets Beta NonProd in ap-east-1');
  if (process.env.BETA_ALLOWLIST_LOCK !== 'service-runtime-workflow'
    || process.env.GITHUB_REPOSITORY !== 'git-malu/AnyWear-Service') {
    throw new Error('Run allowlist acceptance through the protected Service workflow holding anywear-beta-runtime');
  }
}

export async function awsJson(args: string[]): Promise<Record<string, unknown>> {
  const { stdout } = await exec('aws', [...args, '--output', 'json'], { maxBuffer: 10 * 1024 * 1024 });
  return stdout.trim() ? JSON.parse(stdout) as Record<string, unknown> : {};
}

export class BetaAllowlistSession {
  readonly state: SessionState;

  private constructor(state: SessionState) { this.state = state; }

  static async start(): Promise<BetaAllowlistSession> {
    assertEnvironment();
    const identity = await awsJson(['sts', 'get-caller-identity']);
    if (identity.Account !== '650880818323') throw new Error('AWS identity is outside Beta NonProd');
    const serviceCommit = required('SERVICE_COMMIT_SHA');
    if (!/^[a-f0-9]{40}$/.test(serviceCommit)) throw new Error('Service revision must be a full SHA');
    const checkout = required('E2E_SERVICE_CHECKOUT');
    const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd: checkout });
    if (stdout.trim() !== serviceCommit) throw new Error('Operator helper checkout differs from pinned Service SHA');
    const response = await fetch(`${required('E2E_SERVICE_URL')}/readyz`, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error('Beta readiness failed');
    const health = await response.json() as { status: string; service_commit: string; image_digest: string; schema_version: number };
    if (health.status !== 'ok' || health.service_commit !== serviceCommit || health.schema_version < 16
      || !/^sha256:[a-f0-9]{64}$/.test(health.image_digest)) throw new Error('Beta readiness does not match allowlist candidate schema and revision');
    const parameters = await Promise.all(['intake_open', 'tester_allowlist', 'admission_suspended']
      .map((name) => awsJson(['ssm', 'get-parameter', '--name', `${parameterPrefix}${name}`])));
    const values = Object.fromEntries(parameters.map((response) => {
      const parameter = response.Parameter as { Name: string; Value: string };
      return [parameter.Name, parameter.Value];
    }));
    if (values[`${parameterPrefix}intake_open`] !== 'false') throw new Error('Controlled private-tester acceptance requires public intake closed');
    const testerEmails: unknown = JSON.parse(values[`${parameterPrefix}tester_allowlist`] ?? 'null');
    const suspension = values[`${parameterPrefix}admission_suspended`];
    if (!Array.isArray(testerEmails) || testerEmails.some((email) => typeof email !== 'string')
      || testerEmails.length > 48 || !['true', 'false'].includes(suspension)) throw new Error('Original Beta policy must be valid and leave two tester slots');
    if (suspension === 'true' && testerEmails.length > 0) throw new Error('Resume intentionally suspended existing testers before controlled acceptance');
    const runScope = `${required('GITHUB_RUN_ID')}-${required('GITHUB_RUN_ATTEMPT')}-${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const session = new BetaAllowlistSession({
      runScope, serviceCommit, imageDigest: health.image_digest,
      original: { testerEmails: testerEmails as string[], admissionSuspended: suspension === 'true' },
      identities: ['primary', 'probe'].map((label) => ({ email: `e2e-beta-allowlist-${runScope}-${label}@anywear.local` })),
      objects: [], restored: false,
    });
    if (session.state.identities.some(({ email }) => email.split('@')[0].length > 64)) {
      throw new Error('Synthetic tester email exceeds the SMTP local-part limit');
    }
    await session.save();
    await session.configure(session.state.original.testerEmails.concat(session.state.identities.map(({ email }) => email)));
    return session;
  }

  static async resume(): Promise<BetaAllowlistSession | undefined> {
    assertEnvironment();
    try {
      const state = JSON.parse(await readFile(required('BETA_ALLOWLIST_STATE_PATH'), 'utf8')) as SessionState;
      if (state.serviceCommit !== required('SERVICE_COMMIT_SHA')) throw new Error('Cleanup snapshot belongs to another Service revision');
      return new BetaAllowlistSession(state);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private async save(): Promise<void> {
    await writeFile(required('BETA_ALLOWLIST_STATE_PATH'), `${JSON.stringify(this.state)}\n`, { mode: 0o600 });
  }

  private async oneShot(role: 'lifecycle' | 'tester-cleanup', action: string, payload?: string): Promise<void> {
    try {
      const { stdout, stderr } = await exec('bash', ['.github/scripts/run-one-shot-task.sh', 'beta', role,
        this.state.imageDigest, this.state.serviceCommit, action, ...(payload === undefined ? [] : [payload])], {
        cwd: required('E2E_SERVICE_CHECKOUT'), maxBuffer: 10 * 1024 * 1024,
      });
      process.stdout.write(stdout);
      process.stderr.write(stderr);
    } catch {
      throw new Error(`Pinned Beta ${role} helper failed; inspect redacted one-shot logs`);
    }
  }

  async configure(emails: string[]): Promise<void> {
    await this.oneShot('lifecycle', 'configure-testers', JSON.stringify(emails));
  }

  async suspend(): Promise<void> { await this.oneShot('lifecycle', 'close'); }

  async recordIdentity(email: string, sub: string): Promise<void> {
    const pattern = new RegExp(`^e2e-beta-allowlist-${this.state.runScope}-(primary|probe|unlisted)@anywear\\.local$`);
    if (!pattern.test(email) || email.split('@')[0].length > 64
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(sub)) throw new Error('Only current synthetic identities may be cleaned up');
    let identity = this.state.identities.find((entry) => entry.email === email);
    if (!identity) { identity = { email }; this.state.identities.push(identity); }
    if (identity.sub && identity.sub !== sub) throw new Error('Captured synthetic subject changed; cleanup ownership must not be overwritten');
    identity.sub = sub;
    await this.save();
  }

  async recordObject(key: string): Promise<void> {
    const stack = await awsJson(['cloudformation', 'describe-stacks', '--stack-name', 'AnyWearPlatformStack-beta']);
    const outputs = (stack.Stacks as { Outputs: { OutputKey: string; OutputValue: string }[] }[])[0].Outputs;
    const bucket = outputs.find((entry) => entry.OutputKey === 'WardrobeBucketName')?.OutputValue;
    if (!bucket || !key || key.startsWith('/')) throw new Error('Created S3 object must have an exact captured Beta bucket/key');
    this.state.objects.push({ bucket, key });
    await this.save();
  }

  async restore(): Promise<void> {
    const cognito = cognitoCleanupIo(required('USER_POOL_ID'));
    await restoreBetaSession(this.state, {
      oneShot: (role, action, payload) => this.oneShot(role, action, payload),
      async verifyIdentity(email, sub) { await verifyCapturedCognitoIdentity({ email, sub }, cognito); },
      async deleteObject(bucket, key) {
        await awsJson(['s3api', 'delete-object', '--bucket', bucket, '--key', key]);
        try {
          await awsJson(['s3api', 'head-object', '--bucket', bucket, '--key', key]);
        } catch (error) {
          if (/\(404\)|Not Found/.test((error as Error).message)) return;
          throw error;
        }
        throw new Error('Captured synthetic S3 object still exists after cleanup');
      },
      deleteIdentity: (email, sub) => deleteCapturedCognitoIdentity({ email, sub }, cognito),
      save: () => this.save(),
    });
  }
}

export function cognitoCleanupIo(userPoolId: string): CognitoCleanupIo {
  return {
    getUser: async (username) => awsJson(['cognito-idp', 'admin-get-user', '--user-pool-id', userPoolId, '--username', username]),
    async deleteUser(username) { await awsJson(['cognito-idp', 'admin-delete-user', '--user-pool-id', userPoolId, '--username', username]); },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href && process.argv[2] === '--restore') {
  const session = await BetaAllowlistSession.resume();
  if (session) await session.restore();
}
