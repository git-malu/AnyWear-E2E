import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createWorkerAccount } from '../tests/support/account.ts';

const environment = [
  'E2E_STAGE',
  'E2E_WORKERS',
  'E2E_TEST_PASSWORD',
  'E2E_ACCOUNT_RUN_SCOPE',
  'GITHUB_RUN_ID',
  'GITHUB_RUN_ATTEMPT',
];
const originalEnvironment = new Map(environment.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const name of environment) {
    const originalValue = originalEnvironment.get(name);
    if (originalValue === undefined) delete process.env[name];
    else process.env[name] = originalValue;
  }
});

test('Beta worker emails are stable per parallel slot while each lease remains unique', () => {
  process.env.E2E_STAGE = 'beta';
  process.env.E2E_WORKERS = '2';
  process.env.GITHUB_RUN_ID = 'first-run';
  const firstLease = createWorkerAccount({ parallelIndex: 0 }, 'chromium');

  process.env.GITHUB_RUN_ID = 'second-run';
  const secondLease = createWorkerAccount({ parallelIndex: 0 }, 'chromium');
  const otherSlot = createWorkerAccount({ parallelIndex: 1 }, 'chromium');

  assert.equal(firstLease.email, 'e2e-beta-worker-0-chromium@anywear.local');
  assert.equal(secondLease.email, firstLease.email);
  assert.notEqual(secondLease.leaseGeneration, firstLease.leaseGeneration);
  assert.equal(otherSlot.email, 'e2e-beta-worker-1-chromium@anywear.local');
});

test('non-Beta worker emails remain run-scoped and slots are bounded', () => {
  process.env.E2E_STAGE = 'dev';
  process.env.E2E_WORKERS = '1';
  process.env.GITHUB_RUN_ID = 'first-run';
  const firstRun = createWorkerAccount({ parallelIndex: 0 }, 'chromium');

  process.env.GITHUB_RUN_ID = 'second-run';
  const secondRun = createWorkerAccount({ parallelIndex: 0 }, 'chromium');

  assert.notEqual(secondRun.email, firstRun.email);
  assert.throws(() => createWorkerAccount({ parallelIndex: 1 }, 'chromium'), /exceeds E2E_WORKERS/);
});
