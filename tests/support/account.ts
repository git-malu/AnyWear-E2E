import {
  AdminDeleteUserCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

export interface TestAccount {
  email: string;
  password: string;
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
    email: `test+${prefix}-${Date.now()}-${randomUUID()}@anywear.local`,
    password: process.env.E2E_TEST_PASSWORD ?? DEFAULT_TEST_PASSWORD,
  };
}

export async function registerAndLogin(page: Page, account: TestAccount): Promise<void> {
  await page.goto('/register');
  await page.locator('input[type="email"]').fill(account.email);
  await page.locator('input[type="password"]').fill(account.password);
  await page.getByRole('button', { name: 'Sign up' }).click();
  await page.waitForURL('/login');

  await page.locator('input[type="email"]').fill(account.email);
  await page.locator('input[type="password"]').fill(account.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('/dashboard');
}

export async function deleteTestAccount(email: string): Promise<void> {
  const userPoolId = requireEnvironment('USER_POOL_ID');
  const client = new CognitoIdentityProviderClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
  });

  try {
    await client.send(new AdminDeleteUserCommand({
      UserPoolId: userPoolId,
      Username: email,
    }));
  } catch (error: unknown) {
    if (!(error instanceof Error) || error.name !== 'UserNotFoundException') {
      throw error;
    }
  } finally {
    client.destroy();
  }
}
