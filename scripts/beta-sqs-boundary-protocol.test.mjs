import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import {
  assertBetaBoundaryChain, boundaryDocumentHash, boundaryIntentHash, boundarySigningBytes, boundaryTimestamp,
  BOUNDARY_ACCOUNT, BOUNDARY_PRODUCER_SHA, BOUNDARY_QUEUE_ARN, BOUNDARY_REGION, canonicalBoundaryJson,
  parseBetaBoundaryDocument, verifyBetaBoundarySignature,
} from './beta-sqs-boundary-protocol.mjs';

const binding = {
  runScope: '123-1-0123456789abcdef', taskId: '5ad75c52-13fb-4f6a-973f-b398d8f8a669',
  messageId: 'message-01', bodyDigest: 'a'.repeat(64), receiptDigest: 'c'.repeat(64), queue: 'auto-tagging',
  accountId: BOUNDARY_ACCOUNT, region: BOUNDARY_REGION, queueArn: BOUNDARY_QUEUE_ARN,
  workerTaskArn: 'arn:aws:ecs:ap-east-1:650880818323:task/beta-cluster/0123456789abcdef', listenerId: 'worker-listener-1',
};
const attestation = {
  kind: 'task-listener-credential', taskArn: binding.workerTaskArn, listenerId: binding.listenerId,
  messageId: binding.messageId, bodyDigest: binding.bodyDigest, receiptDigest: binding.receiptDigest, receiveCount: 1,
  credentialId: 'credential-1', issuedAt: '2026-10-06T00:00:00.000Z', expiresAt: '2026-10-06T00:10:00.000Z', proofDigest: 'b'.repeat(64),
};
const runner = generateKeyPairSync('ed25519');
const listener = generateKeyPairSync('ed25519');
const base = { schemaVersion: 1, intentId: 'ae69fb35-e038-40ab-8c48-d125a9b01f40', deadline: '2026-10-06T00:05:00.000Z', binding, attestation };

// Construct producer-shaped wire documents independently of the consumer's parser/signer.
function producerJson(value) {
  if (Array.isArray(value)) return JSON.stringify(value.map((entry) => JSON.parse(producerJson(entry))));
  if (value && typeof value === 'object') return JSON.stringify(Object.fromEntries(Object.keys(value).sort()
    .map((key) => [key, JSON.parse(producerJson(value[key]))])));
  return JSON.stringify(value);
}
function signed(payload, key = runner, keyId = 'runner-test') {
  const intentHash = createHash('sha256').update(producerJson(payload), 'utf8').digest('hex');
  const signingPayload = { ...payload, intentHash };
  return { ...signingPayload, signature: { algorithm: 'Ed25519', keyId,
    value: sign(null, Buffer.from(producerJson(signingPayload)), key.privateKey).toString('base64') } };
}
function documents(armPayload = {}) {
  const arm = signed({ ...base, kind: 'ARM', sequence: 1, operation: 'change-visibility', visibilitySeconds: 5, ...armPayload });
  const ack = signed({ ...base, kind: 'ACK', sequence: 2, armHash: boundaryDocumentHash(arm) }, listener, 'listener-test');
  const fire = signed({ ...base, kind: 'FIRE', sequence: 3, armHash: boundaryDocumentHash(arm), ackHash: boundaryDocumentHash(ack) });
  return { arm, ack, fire };
}
const resolve = (kind, keyId) => kind === 'ACK'
  ? keyId === 'listener-test' ? listener.publicKey : undefined
  : keyId === 'runner-test' ? runner.publicKey : undefined;

test('fixed Service 80bb9de wire JSON/intent hash/signing-byte digest is an independent golden vector', () => {
  assert.equal(BOUNDARY_PRODUCER_SHA, '80bb9deebec57e6c302439c2a6030c1744ef7a9e');
  const expectedJson = '{"attestation":{"bodyDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",'
    + '"credentialId":"credential-1","expiresAt":"2026-10-06T00:10:00.000Z","issuedAt":"2026-10-06T00:00:00.000Z",'
    + '"kind":"task-listener-credential","listenerId":"worker-listener-1","messageId":"message-01",'
    + '"proofDigest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",'
    + '"receiptDigest":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","receiveCount":1,'
    + '"taskArn":"arn:aws:ecs:ap-east-1:650880818323:task/beta-cluster/0123456789abcdef"},'
    + '"binding":{"accountId":"650880818323","bodyDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",'
    + '"listenerId":"worker-listener-1","messageId":"message-01","queue":"auto-tagging",'
    + '"queueArn":"arn:aws:sqs:ap-east-1:650880818323:beta-anywear-auto-tagging",'
    + '"receiptDigest":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","region":"ap-east-1",'
    + '"runScope":"123-1-0123456789abcdef","taskId":"5ad75c52-13fb-4f6a-973f-b398d8f8a669",'
    + '"workerTaskArn":"arn:aws:ecs:ap-east-1:650880818323:task/beta-cluster/0123456789abcdef"},'
    + '"deadline":"2026-10-06T00:05:00.000Z","intentId":"ae69fb35-e038-40ab-8c48-d125a9b01f40",'
    + '"kind":"ARM","operation":"change-visibility","schemaVersion":1,"sequence":1,"visibilitySeconds":5}';
  const payload = { ...base, kind: 'ARM', sequence: 1, operation: 'change-visibility', visibilitySeconds: 5 };
  assert.equal(canonicalBoundaryJson(payload), expectedJson);
  const expectedHash = 'd7f5218dd0c2d8d4ea017b90cd9b231627018dacc4d8c68487e72fcc86fd882f';
  assert.equal(boundaryIntentHash(payload), expectedHash);
  const expectedSigningBytes = expectedJson.replace(',"intentId":', `,"intentHash":"${expectedHash}","intentId":`);
  assert.equal(boundarySigningBytes({ ...payload, intentHash: expectedHash }).toString('utf8'), expectedSigningBytes);
  assert.equal(createHash('sha256').update(boundarySigningBytes({ ...payload, intentHash: expectedHash })).digest('hex'),
    '910cd4af87ec9e184bae75e856d3b3df292eeb2ce353d929dac4751f871820bb');
});

test('producer-shaped independent sorted JSON/signatures match the wire hash and signing bytes', () => {
  assert.equal(canonicalBoundaryJson({ z: 1, a: { y: 2, x: 3 } }), '{"a":{"x":3,"y":2},"z":1}');
  assert.equal(canonicalBoundaryJson({ Z: 1, a: 2, A: 3 }), '{"A":3,"Z":1,"a":2}');
  const { arm, ack, fire } = documents();
  assert.equal(boundaryIntentHash(arm), arm.intentHash);
  const { signature: ignored, ...payload } = arm;
  void ignored;
  assert.equal(boundarySigningBytes(arm).toString('utf8'), producerJson(payload));
  assert.deepEqual(parseBetaBoundaryDocument(arm), arm);
  assert.equal(verifyBetaBoundarySignature(arm, runner.publicKey), true);
  assert.doesNotThrow(() => assertBetaBoundaryChain(arm, ack, fire, resolve));
  assert.ok(Object.isFrozen(parseBetaBoundaryDocument(arm).attestation));
});

test('canonical JSON refuses silent discard, non-JSON input, accessors, cycles and size/depth abuse', () => {
  const cyclic = {}; cyclic.x = cyclic;
  const accessor = { get secret() { throw new Error('must not execute'); } };
  const sparse = [1, 0, 2]; delete sparse[1];
  const deep = {}; let child = deep;
  for (let i = 0; i < 40; i += 1) { child.next = {}; child = child.next; }
  for (const value of [undefined, { missing: undefined }, BigInt(1), NaN, Infinity, new Date(), new Map(),
    cyclic, accessor, sparse, Object.assign([1], { extra: 1 }), { [Symbol('secret')]: 1 }, deep, 'x'.repeat(65_537)]) {
    assert.throws(() => canonicalBoundaryJson(value), /Boundary JSON/);
  }
});

test('canonical JSON rejects array accessors without executing getters and requires plain enumerable data elements', () => {
  let getterCalls = 0;
  const accessor = [1];
  Object.defineProperty(accessor, '0', { enumerable: true, get() { getterCalls += 1; return 1; } });
  assert.throws(() => canonicalBoundaryJson(accessor), /Boundary JSON array has non-data elements/);
  assert.equal(getterCalls, 0);
  const hidden = [1];
  Object.defineProperty(hidden, '0', { value: 1, enumerable: false });
  assert.throws(() => canonicalBoundaryJson(hidden), /Boundary JSON array has non-data elements/);
  assert.throws(() => canonicalBoundaryJson(Object.setPrototypeOf([1], {})), /Boundary JSON array is not plain/);
  assert.equal(canonicalBoundaryJson([1, { b: 2, a: 3 }, null]), '[1,{"a":3,"b":2},null]');
});

test('strict document schema refuses unexpected fields without reflecting sensitive values', () => {
  const { arm } = documents();
  const sentinel = 'private-or-raw-receipt-sentinel';
  for (const value of [{ ...arm, rawReceipt: sentinel }, { ...arm, signature: { ...arm.signature, privateKey: sentinel } },
    { ...arm, binding: { ...binding, queueUrl: sentinel } }, { ...arm, attestation: { ...attestation, authorization: sentinel } }]) {
    assert.throws(() => parseBetaBoundaryDocument(value), (error) => !error.message.includes(sentinel));
  }
  assert.throws(() => parseBetaBoundaryDocument(Object.assign(Object.create(arm), arm)));
  assert.throws(() => parseBetaBoundaryDocument({ ...arm, get kind() { throw new Error('getter executed'); } }), /Unsupported/);
});

test('foreign/VTO queue, worker/account/region, and invalid receipt bindings never parse', () => {
  const changes = [{ queue: 'vto' }, { accountId: '123456789012' }, { region: 'us-east-1' },
    { queueArn: 'arn:aws:sqs:ap-east-1:650880818323:beta-anywear-vto' },
    { workerTaskArn: binding.workerTaskArn.replace('650880818323', '123456789012') },
    { workerTaskArn: binding.workerTaskArn.replace('ap-east-1', 'us-east-1') },
    { runScope: 'foreign' }, { taskId: 'invalid' }, { bodyDigest: 'x'.repeat(64) }, { receiptDigest: 'C'.repeat(64) }];
  for (const change of changes) {
    assert.throws(() => parseBetaBoundaryDocument(signed({ ...base, kind: 'ARM', sequence: 1,
      operation: 'change-visibility', visibilitySeconds: 5, binding: { ...binding, ...change } })), /binding/);
  }
});

test('attestation is schema/correlation only and rejects every first-receipt binding mismatch', () => {
  for (const change of [{ receiveCount: 2 }, { kind: 'observer-receipt' }, { taskArn: binding.workerTaskArn + '1' },
    { listenerId: 'other-listener' }, { messageId: 'other-message' }, { bodyDigest: 'd'.repeat(64) },
    { receiptDigest: 'd'.repeat(64) }, { issuedAt: attestation.expiresAt }, { proofDigest: 'invalid' }]) {
    assert.throws(() => parseBetaBoundaryDocument(signed({ ...base, kind: 'ARM', sequence: 1,
      operation: 'change-visibility', visibilitySeconds: 5, attestation: { ...attestation, ...change } })));
  }
  const arm = signed({ ...base, kind: 'ARM', sequence: 1, operation: 'change-visibility', visibilitySeconds: 5,
    attestation: { ...attestation, proofDigest: '0'.repeat(64) } });
  assert.doesNotThrow(() => parseBetaBoundaryDocument(arm));
  // A structurally valid proof digest is deliberately not a real STS/SigV4 proof.
});

test('canonical hash/signature tampering, invalid base64 and untrusted or non-public keys fail', () => {
  const { arm } = documents();
  assert.throws(() => parseBetaBoundaryDocument({ ...arm, visibilitySeconds: 6 }), /intent hash/);
  assert.equal(verifyBetaBoundarySignature(arm, listener.publicKey), false);
  assert.equal(verifyBetaBoundarySignature(arm, undefined), false);
  assert.equal(verifyBetaBoundarySignature(arm, runner.privateKey), false);
  assert.equal(verifyBetaBoundarySignature(arm, runner.publicKey.export({ format: 'pem', type: 'spki' })), false);
  assert.equal(verifyBetaBoundarySignature({ ...arm, signature: { ...arm.signature, value: Buffer.alloc(64).toString('base64') } }, runner.publicKey), false);
  for (const value of ['AA==', arm.signature.value.replace(/==$/, ''), arm.signature.value + '\n']) {
    assert.throws(() => parseBetaBoundaryDocument({ ...arm, signature: { ...arm.signature, value } }), /schema/);
  }
});

test('valid re-signing cannot evade chain hashes, role, sequence, intent, deadline or attestation binding', () => {
  const { arm, ack, fire } = documents();
  const ackPayload = { ...base, kind: 'ACK', sequence: 2, armHash: boundaryDocumentHash(arm) };
  for (const change of [{ sequence: 3 }, { intentId: '4e8f4f87-87dd-4a4f-b23d-dcfaa8f48b21' },
    { deadline: '2026-10-06T00:04:00.000Z' }, { armHash: 'f'.repeat(64) },
    { attestation: { ...attestation, proofDigest: 'f'.repeat(64) } }]) {
    const changed = signed({ ...ackPayload, ...change }, listener, 'listener-test');
    assert.throws(() => assertBetaBoundaryChain(arm, changed, fire, resolve));
  }
  assert.throws(() => assertBetaBoundaryChain(arm, signed(ackPayload), fire, resolve), /signature/);
  assert.throws(() => assertBetaBoundaryChain(arm, ack, signed({ ...base, kind: 'FIRE', sequence: 3,
    armHash: boundaryDocumentHash(arm), ackHash: 'f'.repeat(64) }), resolve), /chain/);
  assert.throws(() => assertBetaBoundaryChain(arm, arm, fire, resolve), /signature/);
});

test('schema validates safe sequences, visibility bounds and genuine ISO calendar dates', () => {
  for (const sequence of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parseBetaBoundaryDocument(signed({ ...base, kind: 'ARM', sequence, operation: 'change-visibility', visibilitySeconds: 5 })));
  }
  for (const visibilitySeconds of [-1, 43201, 0.5, '5']) {
    assert.throws(() => parseBetaBoundaryDocument(signed({ ...base, kind: 'ARM', sequence: 1, operation: 'change-visibility', visibilitySeconds })));
  }
  for (const time of ['2026-02-30T00:00:00Z', '2026-10-06', '2026-10-06T24:00:00Z', '2026-10-06T00:00:00+99:00']) {
    assert.throws(() => boundaryTimestamp(time), /timestamp/);
  }
  assert.equal(boundaryTimestamp('2026-10-06T08:00:00+08:00'), Date.parse('2026-10-06T00:00:00Z'));
});
