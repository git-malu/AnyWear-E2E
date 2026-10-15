import {
  AdminDeleteUserCommand,
  AdminGetUserCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { test as base, type TestInfo } from '@playwright/test';
import {
  createWorkerAccount,
  provisionConfirmedTestAccount,
  requireEnvironment,
  reserveTestAccount,
  type TestAccount,
} from './account.js';
import { quarantineAccount, releaseWorkerAccount } from './account-budget.js';
import { assertE2EExecution } from '../../scripts/execution-guard.mjs';
import { readAttemptBusinessCleanup } from './attempt-cleanup-registry.ts';
import {
  releaseWorkerLease,
  workerLeaseGateError,
  type WorkerLeaseIo,
} from './worker-cleanup.js';

type TestFixtures = {
  workerAccount: TestAccount;
};

/**
 * Captured-identity transport and ledger transitions for the attempt teardown.
 * The deletion itself stays inside `cognito-cleanup.ts`, which requires the
 * captured synthetic email, the captured immutable subject and the returned
 * immutable username before it deletes anything.
 */
function workerLeaseIo(testInfo: TestInfo): { io: WorkerLeaseIo; destroy: () => void } {
  const userPoolId = requireEnvironment('USER_POOL_ID');
  const client = new CognitoIdentityProviderClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
  });
  return {
    io: {
      async getUser(username) {
        const user = await client.send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: username }));
        return { Username: user.Username, UserAttributes: user.UserAttributes };
      },
      async deleteUser(username) {
        assertE2EExecution();
        await client.send(new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: username }));
      },
      releaseWorkerAccount,
      quarantineWorkerAccount: quarantineAccount,
      // The attempt's own declaration, read with the attempt's own key. A
      // missing record is `undeclared`, so the lease fails closed.
      readAttemptBusinessCleanup: () => readAttemptBusinessCleanup(testInfo),
    },
    destroy: () => client.destroy(),
  };
}

/**
 * Attempt teardown for one worker lease. Never throws: the caller decides
 * whether its outcome is the attempt's primary failure or a separate gate.
 */
async function teardownWorkerAttempt(
  account: TestAccount,
  state: { reserved: boolean; provisioned: boolean },
  testInfo: TestInfo,
): Promise<Error | undefined> {
  try {
    const transport = workerLeaseIo(testInfo);
    try {
      const declaration = readAttemptBusinessCleanup(testInfo);
      const disposition = await releaseWorkerLease(
        {
          email: account.email,
          subject: account.subject,
          reserved: state.reserved,
          provisioned: state.provisioned,
          businessCleanup: declaration,
        },
        transport.io,
      );
      return workerLeaseGateError(disposition);
    } finally {
      transport.destroy();
    }
  } catch (error) {
    return new Error(`Worker lease teardown gate failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}

export const test = base.extend<TestFixtures, Record<never, never>>({
  // One bounded lease per test attempt (the ADR-0023 scope
  // `environment/run/worker/project/test/retry`): reserve and provision before
  // the attempt, then release — or quarantine — the attempt's own scope in the
  // teardown. Playwright tears a test-scoped fixture down after the attempt's
  // `afterEach` hooks, so the attempt's own business cleanup has already had its
  // say before the worker identity is touched.
  workerAccount: [async ({ browserName }, use, testInfo) => {
    const account = createWorkerAccount(testInfo, browserName);
    let reserved = false;
    let provisioned = false;
    let attemptThrew = false;
    let gateError: Error | undefined;

    try {
      await reserveTestAccount(account, 'worker');
      reserved = true;
      await provisionConfirmedTestAccount(account);
      provisioned = true;
      await use(account);
    } catch (error) {
      // Setup failures (and a rejected `use`) stay the attempt's primary report;
      // the teardown gate below only adds to an attempt that settled.
      attemptThrew = true;
      throw error;
    } finally {
      gateError = await teardownWorkerAttempt(account, { reserved, provisioned }, testInfo);
      if (gateError && attemptThrew) process.stderr.write(`${gateError.message}\n`);
    }
    // A failed teardown fails the attempt on its own gate without rewriting what
    // the attempt already recorded; Playwright reports it after the original
    // failure, never instead of it.
    if (gateError) throw gateError;
  }, { scope: 'test' }],
});

export { expect } from '@playwright/test';
export { login } from './account.js';
