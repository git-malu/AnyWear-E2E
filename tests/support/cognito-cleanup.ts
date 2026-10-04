export interface CapturedIdentity { email: string; sub: string }
interface CognitoUser { Username?: string; UserAttributes?: { Name?: string; Value?: string }[] }
export interface CognitoCleanupIo {
  getUser(username: string): Promise<CognitoUser>;
  deleteUser(username: string): Promise<void>;
}

export async function verifyCapturedCognitoIdentity(identity: CapturedIdentity, io: CognitoCleanupIo): Promise<string | undefined> {
  if (!(/^(?:e2e-beta-allowlist-[1-9][0-9]*-[1-9][0-9]*-[a-f0-9]{16}-[a-z][a-z0-9]{0,23}|e2e-beta-worker-[0-7]-chromium)@anywear\.local$/.test(identity.email))
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(identity.sub)) {
    throw new Error('Cognito cleanup requires a captured synthetic email and subject');
  }
  let user: CognitoUser;
  try { user = await io.getUser(identity.email); }
  catch (error) {
    if ((error as Error).name === 'UserNotFoundException' || /UserNotFoundException/.test((error as Error).message)) return undefined;
    throw error;
  }
  const attributes = Object.fromEntries((user.UserAttributes ?? []).map(({ Name, Value }) => [Name, Value]));
  if (attributes.sub !== identity.sub || attributes.email !== identity.email) {
    throw new Error('Captured synthetic email now belongs to a different Cognito identity; cleanup refused');
  }
  if (!user.Username || user.Username.includes('@')) throw new Error('Cognito cleanup requires the returned immutable username');
  return user.Username;
}

export async function deleteCapturedCognitoIdentity(identity: CapturedIdentity, io: CognitoCleanupIo): Promise<void> {
  const username = await verifyCapturedCognitoIdentity(identity, io);
  if (!username) return;
  try { await io.deleteUser(username); }
  catch (error) {
    if ((error as Error).name !== 'UserNotFoundException' && !/UserNotFoundException/.test((error as Error).message)) throw error;
  }
}
