import {
  AdminConfirmSignUpCommand,
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import type { Page, WorkerInfo } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { assertE2EExecution } from '../../scripts/execution-guard.mjs';
import { workerSlotOffset } from '../../scripts/worker-slots.mjs';
import {
  markAccountInUse,
  retainAccount,
  recordAccountSubject,
  reserveAccount,
  type AccountMode,
} from './account-budget.ts';
import { workerPoolAddress } from './beta-address.ts';

export interface TestAccount {
  email: string;
  password: string;
  leaseGeneration: string;
  subject?: string;
}

const DEFAULT_TEST_PASSWORD = 'TestPassword123!';

export function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required E2E environment variable: ${name}`);
  }
  return value;
}

export function configuredE2eWorkers(): number {
  const raw = process.env.E2E_WORKERS ?? '1';
  const workers = Number(raw);
  if (!Number.isInteger(workers) || workers < 1 || workers > 8) {
    throw new Error('E2E_WORKERS must be an integer between 1 and 8');
  }
  return workers;
}

/**
 * One attempt's lease of one pool slot (issue #213).
 *
 * Beta registration admits exactly the addresses on the tester allowlist, so the
 * attempt may only use a stable pool address. The slot is the Playwright parallel
 * index plus the operator's `E2E_WORKER_SLOT_OFFSET`; `workerSlotOffset` holds
 * the first slot inside the pool, so an offset can never silently hand out an
 * address the allowlist does not list. The address is stable across runs and
 * retries — the lease generation, not a fresh address, distinguishes attempts.
 */
export function createWorkerAccount(workerInfo: WorkerInfo, browserName: string): TestAccount {
  // Every pool row is a chromium row (`e2e-beta-worker-<slot>-chromium`). A project that
  // asks for another browser has no listed address, so it refuses instead of reusing a
  // chromium identity.
  if (browserName !== 'chromium') {
    throw new Error(`Beta worker pool addresses are chromium-only: ${browserName}`);
  }
  const workers = configuredE2eWorkers();
  if (!Number.isInteger(workerInfo.parallelIndex) || workerInfo.parallelIndex < 0 || workerInfo.parallelIndex >= workers) {
    throw new Error(`parallelIndex ${workerInfo.parallelIndex} exceeds E2E_WORKERS=${workers}`);
  }
  const slot = workerInfo.parallelIndex + workerSlotOffset(process.env, workers);

  return {
    email: workerPoolAddress(slot),
    password: process.env.E2E_TEST_PASSWORD ?? DEFAULT_TEST_PASSWORD,
    leaseGeneration: randomUUID(),
  };
}

export async function reserveTestAccount(account: TestAccount, mode: AccountMode): Promise<void> {
  await reserveAccount(account.email, mode, account.leaseGeneration);
}

function userAttribute(attributes: { Name?: string; Value?: string }[] | undefined, name: string): string | undefined {
  return attributes?.find((attribute) => attribute.Name === name)?.Value;
}

function cognitoClient(): CognitoIdentityProviderClient {
  return new CognitoIdentityProviderClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
  });
}

async function getAccountSubject(
  client: CognitoIdentityProviderClient,
  userPoolId: string,
  account: TestAccount,
): Promise<string> {
  const user = await client.send(new AdminGetUserCommand({
    UserPoolId: userPoolId,
    Username: account.email,
  }));
  const email = userAttribute(user.UserAttributes, 'email');
  const subject = userAttribute(user.UserAttributes, 'sub');
  if (email !== account.email || !subject) {
    throw new Error(`Cognito identity does not match the leased E2E account: ${account.email}`);
  }
  if (account.subject && account.subject !== subject) {
    throw new Error(`Cognito subject changed for the leased E2E account: ${account.email}`);
  }
  account.subject = subject;
  await recordAccountSubject(account.email, subject);
  return subject;
}

export async function provisionConfirmedTestAccount(account: TestAccount): Promise<void> {
  const userPoolId = requireEnvironment('USER_POOL_ID');
  const client = cognitoClient();
  try {
    assertE2EExecution();
    // The attempt leases a stable pool address, so a pre-existing Cognito binding
    // for it is always a defect rather than an identity to adopt:
    // `UsernameExistsException` is therefore fatal. The outer catch retains this
    // scope with whatever is bound there, and no later attempt is handed the same
    // address until the reconcile operation resolves it. A stale Service profile
    // row is not this failure: issue #137's release/adopt contract releases and
    // re-adopts that binding inside profile sync, and the E2E side never deletes a
    // profile row.
    await client.send(new AdminCreateUserCommand({
      UserPoolId: userPoolId,
      Username: account.email,
      MessageAction: 'SUPPRESS',
      UserAttributes: [
        { Name: 'email', Value: account.email },
        { Name: 'email_verified', Value: 'true' },
      ],
    }));
    await getAccountSubject(client, userPoolId, account);
    assertE2EExecution();
    await client.send(new AdminSetUserPasswordCommand({
      UserPoolId: userPoolId,
      Username: account.email,
      Password: account.password,
      Permanent: true,
    }));
    const user = await client.send(new AdminGetUserCommand({
      UserPoolId: userPoolId,
      Username: account.email,
    }));
    if (user.UserStatus !== 'CONFIRMED') {
      assertE2EExecution();
      await client.send(new AdminConfirmSignUpCommand({ UserPoolId: userPoolId, Username: account.email }));
    }
    await markAccountInUse(account.email);
  } catch (error) {
    await retainAccount(account.email, `provisioning failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    throw error;
  } finally {
    client.destroy();
  }
}

export async function login(page: Page, account: TestAccount): Promise<void> {
  await page.goto('/login');
  await page.getByRole('heading', { name: 'Sign in' }).waitFor();

  await page.locator('input[type="email"]').fill(account.email);
  await page.locator('input[type="password"]').fill(account.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('/dashboard');
}
