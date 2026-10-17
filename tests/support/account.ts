import {
  AdminConfirmSignUpCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminGetUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import type { Page, WorkerInfo } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { assertE2EExecution } from '../../scripts/execution-guard.mjs';
import { workerSlotOffset } from '../../scripts/worker-slots.mjs';
import {
  markAccountCleanupPending,
  markAccountDeleted,
  markAccountInUse,
  quarantineAccount,
  recordAccountSubject,
  reserveAccount,
  accountRunScope,
  type AccountMode,
} from './account-budget.ts';
import { betaWorkerAddress } from './beta-address.ts';

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

export function createTestAccount(prefix: string): TestAccount {
  return {
    email: `e2e-${accountScopeSegment(process.env.E2E_STAGE ?? 'test', 'test', 8)}-${accountScopeSegment(
      process.env.GITHUB_RUN_ID ?? `local-${process.pid}`,
      `local-${process.pid}`,
      16,
    )}-${accountScopeSegment(prefix, 'test', 8)}-${randomUUID().replaceAll('-', '').slice(0, 12)}@anywear.local`,
    password: process.env.E2E_TEST_PASSWORD ?? DEFAULT_TEST_PASSWORD,
    leaseGeneration: randomUUID(),
  };
}

function accountScopeSegment(value: string, fallback: string, maxLength: number): string {
  const segment = value.replace(/[^a-zA-Z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return (segment || fallback).slice(0, maxLength);
}

export function configuredE2eWorkers(): number {
  const raw = process.env.E2E_WORKERS ?? '1';
  const workers = Number(raw);
  if (!Number.isInteger(workers) || workers < 1 || workers > 8) {
    throw new Error('E2E_WORKERS must be an integer between 1 and 8');
  }
  return workers;
}

export function createWorkerAccount(workerInfo: WorkerInfo, browserName: string): TestAccount {
  const workers = configuredE2eWorkers();
  if (!Number.isInteger(workerInfo.parallelIndex) || workerInfo.parallelIndex < 0 || workerInfo.parallelIndex >= workers) {
    throw new Error(`parallelIndex ${workerInfo.parallelIndex} exceeds E2E_WORKERS=${workers}`);
  }

  const stage = accountScopeSegment(process.env.E2E_STAGE ?? 'test', 'test', 8);
  const slot = String(workerInfo.parallelIndex + workerSlotOffset(process.env, workers));
  const browser = accountScopeSegment(browserName, 'browser', 12);
  const attemptSuffix = randomUUID().replaceAll('-', '').slice(0, 8);
  // A Beta worker address is a captured-subject Service cleanup input, so its
  // scope has to survive verbatim: `betaWorkerAddress` keeps the full run scope
  // and refuses one the Service cleanup capability could never address. Any
  // other stage only needs a run-unique address, and keeps its sanitized,
  // length-bounded scope segment.
  const email = stage === 'beta'
    ? betaWorkerAddress(accountRunScope(), slot, attemptSuffix)
    : `e2e-${stage}-${accountScopeSegment(accountRunScope(), `local-${process.pid}`, 33)}-${slot}-${browser}-${attemptSuffix}@anywear.local`;

  return {
    email,
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
    // Every attempt address is scope-bound and never re-bound, so a pre-existing
    // Cognito binding for it is always a defect rather than a reusable identity:
    // adopting that subject is what produced issue #129's 409 on the first
    // profile sync. `UsernameExistsException` is therefore fatal — the outer
    // catch quarantines this scope with whatever is bound there, and no later
    // attempt is handed the same address.
    await client.send(new AdminCreateUserCommand({
      UserPoolId: userPoolId,
      Username: account.email,
      MessageAction: 'SUPPRESS',
      UserAttributes: [
        { Name: 'email', Value: account.email },
        { Name: 'email_verified', Value: 'true' },
        { Name: 'custom:e2e_bootstrap', Value: 'true' },
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
    await quarantineAccount(account.email, `provisioning failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    throw error;
  } finally {
    client.destroy();
  }
}

export async function registerAndLogin(page: Page, account: TestAccount): Promise<void> {
  assertE2EExecution();
  await page.goto('/register');
  await page.locator('input[type="email"]').fill(account.email);
  await page.locator('input[type="password"]').fill(account.password);
  assertE2EExecution();
  await page.getByRole('button', { name: 'Sign up' }).click();
  await page.waitForURL('/login');
  const userPoolId = requireEnvironment('USER_POOL_ID');
  const client = cognitoClient();
  try {
    await getAccountSubject(client, userPoolId, account);
    await markAccountInUse(account.email);
  } finally {
    client.destroy();
  }
  await login(page, account);
}

export async function login(page: Page, account: TestAccount): Promise<void> {
  await page.goto('/login');
  await page.getByRole('heading', { name: 'Sign in' }).waitFor();

  await page.locator('input[type="email"]').fill(account.email);
  await page.locator('input[type="password"]').fill(account.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('/dashboard');
}

export async function deleteTestAccount(account: TestAccount): Promise<void> {
  const userPoolId = requireEnvironment('USER_POOL_ID');
  const client = cognitoClient();

  try {
    await markAccountCleanupPending(account.email);
    await getAccountSubject(client, userPoolId, account);
    assertE2EExecution();
    await client.send(new AdminDeleteUserCommand({
      UserPoolId: userPoolId,
      Username: account.email,
    }));
    await markAccountDeleted(account.email);
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'UserNotFoundException') {
      await markAccountDeleted(account.email);
      return;
    }
    await quarantineAccount(account.email, `cleanup failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    throw error;
  } finally {
    client.destroy();
  }
}
