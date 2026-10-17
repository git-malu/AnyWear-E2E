import { AdminDeleteUserCommand, AdminGetUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { cleanupOneShotDefinitions, recoverOneShotRegistrations, verifyOneShotTask } from './runtime-one-shot.mjs';
import { cleanupPayload, collectCleanupEvidence, readOneShotLog, validateCleanupEvidence, validateKnownDLQDeletionEvidence } from './runtime-one-shot-logs.mjs';
import { pauseRuntimeWindow, reconcilePendingPolicy, restoreRuntimeWindow } from './runtime-window-controls.mjs';
import { restoreNonPaidRuntime } from './nonpaid-runtime-controls.mjs';
import { compensateCreationIdentity, validateCreationIntent } from './runtime-identity-creation.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const RECORD_KEYS = ['schema_version', 'record_type', 'stage', 'aws_account_id', 'aws_region', 'run_scope', 'marker',
  'user_pool_id', 'users', 'items', 'resources', 'runtime_control', 'known_dlq_message', 'owned_cleanup_completed',
  'runtime_window', 'one_shots', 'stack', 'service_url', 'deployment', 'database_cleanup_completed', 'cleanup_evidence', 'cognito_deletion_intent', 'known_dlq_deletion_evidence', 'creation_intent'];

export function parseRuntimeRecovery(json) {
  if (Buffer.byteLength(json) > 262_144) throw new Error('Runtime recovery record exceeds its bounded size');
  const record = JSON.parse(json);
  if (!record || Object.keys(record).some((key) => !RECORD_KEYS.includes(key)) || record.schema_version !== 2
    || record.record_type !== 'anywear_beta_runtime_recovery' || record.stage !== 'beta'
    || record.aws_account_id !== '650880818323' || record.aws_region !== 'ap-east-1'
    || !/^[1-9][0-9]{0,19}-[1-9][0-9]{0,5}-[a-f0-9]{16}$/.test(record.run_scope ?? '')
    || !/^beta-runtime-[a-z0-9-]+$/.test(record.marker ?? '') || !Array.isArray(record.users)
    || !/^ap-east-1_[a-zA-Z0-9]+$/.test(record.user_pool_id ?? '')
    || !/^[a-f0-9]{40}$/.test(record.deployment?.service?.source_commit ?? '')
    || !/^sha256:[a-f0-9]{64}$/.test(record.deployment.service.image_digest ?? '')
    || record.stack?.cluster !== 'beta-anywear' || record.stack.userPoolId !== record.user_pool_id
    || new URL(record.service_url).protocol !== 'https:') throw new Error('Runtime recovery record lacks exact Beta/run/deployment binding');
  const intent = record.creation_intent && validateCreationIntent(record.creation_intent, record.run_scope, record.user_pool_id);
  const identityOnly = intent && intent.stage !== 'ready';
  if (record.users.length !== 1 && !(identityOnly && record.users.length === 0
    && ['requested', 'compensated'].includes(intent.stage))) throw new Error('Runtime recovery requires exact synthetic identity/items');
  const user = record.users[0];
  if ((user && (!UUID.test(user.sub ?? '') || !UUID.test(user.username ?? '')
    || !new RegExp(`^e2e-beta-${record.run_scope}-0-[a-f0-9]{8}@anywear\\.local$`).test(user.email ?? '')
    || (intent && user.email !== intent.email)))
    || (intent?.stage === 'requested' && user)
    || record.items?.length > 50 || record.resources?.length > 50 || record.one_shots?.length > 100
    || !Array.isArray(record.items) || record.items.some((id) => !UUID.test(id))) throw new Error('Runtime recovery requires exact synthetic identity/items');
  if (!Array.isArray(record.resources) || !Array.isArray(record.one_shots)
    || (identityOnly && (record.items.length || record.resources.length || record.one_shots.length
      || record.runtime_control || record.runtime_window || record.known_dlq_message || record.cleanup_evidence
      || record.known_dlq_deletion_evidence || record.database_cleanup_completed || record.cognito_deletion_intent))
    || (record.runtime_control && record.runtime_control.run_scope !== record.run_scope)
    || (record.runtime_window && (record.runtime_window.run_scope !== record.run_scope
      || record.runtime_window.synthetic_owner?.sub !== user?.sub || record.runtime_window.synthetic_owner.email !== user?.email))
    || (record.cognito_deletion_intent && (record.cognito_deletion_intent.sub !== user?.sub
      || record.cognito_deletion_intent.username !== user.username || record.cognito_deletion_intent.email !== user.email))) {
    throw new Error('Runtime recovery control/deletion intent belongs to a foreign run/user');
  }
  for (const object of record.resources ?? []) {
    // The key is minted when the upload is reserved, before any item exists, so
    // it is bound to the synthetic owner's namespace and to an immutable object
    // name rather than to an item id. Cleanup deletes exactly this recorded key.
    const parts = object.key?.split('/');
    if (object.bucket !== record.stack.bucket || parts?.length !== 3 || parts[0] !== 'wearable-items'
      || parts[1] !== user.sub
      || !/^[a-f0-9-]{36}\.(png|jpg|jpeg|webp|heic|heif)$/.test(parts[2] ?? '')) throw new Error('Runtime recovery S3 object is outside the captured synthetic owner');
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
    || outputs.UserPoolId !== record.user_pool_id
    || outputs.OneShotExecutionRoleArn !== record.stack.oneShotExecutionRoleArn
    || outputs.VerificationTaskRoleArn !== record.stack.verificationTaskRoleArn
    || outputs.LifecycleTaskRoleArn !== record.stack.lifecycleTaskRoleArn) throw new Error('Recovery platform binding changed');
  const user = record.users[0];
  const scope = { runScope: record.run_scope, marker: record.marker, email: user?.email ?? record.creation_intent?.email, subject: user?.sub,
    cognitoUsername: user?.username, userPoolId: record.user_pool_id, stack: record.stack,
    deployment: record.deployment, config: { serviceUrl: record.service_url }, items: record.items, resources: record.resources,
    runtimeControl: record.runtime_control, runtimeWindow: record.runtime_window, oneShots: record.one_shots,
    knownDLQMessageId: record.known_dlq_message, ownedCleanupCompleted: record.owned_cleanup_completed,
    databaseCleanupCompleted: record.database_cleanup_completed, cleanupEvidence: record.cleanup_evidence,
    cognitoDeletionIntent: record.cognito_deletion_intent, creationIntent: record.creation_intent,
    recoverySourceCompleted: environment.RUNTIME_RECOVERY_SOURCE_COMPLETED === 'true' };
  if (scope.creationIntent && scope.creationIntent.stage !== 'ready') {
    if (typeof io.saveRecovery !== 'function') throw new Error('Identity-only recovery requires durable recovery persistence');
    await compensateCreationIdentity(io, scope);
    return { recovered: true, run_scope: scope.runScope, identity_only: true };
  }
  if (io.saveRecovery) await io.saveRecovery(scope);
  if (record.known_dlq_deletion_evidence) {
    const captured = record.known_dlq_deletion_evidence;
    const operation = scope.oneShots.find((entry) => entry.task_arn === captured.extraction?.task_arn && entry.purpose === 'tester-cleanup');
    if (!operation) throw new Error('Saved DLQ deletion has no captured exact helper operation');
    await verifyOneShotTask(io, scope, operation,
      { requireSuccess: false, allowRetainedProofForMissingTask: true });
    const { event } = await readOneShotLog(io, operation.proof, 'beta-tester-dlq-cleanup');
    scope.knownDLQDeletionEvidence = validateKnownDLQDeletionEvidence({ extraction: operation.proof, deletion: event }, scope);
  }
  const notStarted = await recoverOneShotRegistrations(io, scope);
  await reconcilePendingPolicy(io, scope, notStarted,
    { allowRetainedProofForMissingTask: true });
  await pauseRuntimeWindow(io, scope);
  // Saved completion flags are hints only. Reconstruct proof from exact helper logs after runner loss.
  scope.ownedCleanupCompleted = false;
  scope.databaseCleanupCompleted = false;
  let captured;
  let initiallyAbsent = false;
  try { captured = await io.cognitoSend(new AdminGetUserCommand({ UserPoolId: scope.userPoolId, Username: user.username })); }
  catch (error) { if (error?.name !== 'UserNotFoundException') throw error; initiallyAbsent = true; }
  if (!initiallyAbsent) {
    const attributes = Object.fromEntries((captured?.UserAttributes ?? []).map(({ Name, Value }) => [Name, Value]));
    if (captured?.Username !== user.username || attributes.sub !== user.sub || attributes.email !== user.email) {
      throw new Error('Recovery Cognito identity drift; all deletions refused');
    }
  }
  let payload = cleanupPayload(scope);
  for (const operation of scope.oneShots ?? []) {
    if (operation.purpose !== 'tester-cleanup' || !operation.task_arn
      || ![payload, cleanupPayload(scope, { original: true })].includes(operation.request_payload)) continue;
    await verifyOneShotTask(io, scope, operation,
      { requireSuccess: false, allowRetainedProofForMissingTask: true });
    const original = operation.request_payload === cleanupPayload(scope, { original: true });
    try {
      scope.cleanupEvidence = await collectCleanupEvidence(io, original ? { ...scope, knownDLQDeletionEvidence: undefined } : scope,
        operation, { requireSuccess: false });
      scope.databaseCleanupCompleted = true;
      break;
    } catch (error) {
      if (error.message !== 'Exact one-shot log did not expose the authoritative committed record' || !original || !scope.knownDLQMessageId) throw error;
      const { event } = await readOneShotLog(io, operation.proof, 'beta-tester-dlq-cleanup');
      scope.knownDLQDeletionEvidence = validateKnownDLQDeletionEvidence({ extraction: operation.proof, deletion: event }, scope);
      payload = cleanupPayload(scope);
      if (io.saveRecovery) await io.saveRecovery(scope);
    }
  }
  if (!scope.databaseCleanupCompleted) {
    scope.cleanupEvidence = await io.runOneShotCleanup({ scope, payload });
    validateCleanupEvidence(scope.cleanupEvidence, scope);
    scope.databaseCleanupCompleted = true;
  }
  if (io.saveRecovery) await io.saveRecovery(scope);
  for (const object of scope.resources) {
    await io.aws(['s3api', 'delete-object', '--bucket', object.bucket, '--key', object.key]);
    let absent = false;
    try { await io.aws(['s3api', 'head-object', '--bucket', object.bucket, '--key', object.key]); }
    catch (error) { if (/Not Found|404/.test(error.message)) absent = true; else throw error; }
    if (!absent) throw new Error('Recovery captured S3 object remains after exact deletion');
  }
  scope.cognitoDeletionIntent = { sub: user.sub, email: user.email, username: user.username };
  if (io.saveRecovery) await io.saveRecovery(scope);
  if (!initiallyAbsent) {
    try { await io.cognitoSend(new AdminDeleteUserCommand({ UserPoolId: scope.userPoolId, Username: user.username })); }
    catch (error) { if (error?.name !== 'UserNotFoundException') throw error; }
  }
  let identityAbsent = false;
  try { await io.cognitoSend(new AdminGetUserCommand({ UserPoolId: scope.userPoolId, Username: user.username })); }
  catch (error) { if (error?.name !== 'UserNotFoundException') throw error; identityAbsent = true; }
  if (!identityAbsent) throw new Error('Recovery Cognito identity absence is not authoritative; restoration refused');
  scope.ownedCleanupCompleted = true;
  if (io.saveRecovery) await io.saveRecovery(scope);
  await restoreNonPaidRuntime({ scope }, io, waitStable);
  await restoreRuntimeWindow(io, scope);
  await cleanupOneShotDefinitions(io, scope, { allowRetainedProofForMissingTask: true });
  return { recovered: true, run_scope: scope.runScope };
}
