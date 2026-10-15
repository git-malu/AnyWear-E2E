import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DirectTeardown,
  deleteRouteFor,
  machineAuthHeaders,
  quarantinesScope,
} from '../tests/support/cleanup-operation.ts';
import { readAttemptBusinessCleanup } from '../tests/support/attempt-cleanup-registry.ts';

const SECRET = { CLEANUP_MACHINE_AUTH_SECRET: 'test-secret' };
const OWNER_SUB = '11111111-2222-3333-4444-555555555555';
const RUN_SCOPE = '12345-1-abcdef0123456789';

// The registry key is the attempt identity and is never inspected, so a fresh
// object per attempt is an exact stand-in for the Playwright `TestInfo`.
let attemptCounter = 0;
function fakeTestInfo() {
  attemptCounter += 1;
  return { attempt: 'attempt-' + attemptCounter };
}

function harness(options = {}) {
  const calls = [];
  const deletes = [];
  const teardown = new DirectTeardown({
    runScope: RUN_SCOPE,
    testScope: 'wardrobe.spec.ts::scenario',
    retryIndex: 0,
    leaseId: 'lease-1',
    leaseGeneration: 7,
    expectedUsername: 'e2e-beta-worker-0-chromium@anywear.local',
    expectedEmail: 'e2e-beta-worker-0-chromium@anywear.local',
    serviceUrl: 'https://service.invalid',
    environment: SECRET,
    request: {},
    testInfo: options.testInfo ?? fakeTestInfo(),
    io: async (path, init) => {
      calls.push({ path, ...init });
      if (path.endsWith('/register')) {
        return options.register ?? { status: 201, body: { operation_id: 'op-1', state_version: 1, phase: 'registered', intent_hash: 'hash', replayed: false } };
      }
      if (path.endsWith('/owner-binding')) {
        return options.bind ?? { status: 200, body: { operation_id: 'op-1', state_version: 2, phase: 'owner_bound', product_result: null, teardown_result: null, scope_state: null, active_tasks: 0, pending_outbox: 0 } };
      }
      return options.acknowledge ?? { status: 200, body: { operation_id: 'op-1', state_version: 9, phase: 'lease_terminal', product_result: 'passed', teardown_result: 'passed', scope_state: 'released', active_tasks: 0, pending_outbox: 0 } };
    },
    deleteIo: async (url, authorization) => {
      deletes.push({ url, authorization });
      return options.deleteStatus ? options.deleteStatus(url) : 200;
    },
  });
  return { teardown, calls, deletes };
}

function attempt(retryIndex, leaseGeneration, payloads, testInfo = fakeTestInfo()) {
  return new DirectTeardown({
    runScope: RUN_SCOPE, testScope: 'wardrobe.spec.ts::scenario', retryIndex,
    leaseId: 'lease-1', leaseGeneration,
    expectedUsername: 'u', expectedEmail: 'u@anywear.local',
    serviceUrl: 'https://service.invalid', request: {}, environment: SECRET,
    testInfo,
    io: async (_path, init) => {
      payloads.push(JSON.parse(init.data));
      return { status: 201, body: { operation_id: 'op-' + retryIndex, state_version: 1, phase: 'registered', intent_hash: 'hash', replayed: false } };
    },
  });
}

test('every machine call carries a short-lived signature bound to its exact body', async () => {
  const { teardown, calls } = harness();
  await teardown.register();
  await teardown.bindOwner(OWNER_SUB);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.ok(call.headers['X-AnyWear-Machine-Signature'], 'signature present');
    assert.ok(call.headers['X-Request-Id'], 'request id present');
    const expiresAt = Number(call.headers['X-AnyWear-Machine-Expires-At']);
    assert.ok(expiresAt > Date.now() && expiresAt <= Date.now() + 180_000, 'short lived and inside the Service TTL window');
    assert.equal(typeof call.data, 'string');
  }
});

test('registration must precede binding and acknowledgement', async () => {
  const { teardown } = harness();
  await assert.rejects(() => teardown.bindOwner(OWNER_SUB), /registered before this step/);
  await assert.rejects(() => teardown.finalize('passed', 'Bearer t'), /registered before this step/);
});

test('registration refusal aborts the attempt without claiming a scope', async () => {
  const { teardown } = harness({ register: { status: 400, body: { error: 'VALIDATION_ERROR' } } });
  await assert.rejects(() => teardown.register(), /refused with 400/);
  assert.equal(teardown.id, undefined);
});

test('owner binding refuses a malformed subject before any request', async () => {
  const { teardown, calls } = harness();
  await teardown.register();
  const before = calls.length;
  await assert.rejects(() => teardown.bindOwner('not-a-subject'), /subject is malformed/);
  assert.equal(calls.length, before);
});

test('exact created resource refs are captured once each, sent in the acknowledgement, and deleted through user routes', async () => {
  const { teardown, calls, deletes } = harness();
  await teardown.register();
  teardown.capture('wardrobe_item', 'item-1');
  teardown.capture('wardrobe_item', 'item-1');
  teardown.capture('outfit_generation', 'gen-1');
  teardown.capture('base_photo', 'photo-1');
  teardown.capture('outfit', 'outfit-1');
  assert.equal(teardown.captured.length, 4);
  await teardown.finalize('passed', 'Bearer token');
  assert.deepEqual(deletes.map((entry) => entry.url), [
    'https://service.invalid/wardrobe/items/item-1',
    'https://service.invalid/vto/generations/gen-1',
    'https://service.invalid/vto/base-photos/photo-1',
    'https://service.invalid/outfits/outfit-1',
  ]);
  assert.ok(deletes.every((entry) => entry.authorization === 'Bearer token'));
  const acknowledge = calls.at(-1);
  assert.ok(acknowledge);
  assert.deepEqual(JSON.parse(acknowledge.data).resource_refs, [
    { kind: 'wardrobe_item', id: 'item-1' },
    { kind: 'outfit_generation', id: 'gen-1' },
    { kind: 'base_photo', id: 'photo-1' },
    { kind: 'outfit', id: 'outfit-1' },
  ]);
});

test('terminal acknowledgement sends an empty resource ref list when no resources were captured', async () => {
  const { teardown, calls } = harness();
  await teardown.register();
  await teardown.finalize('passed', 'Bearer token');
  const acknowledge = calls.at(-1);
  assert.ok(acknowledge);
  assert.deepEqual(JSON.parse(acknowledge.data).resource_refs, []);
});

test('malformed resource refs fail closed without changing the captured set', async () => {
  const { teardown, calls } = harness();
  await teardown.register();
  teardown.capture('wardrobe_item', 'item-1');
  for (const ref of [
    { kind: 'unknown', id: 'bad-kind' },
    { kind: 'wardrobe_item', id: '' },
    { kind: 'wardrobe_item', id: 'a'.repeat(129) },
    { kind: 'wardrobe_item', id: 42 },
  ]) {
    assert.throws(() => teardown.capture(ref.kind, ref.id), /Cleanup resource/);
  }
  assert.deepEqual(teardown.captured, [{ kind: 'wardrobe_item', id: 'item-1' }]);
  await teardown.finalize('passed', 'Bearer token');
  const acknowledge = calls.at(-1);
  assert.ok(acknowledge);
  assert.deepEqual(JSON.parse(acknowledge.data).resource_refs, [{ kind: 'wardrobe_item', id: 'item-1' }]);
});

test('404 is a successful teardown', async () => {
  const { teardown } = harness({ deleteStatus: () => 404 });
  await teardown.register();
  teardown.capture('wardrobe_item', 'item-1');
  const result = await teardown.finalize('passed', 'Bearer token');
  assert.equal(result.teardown_result, 'passed');
  assert.equal(result.scope_state, 'released');
});

test('a failing delete partially fails teardown and quarantines without rewriting the product result', async () => {
  const { teardown, calls } = harness({ deleteStatus: (url) => (url.includes('/outfits/') ? 500 : 200) });
  await teardown.register();
  teardown.capture('wardrobe_item', 'item-1');
  teardown.capture('outfit', 'outfit-1');
  const result = await teardown.finalize('passed', 'Bearer token');
  assert.equal(result.teardown_result, 'partial');
  assert.equal(result.scope_state, 'quarantined');
  assert.equal(result.product_result, 'passed', 'a teardown failure never overwrites the product assertion');
  assert.ok(result.quarantine_reason && result.quarantine_reason.includes('outfit:outfit-1'));
  const acknowledge = calls.at(-1);
  assert.ok(acknowledge);
  const body = JSON.parse(acknowledge.data ?? '{}');
  assert.equal(body.product_result, 'passed');
  assert.equal(body.teardown_result, 'partial');
  assert.equal(body.scope_state, 'quarantined');
});

test('every delete failing reports failed teardown and keeps the product result', async () => {
  const { teardown } = harness({ deleteStatus: () => 500 });
  await teardown.register();
  teardown.capture('wardrobe_item', 'item-1');
  const result = await teardown.finalize('failed', 'Bearer token');
  assert.equal(result.teardown_result, 'failed');
  assert.equal(result.scope_state, 'quarantined');
  assert.equal(result.product_result, 'failed');
});

test('a captured ref with no ordinary user delete route quarantines instead of being skipped', async () => {
  const { teardown, deletes } = harness();
  await teardown.register();
  teardown.capture('object_key', 'uploads/key.png');
  const result = await teardown.finalize('passed', 'Bearer token');
  assert.equal(deletes.length, 0);
  assert.equal(result.teardown_result, 'failed');
  assert.equal(result.scope_state, 'quarantined');
});

test('finalize is idempotent per attempt and deletes each ref only once', async () => {
  const { teardown, deletes, calls } = harness();
  await teardown.register();
  teardown.capture('wardrobe_item', 'item-1');
  const first = await teardown.finalize('passed', 'Bearer token');
  const afterFirst = { deletes: deletes.length, calls: calls.length };
  const second = await teardown.finalize('passed', 'Bearer token');
  assert.equal(second.teardown_result, first.teardown_result);
  assert.equal(deletes.length, afterFirst.deletes);
  assert.equal(calls.length, afterFirst.calls);
});

test('a retry allocates a distinct scope index and a fresh lease generation', async () => {
  const payloads = [];
  await attempt(0, 1, payloads).register();
  await attempt(1, 2, payloads).register();
  assert.equal(payloads[0].retry_index, 0);
  assert.equal(payloads[0].lease_generation, 1);
  assert.equal(payloads[1].retry_index, 1);
  assert.equal(payloads[1].lease_generation, 2);
});

test('an attempt declares nothing until it registers, and registration opens the declaration', async () => {
  const testInfo = fakeTestInfo();
  const { teardown } = harness({ testInfo });
  assert.deepEqual(readAttemptBusinessCleanup(testInfo), { email: '', state: 'undeclared' });

  await teardown.register();
  assert.deepEqual(readAttemptBusinessCleanup(testInfo), {
    email: 'e2e-beta-worker-0-chromium@anywear.local',
    state: 'open',
  });
  // An attempt that never registered still waits for its own outcome.
  const unregistered = fakeTestInfo();
  assert.deepEqual(readAttemptBusinessCleanup(unregistered), { email: '', state: 'undeclared' });
});

test('a refused registration never claims a lease declaration', async () => {
  const testInfo = fakeTestInfo();
  const { teardown } = harness({ testInfo, register: { status: 400, body: { error: 'VALIDATION_ERROR' } } });
  await assert.rejects(() => teardown.register(), /refused with 400/);
  assert.deepEqual(readAttemptBusinessCleanup(testInfo), { email: '', state: 'undeclared' });
});

test('finalize closes the declaration with the teardown outcome it recorded', async () => {
  const declared = fakeTestInfo();
  const { teardown } = harness({ testInfo: declared });
  await teardown.register();
  teardown.capture('wardrobe_item', 'item-1');
  const result = await teardown.finalize('passed', 'Bearer token');
  assert.equal(result.teardown_result, 'passed');
  assert.deepEqual(readAttemptBusinessCleanup(declared), {
    email: 'e2e-beta-worker-0-chromium@anywear.local',
    state: 'closed',
    teardownResult: 'passed',
  });

  const partialInfo = fakeTestInfo();
  const partial = harness({ testInfo: partialInfo, deleteStatus: (url) => (url.includes('/outfits/') ? 500 : 200) });
  await partial.teardown.register();
  partial.teardown.capture('wardrobe_item', 'item-1');
  partial.teardown.capture('outfit', 'outfit-1');
  const partialResult = await partial.teardown.finalize('passed', 'Bearer token');
  assert.equal(partialResult.teardown_result, 'partial');
  const partialDeclaration = readAttemptBusinessCleanup(partialInfo);
  assert.equal(partialDeclaration.state, 'closed');
  assert.equal(partialDeclaration.teardownResult, 'partial');
  assert.match(partialDeclaration.reason, /^teardown partial; undeleted outfit:outfit-1$/);

  const failedInfo = fakeTestInfo();
  const failed = harness({ testInfo: failedInfo, deleteStatus: () => 500 });
  await failed.teardown.register();
  failed.teardown.capture('wardrobe_item', 'item-1');
  const failedResult = await failed.teardown.finalize('failed', 'Bearer token');
  assert.equal(failedResult.teardown_result, 'failed');
  const failedDeclaration = readAttemptBusinessCleanup(failedInfo);
  assert.equal(failedDeclaration.state, 'closed');
  assert.equal(failedDeclaration.teardownResult, 'failed');
});

test('the direct acknowledgement path closes the declaration too', async () => {
  const testInfo = fakeTestInfo();
  const { teardown } = harness({ testInfo });
  await teardown.register();
  await teardown.acknowledge('skipped', 'passed');
  assert.deepEqual(readAttemptBusinessCleanup(testInfo), {
    email: 'e2e-beta-worker-0-chromium@anywear.local',
    state: 'closed',
    teardownResult: 'passed',
  });
});

test('a refused acknowledgement leaves the declaration open, so the lease cannot release', async () => {
  const testInfo = fakeTestInfo();
  const { teardown } = harness({ testInfo, acknowledge: { status: 409, body: { error: 'LEASE_FENCED' } } });
  await teardown.register();
  await assert.rejects(() => teardown.finalize('passed', 'Bearer token'), /acknowledgement refused with 409/);
  assert.deepEqual(readAttemptBusinessCleanup(testInfo), {
    email: 'e2e-beta-worker-0-chromium@anywear.local',
    state: 'open',
  });
});

test('the declaration key is the attempt, not the leased address', async () => {
  // Two attempts share one allowlisted address and one lease generation, which a
  // string-keyed registry would conflate.
  const firstAttempt = fakeTestInfo();
  const secondAttempt = fakeTestInfo();
  const first = harness({ testInfo: firstAttempt });
  const second = harness({ testInfo: secondAttempt });
  await first.teardown.register();
  await second.teardown.register();
  first.teardown.capture('wardrobe_item', 'item-1');
  const firstResult = await first.teardown.finalize('passed', 'Bearer token');
  assert.equal(firstResult.teardown_result, 'passed');

  assert.deepEqual(readAttemptBusinessCleanup(firstAttempt), {
    email: 'e2e-beta-worker-0-chromium@anywear.local',
    state: 'closed',
    teardownResult: 'passed',
  });
  assert.deepEqual(readAttemptBusinessCleanup(secondAttempt), {
    email: 'e2e-beta-worker-0-chromium@anywear.local',
    state: 'open',
  });
});

test('an unregistered operation is never acknowledged', async () => {
  const { teardown, calls } = harness();
  await assert.rejects(() => teardown.acknowledge('passed', 'passed'), /registered before this step/);
  assert.equal(calls.length, 0);
});

test('delete routes match the existing user-facing Service surface', () => {
  assert.equal(deleteRouteFor({ kind: 'wardrobe_item', id: 'i' }), '/wardrobe/items/i');
  assert.equal(deleteRouteFor({ kind: 'outfit', id: 'o' }), '/outfits/o');
  assert.equal(deleteRouteFor({ kind: 'outfit_generation', id: 'g' }), '/vto/generations/g');
  assert.equal(deleteRouteFor({ kind: 'base_photo', id: 'b' }), '/vto/base-photos/b');
  assert.equal(deleteRouteFor({ kind: 'object_key', id: 'k' }), undefined);
});

test('scope quarantine follows teardown failure, not the product outcome', () => {
  assert.equal(quarantinesScope('passed'), false);
  assert.equal(quarantinesScope('partial'), true);
  assert.equal(quarantinesScope('failed'), true);
});

test('machine auth refuses to sign without its secret', () => {
  assert.throws(() => machineAuthHeaders('operation:register', '{}', {}), /CLEANUP_MACHINE_AUTH_SECRET/);
});

