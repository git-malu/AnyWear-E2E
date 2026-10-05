import { AdminDeleteUserCommand, AdminGetUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { cleanupOneShotDefinitions, recoverOneShotRegistrations } from './runtime-one-shot.mjs';
import { pauseRuntimeWindow, reconcilePendingPolicy, restoreRuntimeWindow } from './runtime-window-controls.mjs';
import { restoreNonPaidRuntime } from './nonpaid-runtime-controls.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const RECORD_KEYS = ['schema_version', 'record_type', 'stage', 'aws_account_id', 'aws_region', 'run_scope', 'marker',
  'user_pool_id', 'users', 'items', 'resources', 'runtime_control', 'known_dlq_message', 'owned_cleanup_completed',
  'runtime_window', 'one_shots', 'stack', 'service_url', 'deployment', 'database_cleanup_completed', 'cleanup_evidence'];

export function parseRuntimeRecovery(json) {
  if (Buffer.byteLength(json) > 262_144) throw new Error('Runtime recovery record exceeds its bounded size');
  const record = JSON.parse(json);
  if (!record || Object.keys(record).some((key) => !RECORD_KEYS.includes(key)) || record.schema_version !== 2
    || record.record_type !== 'anywear_beta_runtime_recovery' || record.stage !== 'beta'
    || record.aws_account_id !== '650880818323' || record.aws_region !== 'ap-east-1'
    || !/^[1-9][0-9]{0,19}-[1-9][0-9]{0,5}-[a-f0-9]{16}$/.test(record.run_scope ?? '')
    || !/^beta-runtime-[a-z0-9-]+$/.test(record.marker ?? '') || record.users?.length !== 1
    || !/^ap-east-1_[a-zA-Z0-9]+$/.test(record.user_pool_id ?? '')
    || !/^[a-f0-9]{40}$/.test(record.deployment?.service?.source_commit ?? '')
    || !/^sha256:[a-f0-9]{64}$/.test(record.deployment.service.image_digest ?? '')
    || record.stack?.cluster !== 'beta-anywear' || record.stack.userPoolId !== record.user_pool_id
    || new URL(record.service_url).protocol !== 'https:') throw new Error('Runtime recovery record lacks exact Beta/run/deployment binding');
  const user = record.users[0];
  if (!UUID.test(user.sub ?? '') || !UUID.test(user.username ?? '')
    || !new RegExp(`^e2e-beta-${record.run_scope}-0-[a-f0-9]{8}@anywear\\.local$`).test(user.email ?? '')
    || record.items?.length > 50 || record.resources?.length > 50 || record.one_shots?.length > 100
    || !Array.isArray(record.items) || record.items.some((id) => !UUID.test(id))) throw new Error('Runtime recovery requires exact synthetic identity/items');
  for (const object of record.resources ?? []) {
    const parts = object.key?.split('/');
    if (object.bucket !== record.stack.bucket || parts?.length !== 4 || parts[0] !== 'wearable-items'
      || parts[1] !== user.sub || !record.items.includes(parts[2])
      || !/^[a-f0-9-]{36}\.png$/.test(parts[3])) throw new Error('Runtime recovery S3 object is outside the captured synthetic item');
  }
  if (record.known_dlq_message && (!UUID.test(record.known_dlq_message.taskId) || !UUID.test(record.known_dlq_message.messageId))) {
    throw new Error('Runtime recovery known DLQ binding is invalid');
  }
  const rejectSecrets = (value) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (/password|access.?token|authorization|signed.?url/i.test(key)) throw new Error('Recovery record contains credentials');
      rejectSecrets(child);
    }
  };
  rejectSecrets(record);
  return record;
}

export async function recoverRuntimeRecord(record, io, environment, waitStable) {
  if (environment.RUNTIME_DRILL_SERVICE_SHA !== record.deployment.service.source_commit
    || environment.RUNTIME_DRILL_RUN_SCOPE !== record.run_scope) throw new Error('Recovery requires the exact original Service/run pins');
  const identity = await io.aws(['sts', 'get-caller-identity']);
  if (identity.Account !== record.aws_account_id) throw new Error('Recovery AWS identity is outside the Beta account');
  const platform = await io.aws(['cloudformation', 'describe-stacks', '--stack-name', 'AnyWearPlatformStack-beta']);
  const outputs = Object.fromEntries((platform.Stacks?.[0]?.Outputs ?? []).map(({ OutputKey, OutputValue }) => [OutputKey, OutputValue]));
  if (outputs.EcsClusterName !== record.stack.cluster || outputs.WardrobeBucketName !== record.stack.bucket
    || outputs.UserPoolId !== record.user_pool_id) throw new Error('Recovery platform binding changed');
  const user = record.users[0];
  const scope = { runScope: record.run_scope, marker: record.marker, email: user.email, subject: user.sub,
    cognitoUsername: user.username, userPoolId: record.user_pool_id, stack: record.stack,
    deployment: record.deployment, config: { serviceUrl: record.service_url }, items: record.items, resources: record.resources,
    runtimeControl: record.runtime_control, runtimeWindow: record.runtime_window, oneShots: record.one_shots,
    knownDLQMessageId: record.known_dlq_message, ownedCleanupCompleted: record.owned_cleanup_completed,
    databaseCleanupCompleted: record.database_cleanup_completed, cleanupEvidence: record.cleanup_evidence };
  if (io.saveRecovery) await io.saveRecovery(scope);
  await recoverOneShotRegistrations(io, scope);
  await reconcilePendingPolicy(io, scope);
  await pauseRuntimeWindow(io, scope);
  if (!scope.ownedCleanupCompleted) {
    const captured = await io.cognitoSend(new AdminGetUserCommand({ UserPoolId: scope.userPoolId, Username: user.username }));
    const attributes = Object.fromEntries((captured.UserAttributes ?? []).map(({ Name, Value }) => [Name, Value]));
    if (captured.Username !== user.username || attributes.sub !== user.sub || attributes.email !== user.email) {
      throw new Error('Recovery Cognito identity drift; all deletions refused');
    }
    const payload = JSON.stringify({ runScope: scope.runScope, users: [{ sub: user.sub, email: user.email }],
      ...(scope.knownDLQMessageId ? { knownDLQMessageId: scope.knownDLQMessageId } : {}) });
    if (!scope.databaseCleanupCompleted) {
      await io.runOneShotCleanup({ scope, payload });
      scope.databaseCleanupCompleted = true;
      if (io.saveRecovery) await io.saveRecovery(scope);
    }
    for (const object of scope.resources) {
      await io.aws(['s3api', 'delete-object', '--bucket', object.bucket, '--key', object.key]);
      let absent = false;
      try { await io.aws(['s3api', 'head-object', '--bucket', object.bucket, '--key', object.key]); }
      catch (error) { if (/Not Found|404/.test(error.message)) absent = true; else throw error; }
      if (!absent) throw new Error('Recovery captured S3 object remains after exact deletion');
    }
    await io.cognitoSend(new AdminDeleteUserCommand({ UserPoolId: scope.userPoolId, Username: user.username }));
    scope.ownedCleanupCompleted = true;
    if (io.saveRecovery) await io.saveRecovery(scope);
  }
  await restoreNonPaidRuntime({ scope }, io, waitStable);
  await restoreRuntimeWindow(io, scope);
  await cleanupOneShotDefinitions(io, scope);
  return { recovered: true, run_scope: scope.runScope };
}
