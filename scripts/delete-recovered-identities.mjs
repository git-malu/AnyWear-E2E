import { readFile, writeFile } from 'node:fs/promises';
import {
  AdminDeleteUserCommand,
  AdminGetUserCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { assertE2EWriterWindow } from './writer-window.mjs';

assertE2EWriterWindow();

const manifestPath = process.env.E2E_ACCOUNT_BUDGET_PATH;
const userPoolId = process.env.USER_POOL_ID;
if (!manifestPath || !userPoolId) throw new Error('E2E_ACCOUNT_BUDGET_PATH and USER_POOL_ID are required');

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (manifest.version !== 1 || !Array.isArray(manifest.accounts)) throw new Error('Invalid account budget manifest');

const client = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION ?? 'ap-east-1' });
try {
  for (const account of manifest.accounts) {
    if (account.status === 'deleted' || typeof account.subject !== 'string') continue;
    const user = await client.send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: account.email }));
    const email = user.UserAttributes?.find((attribute) => attribute.Name === 'email')?.Value;
    const subject = user.UserAttributes?.find((attribute) => attribute.Name === 'sub')?.Value;
    if (email !== account.email || subject !== account.subject) {
      throw new Error(`Recovery ownership check failed for ${account.email}`);
    }
    if (!user.Username || user.Username.includes('@')) throw new Error('Recovery deletion requires the returned immutable Cognito username');
    assertE2EWriterWindow();
    await client.send(new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: user.Username }));
    account.status = 'deleted';
    account.updatedAt = new Date().toISOString();
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
} finally {
  client.destroy();
}
