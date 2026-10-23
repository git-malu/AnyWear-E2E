import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createBetaSqsBoundaryConsumer, createSourceOnlyBoundarySession, resumeBoundarySigner } from './beta-sqs-boundary-consumer.mjs';
import { assertBetaBoundaryChain, boundaryDocumentHash, boundaryIntentHash, boundarySigningBytes } from './beta-sqs-boundary-protocol.mjs';

function fixture(changes = {}) {
  const runner = generateKeyPairSync('ed25519');
  const listener = generateKeyPairSync('ed25519');
  const binding = {
    runScope: '123-1-0123456789abcdef', taskId: '5ad75c52-13fb-4f6a-973f-b398d8f8a669',
    messageId: 'message-01', bodyDigest: 'a'.repeat(64), receiptDigest: 'c'.repeat(64), queue: 'auto-tagging',
    accountId: '650880818323', region: 'ap-east-1', queueArn: 'arn:aws:sqs:ap-east-1:650880818323:beta-anywear-auto-tagging',
    workerTaskArn: 'arn:aws:ecs:ap-east-1:650880818323:task/beta-anywear/0123456789abcdef0123456789abcdef', listenerId: 'listener-1',
  };
  const attestation = {
    kind: 'task-listener-credential', taskArn: binding.workerTaskArn, listenerId: binding.listenerId, messageId: binding.messageId,
    bodyDigest: binding.bodyDigest, receiptDigest: binding.receiptDigest, receiveCount: 1, credentialId: 'credential-1',
    issuedAt: '2026-10-06T00:00:00.000Z', expiresAt: '2026-10-06T00:10:00.000Z', proofDigest: 'b'.repeat(64),
  };
  let time = Date.parse('2026-10-06T00:01:00.000Z');
  const options = { keyId: 'runner-fixture', listenerKeyId: 'listener-fixture', privateKey: runner.privateKey,
    listenerPublicKey: listener.publicKey, binding, intentId: 'ae69fb35-e038-40ab-8c48-d125a9b01f40', sequence: 7,
    deadline: '2026-10-06T00:05:00.000Z', clock: () => time, ...changes };
  const makeAck = (arm, change = {}, signer = listener, keyId = 'listener-fixture') => {
    const payload = { schemaVersion: 1, kind: 'ACK', intentId: arm.intentId, sequence: arm.sequence + 1,
      deadline: arm.deadline, binding: arm.binding, attestation: arm.attestation, armHash: boundaryDocumentHash(arm), ...change };
    const document = { ...payload, intentHash: boundaryIntentHash(payload) };
    return { ...document, signature: { algorithm: 'Ed25519', keyId,
      value: sign(null, boundarySigningBytes(document), signer.privateKey).toString('base64') } };
  };
  return { options, attestation, runner, listener, makeAck, setTime: (next) => { time = next; } };
}

test('live constructor fails closed even with environment or caller fixture trust injection', () => {
  const prior = process.env.BETA_SQS_BOUNDARY_PUBLIC_KEY;
  try {
    process.env.BETA_SQS_BOUNDARY_PUBLIC_KEY = 'unapproved-fixture-root';
    assert.throws(() => createBetaSqsBoundaryConsumer(fixture().options), /Immutable source trust root is missing/);
    assert.throws(() => createBetaSqsBoundaryConsumer({ publicKey: generateKeyPairSync('ed25519').publicKey }), /trust root/);
    assert.throws(() => createBetaSqsBoundaryConsumer(), /trust root/);
  } finally {
    if (prior === undefined) delete process.env.BETA_SQS_BOUNDARY_PUBLIC_KEY;
    else process.env.BETA_SQS_BOUNDARY_PUBLIC_KEY = prior;
  }
});

test('offline ARM/FIRE wire session requires separate listener ACK and never proves AWS identity', () => {
  const f = fixture(); const session = createSourceOnlyBoundarySession(f.options);
  try {
    const arm = session.arm(f.attestation, 5);
    const ack = f.makeAck(arm);
    session.acknowledge(ack);
    const fire = session.fire();
    assertBetaBoundaryChain(arm, ack, fire, (kind, id) => kind === 'ACK'
      ? id === 'listener-fixture' ? f.listener.publicKey : undefined
      : id === 'runner-fixture' ? f.runner.publicKey : undefined);
    assert.deepEqual(session.snapshot(), { mode: 'source-contract-only', phase: 'firing', intentId: f.options.intentId,
      sequence: 9, deadline: f.options.deadline, fireCount: 1, awsIdentityProven: false, durableAuthority: false, liveExecutionEnabled: false });
    assert.equal(session.sign, undefined);
    assert.equal(session.signAck, undefined);
    assert.equal(session.dispatch, undefined);
    assert.equal(session.privateKey, undefined);
    session.recordFixtureOutcome('applied');
    assert.equal(session.snapshot().phase, 'fired');
  } finally { session.close(); }
});

test('runner cannot sign ACK or reuse listener key material/identity', () => {
  const f = fixture();
  assert.throws(() => createSourceOnlyBoundarySession({ ...f.options, listenerPublicKey: f.runner.publicKey }), /impersonate/);
  assert.throws(() => createSourceOnlyBoundarySession({ ...f.options, listenerKeyId: f.options.keyId }), /separate/);
  const session = createSourceOnlyBoundarySession(f.options);
  try {
    const arm = session.arm(f.attestation, 5);
    assert.throws(() => session.acknowledge(f.makeAck(arm, {}, f.runner, 'runner-fixture')), /separate fixture listener/);
    assert.throws(() => session.fire(), /without ACK/);
  } finally { session.close(); }
});

test('fully signed ACK with foreign intent/message/receipt/listener/task/deadline or changed proof is refused', () => {
  const f = fixture(); const session = createSourceOnlyBoundarySession(f.options);
  try {
    const arm = session.arm(f.attestation, 5);
    const changes = [{ intentId: '4e8f4f87-87dd-4a4f-b23d-dcfaa8f48b21' }, { sequence: 99 },
      { deadline: '2026-10-06T00:04:00.000Z' }, { armHash: 'f'.repeat(64) },
      { attestation: { ...f.attestation, proofDigest: 'f'.repeat(64) } },
      ...['messageId', 'receiptDigest', 'listenerId', 'workerTaskArn'].map((key) => ({ binding: { ...arm.binding, [key]: 'foreign' } }))];
    for (const change of changes) assert.throws(() => session.acknowledge(f.makeAck(arm, change)));
    assert.equal(session.snapshot().phase, 'armed');
  } finally { session.close(); }
});

test('only one ARM/ACK/FIRE chain is issued and every replay/rebinding attempt is refused', () => {
  const f = fixture(); const session = createSourceOnlyBoundarySession(f.options);
  try {
    assert.throws(() => session.fire(), /without ACK/);
    const arm = session.arm(f.attestation, 5);
    assert.throws(() => session.arm(f.attestation, 5), /replayed/);
    const ack = f.makeAck(arm); session.acknowledge(ack);
    assert.throws(() => session.acknowledge(ack), /not expected/);
    session.fire();
    assert.throws(() => session.fire(), /closed/);
    assert.throws(() => session.arm(f.attestation, 5), /closed/);
    assert.equal(session.snapshot().fireCount, 1);
    session.recordFixtureOutcome('rejected');
    assert.equal(session.snapshot().phase, 'rejected');
    assert.throws(() => session.recordFixtureOutcome('applied'), /not expected/);
  } finally { session.close(); }
});

test('response loss or close during FIRE remains unknown and never authorizes another mutation', () => {
  for (const closeFirst of [false, true]) {
    const f = fixture(); const session = createSourceOnlyBoundarySession(f.options);
    const arm = session.arm(f.attestation, 5); session.acknowledge(f.makeAck(arm)); session.fire();
    if (closeFirst) session.close(); else session.recordFixtureOutcome('response-loss');
    assert.equal(session.snapshot().phase, 'unknown-outcome');
    f.setTime(Date.parse(f.options.deadline) + 1);
    assert.equal(session.snapshot().phase, 'unknown-outcome');
    assert.throws(() => session.fire(), /closed/);
    assert.throws(() => session.recordFixtureOutcome('applied'), /not expected/);
    session.close();
  }
});

test('close/absolute expiry retire signer references before ARM, ACK and FIRE', () => {
  for (const phase of ['idle', 'armed', 'acknowledged']) {
    for (const close of [false, true]) {
      const f = fixture(); const session = createSourceOnlyBoundarySession(f.options);
      const arm = phase === 'idle' ? undefined : session.arm(f.attestation, 5);
      if (phase === 'acknowledged') session.acknowledge(f.makeAck(arm));
      if (close) session.close(); else f.setTime(Date.parse(f.options.deadline));
      assert.throws(() => session.arm(f.attestation, 5), /closed/);
      assert.throws(() => session.acknowledge(arm), /closed/);
      assert.throws(() => session.fire(), /closed/);
      assert.equal(session.snapshot().phase, close ? 'closed' : 'expired');
      session.close();
    }
  }
});

test('absolute retirement timer releases authority without a further caller operation', async () => {
  const f = fixture(); const deadline = new Date(Date.now() + 40).toISOString();
  const session = createSourceOnlyBoundarySession({ ...f.options, deadline, clock: () => Date.parse(deadline) - 40 });
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(session.snapshot().phase, 'expired');
  assert.throws(() => session.arm(f.attestation, 5), /closed/);
});

test('attestation expiry/future time and a regressing clock refuse signing FIRE', () => {
  const f = fixture(); const session = createSourceOnlyBoundarySession(f.options);
  try {
    assert.throws(() => session.arm({ ...f.attestation, issuedAt: '2026-10-06T00:02:00Z' }, 5), /future/);
    assert.throws(() => session.arm({ ...f.attestation, expiresAt: '2026-10-06T00:00:30Z' }, 5), /stale/);
    const arm = session.arm({ ...f.attestation, expiresAt: '2026-10-06T00:02:00Z' }, 5);
    session.acknowledge(f.makeAck(arm));
    f.setTime(Date.parse('2026-10-06T00:02:00Z'));
    assert.throws(() => session.fire(), /stale/);
    f.setTime(Date.parse('2026-10-06T00:01:59Z'));
    assert.throws(() => session.fire(), /regressed/);
  } finally { session.close(); }
});

test('clock failure is sanitized and later signing stays revoked', () => {
  let failing = false;
  const f = fixture({ clock: () => {
    if (failing) throw new Error('sensitive clock callback value');
    return Date.parse('2026-10-06T00:01:00Z');
  } });
  const session = createSourceOnlyBoundarySession(f.options);
  failing = true;
  assert.throws(() => session.arm(f.attestation, 5), (error) => error.message === 'Boundary clock failed; signing authority retired');
  failing = false;
  assert.throws(() => session.arm(f.attestation, 5), /closed/);
  session.close();
});

test('restart, snapshot restoration, PEM/file keys and runtime transport injection are not APIs', () => {
  const f = fixture(); const session = createSourceOnlyBoundarySession(f.options);
  try {
    const arm = session.arm(f.attestation, 5);
    assert.throws(() => resumeBoundarySigner(session.snapshot()), /cannot be restored/);
    assert.throws(() => createSourceOnlyBoundarySession({ ...f.options, snapshot: session.snapshot() }), /fields/);
    assert.throws(() => createSourceOnlyBoundarySession({ ...f.options, transport: () => { throw new Error('must not execute'); } }), /fields/);
    assert.throws(() => createSourceOnlyBoundarySession({ ...f.options, privateKey: 'file-or-environment-secret' }), /in-memory/);
    assert.throws(() => session.acknowledge(f.makeAck(arm, {}, f.listener, 'unapproved-listener-key')), /listener/);
    assert.equal(JSON.stringify(session).includes('PRIVATE'), false);
    assert.equal(JSON.stringify(session.snapshot()).includes('receipt'), false);
  } finally { session.close(); }
});

test('consumer and protocol have no runtime adapter, Service implementation, I/O or secret-loader dependency', async () => {
  for (const name of ['beta-sqs-boundary-consumer.mjs', 'beta-sqs-boundary-protocol.mjs']) {
    const source = await readFile(new URL(name, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /(?:from|import\()\s*['"](?:node:(?:fs|child_process|http|https)|@aws-sdk|.*(?:runtime-|AnyWear-Service))/);
    assert.doesNotMatch(source, /process\.env|fetch\(|\.export\(|generateKeyPair|writeFile|console\./);
  }
});
