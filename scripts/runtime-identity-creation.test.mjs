import assert from 'node:assert/strict';
import test from 'node:test';
import { runtimeCloudHarness } from './fixtures/runtime-cloud-harness.mjs';
import { parseRuntimeRecovery } from './runtime-recovery.mjs';
import { compensateCreationIdentity } from './runtime-identity-creation.mjs';

const SUBJECT = '123e4567-e89b-12d3-a456-426614174000';
const FOREIGN = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const nameOf = (command) => command.constructor.name;
const create = (h) => h.adapter.createSyntheticAccount({ config: { serviceUrl: 'https://service.example' },
  marker: h.environment.RUNTIME_DRILL_ID, stack: h.stack, deployment: h.deployment });
const records = (h) => h.writes.map(({ json }) => parseRuntimeRecovery(json));
const assertIdentityOnly = (h) => {
  assert.ok(!h.mutations.some(({ operation }) => /one-shot|definition|service|object|item/.test(operation)));
  records(h);
};
const recover = (h, record) => h.makeAdapter({ ...h.environment, GITHUB_RUN_ID: '456', GITHUB_RUN_ATTEMPT: '1' }).adapter.recoverOwnedRuntime(record);

test('creation intent upload failure prevents AdminCreateUser and retains parser-valid credential-free intent', async () => {
  const h = runtimeCloudHarness({ originalUploadResponseLossAt: 1 });
  await assert.rejects(create(h), /upload response lost/);
  assert.ok(!h.calls.includes('AdminCreateUserCommand'));
  assert.equal(h.uploads.length, 1);
  const [record] = records(h);
  assert.deepEqual(record.users, []);
  assert.equal(record.creation_intent.stage, 'requested');
  assert.ok(!/password|access.?token/i.test(h.writes[0].json));
  assertIdentityOnly(h);
});

test('successful create with lost response discovers the real UUID and durably captures before exact deletion', async () => {
  const h = runtimeCloudHarness();
  const send = h.io.cognitoSend;
  const deletes = [];
  h.io.cognitoSend = async (command) => {
    if (nameOf(command) === 'AdminDeleteUserCommand') {
      deletes.push(command.input.Username);
      assert.equal(records(h).at(-1).users[0].sub, SUBJECT);
      assert.equal(records(h).at(-1).creation_intent.stage, 'captured');
    }
    const response = await send(command);
    if (nameOf(command) === 'AdminCreateUserCommand') throw new Error('Cognito successful creation response lost');
    return response;
  };
  await assert.rejects(create(h), /creation response lost/);
  assert.deepEqual(deletes, [SUBJECT]);
  assert.deepEqual(records(h).map((record) => record.creation_intent.stage), ['requested', 'captured', 'compensated']);
  assertIdentityOnly(h);
});

test('captured record upload response loss remains replayable and never deletes an email alias', async () => {
  const h = runtimeCloudHarness({ originalUploadResponseLossAt: 2 });
  const send = h.io.cognitoSend;
  h.io.cognitoSend = async (command) => {
    if (nameOf(command) === 'AdminDeleteUserCommand') assert.equal(command.input.Username, SUBJECT);
    return send(command);
  };
  await assert.rejects(create(h), /upload response lost/);
  assert.equal(records(h).at(-1).creation_intent.stage, 'compensated');
  await recover(h, parseRuntimeRecovery(h.uploads[1].json));
  assertIdentityOnly(h);
});

test('runner loss after requested intent recovers only Cognito, including lookup-absent and delete-response-loss replay', async () => {
  for (const created of [false, true]) {
    const h = runtimeCloudHarness();
    const send = h.io.cognitoSend;
    let lost = false;
    h.io.cognitoSend = async (command) => {
      if (nameOf(command) === 'AdminCreateUserCommand') {
        if (created) await send(command);
        lost = true;
        throw new Error('runner lost');
      }
      if (lost) throw new Error('runner unavailable');
      return send(command);
    };
    await assert.rejects(create(h), /setup and compensation failed/);
    const requested = records(h)[0];
    const fresh = h.makeAdapter({ ...h.environment, GITHUB_RUN_ID: '456' });
    if (created) {
      fresh.io.cognitoSend = async (command) => {
        const response = await send(command);
        if (nameOf(command) === 'AdminDeleteUserCommand') throw new Error('delete response lost');
        return response;
      };
      await assert.rejects(fresh.adapter.recoverOwnedRuntime(requested), /delete response lost/);
      const captured = records(h).at(-1);
      assert.equal(captured.creation_intent.stage, 'captured');
      await recover(h, captured);
    } else await fresh.adapter.recoverOwnedRuntime(requested);
    assert.equal(records(h).at(-1).creation_intent.stage, 'compensated');
    assert.equal(h.calls.filter((name) => name === 'AdminDeleteUserCommand').length, created ? 1 : 0);
    assertIdentityOnly(h);
  }
});

test('pre-existing aliases and foreign bootstrap/date/immutable pairs fail closed without deletion', async () => {
  for (const boundary of ['preexisting', 'bootstrap', 'date', 'pair', 'uuid']) {
    const h = runtimeCloudHarness();
    const send = h.io.cognitoSend;
    let created = false;
    h.io.cognitoSend = async (command) => {
      if (nameOf(command) === 'AdminCreateUserCommand') created = true;
      if (boundary === 'preexisting' && nameOf(command) === 'AdminGetUserCommand' && !created) return { Username: FOREIGN };
      const response = await send(command);
      if (created && nameOf(command) === 'AdminGetUserCommand') {
        if (boundary === 'bootstrap') response.UserAttributes.find(({ Name }) => Name === 'custom:e2e_bootstrap').Value = 'false';
        if (boundary === 'date') response.UserCreateDate = new Date(Date.now() - 300_000);
        if (boundary === 'pair') { response.Username = FOREIGN; response.UserAttributes.find(({ Name }) => Name === 'sub').Value = FOREIGN; }
        if (boundary === 'uuid') response.Username = 'not-an-immutable-uuid';
      }
      return response;
    };
    await assert.rejects(create(h));
    assert.ok(!h.calls.includes('AdminDeleteUserCommand'));
    if (boundary === 'preexisting') assert.ok(!h.calls.includes('AdminCreateUserCommand'));
    assertIdentityOnly(h);
  }
});

test('normal response fixes immutable identity before any lookup and ignores later alias drift', async () => {
  const h = runtimeCloudHarness();
  const send = h.io.cognitoSend;
  let created = false;
  h.io.cognitoSend = async (command) => {
    if (nameOf(command) === 'AdminCreateUserCommand') created = true;
    if (created && nameOf(command) === 'AdminGetUserCommand') assert.equal(command.input.Username, SUBJECT);
    return send(command);
  };
  const scope = await create(h);
  assert.equal(scope.creationIntent.stage, 'ready');
  assert.deepEqual(records(h).map((record) => record.creation_intent.stage), ['requested', 'captured', 'ready']);
  assertIdentityOnly(h);
});

test('unknown UUID lookup refuses a later replacement outside the intent-relative creation window', async () => {
  const h = runtimeCloudHarness();
  const scope = await create(h);
  delete scope.subject;
  delete scope.cognitoUsername;
  scope.creationIntent.stage = 'requested';
  scope.creationIntent.requested_at = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
  const before = h.mutations.length;
  await assert.rejects(compensateCreationIdentity(h.io, scope), /ownership\/date\/bootstrap/);
  assert.ok(!h.mutations.slice(before).some(({ operation }) => operation === 'AdminDeleteUserCommand'));
});

test('delayed intent persistence refuses creation before its SDK operation starts', async () => {
  const h = runtimeCloudHarness();
  const save = h.io.saveRecovery;
  h.io.saveRecovery = async (scope) => {
    scope.creationIntent.requested_at = new Date(Date.now() - 5 * 60_000).toISOString();
    await save(scope);
  };
  await assert.rejects(create(h), /bounded operation window/);
  assert.ok(!h.calls.includes('AdminCreateUserCommand'));
  records(h);
});

test('creation schema rejects stage ambiguity, fabricated users, unknown keys and identity-only runtime mutations', async () => {
  const h = runtimeCloudHarness({ originalUploadResponseLossAt: 1 });
  await assert.rejects(create(h));
  const requested = records(h)[0];
  for (const mutate of [
    (record) => { record.creation_intent.stage = 'unknown'; },
    (record) => { record.creation_intent.run_scope = 'foreign'; },
    (record) => { delete record.creation_intent.requested_at; },
    (record) => { record.creation_intent.requested_at = 2026; },
    (record) => { record.creation_intent.requested_at = '2026-02-31T00:00:00.000Z'; },
    (record) => { record.creation_intent.requested_at = '2026-10-05'; },
    (record) => { record.creation_intent.extra = true; },
    (record) => { record.creation_intent.stage = 'captured'; },
    (record) => { record.users = [{ sub: SUBJECT, username: SUBJECT, email: record.creation_intent.email }]; },
    (record) => { record.runtime_control = { run_scope: record.run_scope }; },
    (record) => { record.database_cleanup_completed = true; },
    (record) => { record.items.push(SUBJECT); },
  ]) {
    const record = structuredClone(requested);
    mutate(record);
    assert.throws(() => parseRuntimeRecovery(JSON.stringify(record)));
  }
});
