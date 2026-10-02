import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deleteCapturedCognitoIdentity, verifyCapturedCognitoIdentity } from '../tests/support/cognito-cleanup.ts';

const identity = {
  email: 'e2e-beta-allowlist-36970278486-1-b8e457e661b346ad-primary@anywear.local',
  sub: '7442ec8e-5051-709b-e2ec-f1b3118f45a0',
};

function fixture({ email = identity.email, sub = identity.sub, username = identity.sub } = {}) {
  const calls = [];
  const user = { Username: username, UserAttributes: [{ Name: 'email', Value: email }, { Name: 'sub', Value: sub }] };
  return {
    calls, user,
    async getUser(value) { calls.push({ get: value }); return user; },
    async deleteUser(value) { calls.push({ delete: value }); },
  };
}

test('Cognito deletion uses its returned immutable username after validating captured email and UUID-shaped subject', async () => {
  const boundary = fixture({ username: 'immutable-cognito-user' });
  await deleteCapturedCognitoIdentity(identity, boundary);
  assert.deepEqual(boundary.calls, [{ get: identity.email }, { delete: 'immutable-cognito-user' }]);
});

test('changed Cognito subject or email refuses deletion', async () => {
  for (const options of [{ sub: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }, { email: 'other@example.com' }]) {
    const boundary = fixture(options);
    await assert.rejects(deleteCapturedCognitoIdentity(identity, boundary), /different Cognito identity/);
    assert.deepEqual(boundary.calls, [{ get: identity.email }]);
  }
});

test('missing captured subject, malformed subject, or nonsynthetic email cannot initiate Cognito cleanup', async () => {
  for (const value of [{ email: identity.email }, { ...identity, sub: 'malformed' }, { ...identity, email: 'actual-tester@example.com' }]) {
    const boundary = fixture();
    await assert.rejects(deleteCapturedCognitoIdentity(value, boundary), /captured synthetic email and subject/);
    assert.deepEqual(boundary.calls, []);
  }
});

test('Cognito account recreated after cleanup preflight is rejected by the final deletion recheck', async () => {
  const boundary = fixture();
  assert.equal(await verifyCapturedCognitoIdentity(identity, boundary), identity.sub);
  boundary.user.UserAttributes[1].Value = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  await assert.rejects(deleteCapturedCognitoIdentity(identity, boundary), /different Cognito identity/);
  assert.deepEqual(boundary.calls, [{ get: identity.email }, { get: identity.email }]);
});

test('Cognito cleanup rejects a returned email alias rather than using it as an immutable username', async () => {
  const boundary = fixture({ username: identity.email });
  await assert.rejects(deleteCapturedCognitoIdentity(identity, boundary), /returned immutable username/);
  assert.deepEqual(boundary.calls, [{ get: identity.email }]);
});

test('already absent Cognito users are idempotent for SDK and AWS CLI errors', async () => {
  for (const error of [Object.assign(new Error('Account absent'), { name: 'UserNotFoundException' }), new Error('An error occurred (UserNotFoundException) calling AdminGetUser')]) {
    const boundary = fixture();
    boundary.getUser = async (value) => { boundary.calls.push({ get: value }); throw error; };
    await deleteCapturedCognitoIdentity(identity, boundary);
    assert.deepEqual(boundary.calls, [{ get: identity.email }]);
  }
  const boundary = fixture();
  boundary.deleteUser = async (value) => { boundary.calls.push({ delete: value }); throw Object.assign(new Error('Account absent'), { name: 'UserNotFoundException' }); };
  await deleteCapturedCognitoIdentity(identity, boundary);
  assert.deepEqual(boundary.calls, [{ get: identity.email }, { delete: identity.sub }]);
});

test('Cognito authorization failures remain failures instead of being treated as absent accounts', async () => {
  const boundary = fixture();
  boundary.getUser = async () => { throw new Error('AccessDeniedException'); };
  await assert.rejects(deleteCapturedCognitoIdentity(identity, boundary), /AccessDeniedException/);
  assert.deepEqual(boundary.calls, []);
});
