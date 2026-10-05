import { AdminDeleteUserCommand, AdminGetUserCommand } from '@aws-sdk/client-cognito-identity-provider';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const KEYS = ['run_scope', 'user_pool_id', 'email', 'requested_at', 'stage'];
const CLOCK_TOLERANCE_MS = 120_000;
const CREATION_OPERATION_BUDGET_MS = 5 * 60_000;

export function validateCreationIntent(intent, runScope, userPoolId) {
  if (!intent || Object.keys(intent).some((key) => !KEYS.includes(key)) || Object.keys(intent).length !== KEYS.length
    || intent.run_scope !== runScope || intent.user_pool_id !== userPoolId
    || !new RegExp(`^e2e-beta-${runScope}-0-[a-f0-9]{8}@anywear\\.local$`).test(intent.email ?? '')
    || typeof intent.requested_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(intent.requested_at)
    || !Number.isFinite(Date.parse(intent.requested_at))
    || new Date(intent.requested_at).toISOString() !== intent.requested_at
    || !['requested', 'captured', 'ready', 'compensated'].includes(intent.stage)) {
    throw new Error('Synthetic creation intent lacks exact run/pool/email/stage binding');
  }
  return intent;
}

export async function lookupCreationIdentity(io, scope) {
  const intent = validateCreationIntent(scope.creationIntent, scope.runScope, scope.userPoolId);
  let user;
  const username = scope.cognitoUsername ?? intent.email;
  try { user = await io.cognitoSend(new AdminGetUserCommand({ UserPoolId: scope.userPoolId, Username: username })); }
  catch (error) { if (error?.name === 'UserNotFoundException') return; throw error; }
  const attributes = Object.fromEntries((user.UserAttributes ?? []).map(({ Name, Value }) => [Name, Value]));
  const createdAt = new Date(user.UserCreateDate ?? NaN).getTime();
  const requestedAt = Date.parse(intent.requested_at);
  const upperBound = requestedAt + CREATION_OPERATION_BUDGET_MS + CLOCK_TOLERANCE_MS;
  if (!UUID.test(user.Username ?? '') || !UUID.test(attributes.sub ?? '') || attributes.email !== intent.email
    || attributes['custom:e2e_bootstrap'] !== 'true' || !Number.isFinite(createdAt)
    || createdAt < requestedAt - CLOCK_TOLERANCE_MS || createdAt > upperBound
    || (scope.subject && (scope.subject !== attributes.sub || scope.cognitoUsername !== user.Username))) {
    throw new Error('Synthetic creation lookup ownership/date/bootstrap check failed; deletion refused');
  }
  return { subject: attributes.sub, cognitoUsername: user.Username };
}

export function remainingCreationBudget(intent, now = Date.now()) {
  const requestedAt = Date.parse(validateCreationIntent(intent, intent.run_scope, intent.user_pool_id).requested_at);
  const remaining = requestedAt + CREATION_OPERATION_BUDGET_MS - now;
  if (remaining <= 0) throw new Error('Synthetic creation intent exceeded its bounded operation window');
  return remaining;
}

export async function captureCreatedIdentity(io, scope, createdUser) {
  const attributes = Object.fromEntries((createdUser?.User?.Attributes ?? []).map(({ Name, Value }) => [Name, Value]));
  if (!UUID.test(createdUser?.User?.Username ?? '') || !UUID.test(attributes.sub ?? '')
    || attributes.email !== scope.email || attributes['custom:e2e_bootstrap'] !== 'true') {
    throw new Error('Cognito creation did not return an immutable owned identity');
  }
  scope.subject = attributes.sub;
  scope.cognitoUsername = createdUser.User.Username;
  scope.creationIntent.stage = 'captured';
  await io.saveRecovery(scope);
  const identity = await lookupCreationIdentity(io, scope);
  if (!identity || identity.subject !== scope.subject || identity.cognitoUsername !== scope.cognitoUsername) {
    throw new Error('Cognito creation response and authoritative lookup identity differ');
  }
  return identity;
}

export async function compensateCreationIdentity(io, scope) {
  const identity = await lookupCreationIdentity(io, scope);
  if (identity) {
    Object.assign(scope, identity);
    scope.creationIntent.stage = 'captured';
    await io.saveRecovery(scope);
    try { await io.cognitoSend(new AdminDeleteUserCommand({ UserPoolId: scope.userPoolId, Username: identity.cognitoUsername })); }
    catch (error) { if (error?.name !== 'UserNotFoundException') throw error; }
    if (await lookupCreationIdentity(io, scope)) throw new Error('Compensated synthetic Cognito identity is still present');
  }
  scope.creationIntent.stage = 'compensated';
  scope.ownedCleanupCompleted = true;
  await io.saveRecovery(scope);
}
