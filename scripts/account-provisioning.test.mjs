import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isReusableStableWorkerEmail,
  reusableStableWorkerSubject,
} from '../tests/support/account.ts';

const email = 'e2e-beta-worker-2-chromium@anywear.local';
const subject = 'b4622cee-f081-70c8-ab39-18304afac996';

function user({
  address = email,
  sub = subject,
  emailVerified = 'true',
  bootstrap = 'true',
} = {}) {
  return {
    Username: sub,
    UserAttributes: [
      { Name: 'email', Value: address },
      { Name: 'sub', Value: sub },
      { Name: 'email_verified', Value: emailVerified },
      { Name: 'custom:e2e_bootstrap', Value: bootstrap },
    ],
  };
}

test('only the private stable Chromium worker addresses are reusable', () => {
  for (const slot of [0, 7]) assert.equal(
    isReusableStableWorkerEmail(`e2e-beta-worker-${slot}-chromium@anywear.local`),
    true,
  );
  for (const address of [
    'e2e-beta-worker-8-chromium@anywear.local',
    'e2e-beta-worker-2-firefox@anywear.local',
    'e2e-test-worker-2-chromium@anywear.local',
    'e2e-beta-worker-2-chromium@example.com',
  ]) assert.equal(isReusableStableWorkerEmail(address), false, address);
});

test('existing stable worker guard accepts the exact private bootstrap identity', () => {
  assert.equal(reusableStableWorkerSubject(user(), email), subject);
});

test('existing stable worker guard rejects foreign or incomplete identities', () => {
  for (const options of [
    { address: 'other@example.com' },
    { sub: 'not-a-uuid' },
    { emailVerified: 'false' },
    { bootstrap: 'false' },
    { sub: '' },
  ]) {
    assert.throws(() => reusableStableWorkerSubject(user(options), email), /not an eligible stable E2E worker/);
  }
  assert.throws(() => reusableStableWorkerSubject(user(), 'e2e-test-worker-2-chromium@anywear.local'), /not an eligible/);
});
