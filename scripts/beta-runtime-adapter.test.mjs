import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntimeDrillAdapter } from './beta-runtime-adapter.mjs';

const environment = {
  AWS_REGION: 'ap-east-1',
  RUNTIME_DRILL_RUN_SCOPE: '123-1-aaaaaaaaaaaaaaaa',
  RUNTIME_DRILL_SERVICE_SHA: 'b'.repeat(40),
  E2E_SERVICE_CHECKOUT: 'AnyWear-Service',
};

function response(status, body = {}) {
  return { status, ok: status >= 200 && status < 300, async text() { return JSON.stringify(body); } };
}

test('runtime adapter exposes every protected hook without making calls at construction', () => {
  const calls = [];
  const adapter = createRuntimeDrillAdapter({
    async aws(args) { calls.push(['aws', args]); return {}; },
    async fetch() { calls.push(['fetch']); return response(200); },
    async sleep() {},
    async cognitoSend() { calls.push(['cognito']); return {}; },
    async runOneShotCleanup() { calls.push(['cleanup']); },
  }, environment);
  assert.deepEqual(Object.keys(adapter).sort(), [
    'captureReplicaAttribution', 'cleanupOwnedResources', 'collectRetryEvidence',
    'createSyntheticAccount', 'replaceAndRestoreEcs', 'runProviderFailureFixture',
    'runWardrobeApiFlow',
  ].sort());
  assert.deepEqual(calls, []);
});

test('synthetic account creation is bound to the current run scope and returned Cognito subject', async () => {
  const commands = [];
  let createdEmail;
  const adapter = createRuntimeDrillAdapter({
    async cognitoSend(command) {
      commands.push(command.constructor.name);
      if (command.constructor.name === 'AdminCreateUserCommand') createdEmail = command.input.Username;
      if (command.constructor.name === 'AdminGetUserCommand') {
        return { UserAttributes: [
          { Name: 'email', Value: createdEmail },
          { Name: 'sub', Value: '123e4567-e89b-12d3-a456-426614174000' },
        ] };
      }
      if (command.constructor.name === 'InitiateAuthCommand') return { AuthenticationResult: { AccessToken: 'token' } };
      return {};
    },
  }, environment);
  const scope = await adapter.createSyntheticAccount({
    config: { serviceUrl: 'https://service.example' }, marker: 'beta-runtime-1',
    stack: { userPoolId: 'pool', userPoolClientId: 'client', bucket: 'bucket' },
  });
  assert.match(scope.email, /^e2e-beta-123-1-aaaaaaaaaaaaaaaa-0-[a-f0-9]{8}@anywear\.local$/);
  assert.equal(scope.subject, '123e4567-e89b-12d3-a456-426614174000');
  assert.equal(scope.accessToken, 'token');
  assert.deepEqual(commands, [
    'AdminCreateUserCommand', 'AdminSetUserPasswordCommand', 'AdminConfirmSignUpCommand',
    'AdminGetUserCommand', 'InitiateAuthCommand',
  ]);
});

test('cleanup deletes API-owned items before pinned Service cleanup, S3, and Cognito', async () => {
  const order = [];
  const io = {
    async fetch(url) { order.push(`api:${url}`); return response(204); },
    async runOneShotCleanup() { order.push('service'); },
    async aws(args) {
      order.push(args[0]);
      if (args[0] === 's3api' && args[1] === 'head-object') throw new Error('Not Found');
      return {};
    },
    async cognitoSend(command) {
      order.push(command.constructor.name);
      if (command.constructor.name === 'AdminGetUserCommand') return { UserAttributes: [
        { Name: 'email', Value: 'e2e-beta-123-1-aaaaaaaaaaaaaaaa-0-01234567@anywear.local' },
        { Name: 'sub', Value: '123e4567-e89b-12d3-a456-426614174000' },
      ] };
      return {};
    },
  };
  const adapter = createRuntimeDrillAdapter(io, environment);
  await adapter.cleanupOwnedResources({
    scope: {
      runScope: '123-1-aaaaaaaaaaaaaaaa',
      email: 'e2e-beta-123-1-aaaaaaaaaaaaaaaa-0-01234567@anywear.local',
      subject: '123e4567-e89b-12d3-a456-426614174000',
      accessToken: 'token', userPoolId: 'pool', config: { serviceUrl: 'https://service.example' },
      deployment: { service_source_commit: 'b'.repeat(40), service_image_digest: `sha256:${'c'.repeat(64)}` },
      item: { itemId: 'item-a' }, failure: { itemId: 'item-b' },
      resources: [{ bucket: 'bucket', key: 'users/owned/item.png' }],
    },
    stack: { bucket: 'bucket' },
  });
  assert.equal(order[0], 'api:https://service.example/wardrobe/items/item-a');
  assert.equal(order[1], 'api:https://service.example/wardrobe/items/item-b');
  assert.equal(order[2], 'service');
  assert.deepEqual(order.slice(-2), ['AdminGetUserCommand', 'AdminDeleteUserCommand']);
});
