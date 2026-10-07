import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createBetaSqsBoundaryConsumer } from './beta-sqs-boundary-consumer.mjs';
import { boundaryDocumentHash, boundaryIntentHash, boundarySigningBytes, verifyBetaBoundarySignature } from './beta-sqs-boundary-protocol.mjs';
import { createSourceOnlyPinnedBoundarySession, loadBetaSqsBoundarySigner, restoreBetaBoundarySigner } from './beta-sqs-boundary-signer.mjs';
import { BOUNDARY_SIGNING_LOCATION, describeBoundaryPublicKey } from './beta-sqs-boundary-trust.mjs';

function fixture() {
  const runner = generateKeyPairSync('ed25519');
  const listener = generateKeyPairSync('ed25519');
  const binding = { runScope: '123-1-0123456789abcdef', taskId: '5ad75c52-13fb-4f6a-973f-b398d8f8a669', messageId: 'fixture-message',
    bodyDigest: 'a'.repeat(64), receiptDigest: 'b'.repeat(64), queue: 'auto-tagging', accountId: '650880818323', region: 'ap-east-1',
    queueArn: 'arn:aws:sqs:ap-east-1:650880818323:beta-anywear-auto-tagging',
    workerTaskArn: 'arn:aws:ecs:ap-east-1:650880818323:task/beta-cluster/0123456789abcdef', listenerId: 'fixture-listener' };
  const attestation = { kind: 'task-listener-credential', taskArn: binding.workerTaskArn, listenerId: binding.listenerId,
    messageId: binding.messageId, bodyDigest: binding.bodyDigest, receiptDigest: binding.receiptDigest, receiveCount: 1,
    credentialId: 'fixture-credential', issuedAt: '2026-10-06T00:00:00Z', expiresAt: '2026-10-06T00:10:00Z', proofDigest: 'c'.repeat(64) };
  let time = Date.parse('2026-10-06T00:01:00Z');
  const der = runner.privateKey.export({ type: 'pkcs8', format: 'der' });
  const secretBytes = Buffer.from(der.toString('base64'), 'ascii'); der.fill(0);
  const options = { secretBytes, trustPin: describeBoundaryPublicKey(runner.publicKey, 'fixture-runner'),
    listenerKeyId: 'fixture-listener', listenerPublicKey: listener.publicKey, binding,
    intentId: 'ae69fb35-e038-40ab-8c48-d125a9b01f40', sequence: 1, deadline: '2026-10-06T00:05:00Z', clock: () => time };
  return { options, attestation, runner, setTime: (next) => { time = next; }, ack: (arm) => {
    const payload = { schemaVersion: 1, kind: 'ACK', intentId: arm.intentId, sequence: arm.sequence + 1,
      deadline: arm.deadline, binding, attestation, armHash: boundaryDocumentHash(arm) };
    const document = { ...payload, intentHash: boundaryIntentHash(payload) };
    return { ...document, signature: { algorithm: 'Ed25519', keyId: 'fixture-listener',
      value: sign(null, boundarySigningBytes(document), listener.privateKey).toString('base64') } };
  } };
}

test('live loader and consumer refuse absent immutable source pin without reading or deleting secret environment', () => {
  const secretName = BOUNDARY_SIGNING_LOCATION.secretName;
  const prior = process.env[secretName];
  try {
    process.env[secretName] = 'fixture-input-must-not-be-read';
    const f = fixture();
    assert.throws(() => loadBetaSqsBoundarySigner(f.options), /Immutable source trust root is missing/);
    assert.throws(() => createBetaSqsBoundaryConsumer(f.options), /Immutable source trust root is missing/);
    assert.equal(process.env[secretName], 'fixture-input-must-not-be-read');
    assert.throws(() => restoreBetaBoundarySigner({ pin: f.options.trustPin }), /Restart aborts/);
  } finally {
    if (prior === undefined) delete process.env[secretName]; else process.env[secretName] = prior;
  }
});

test('memory-only source fixture derives and matches public pin before ARM/FIRE signing', () => {
  const f = fixture(); const session = createSourceOnlyPinnedBoundarySession(f.options);
  try {
    const arm = session.arm(f.attestation, 5);
    assert.equal(arm.signature.keyId, f.options.trustPin.keyId);
    assert.equal(verifyBetaBoundarySignature(arm, f.runner.publicKey), true);
    session.acknowledge(f.ack(arm));
    const fire = session.fire();
    assert.equal(verifyBetaBoundarySignature(fire, f.runner.publicKey), true);
    assert.equal(session.snapshot().mode, 'source-contract-only');
    assert.equal(session.snapshot().liveExecutionEnabled, false);
    assert.equal(session.snapshot().durableAuthority, false);
    assert.throws(() => session.fire(), /closed/);
  } finally { session.close(); f.options.secretBytes.fill(0); }
});

test('wrong private/public pair, malformed encodings, file/PEM input and injected bootstrap are rejected before any signing capability', () => {
  const f = fixture();
  const otherPin = describeBoundaryPublicKey(generateKeyPairSync('ed25519').publicKey, 'fixture-other');
  for (const secretBytes of ['private-file.pem', Buffer.alloc(64, 65), Buffer.from('secret-sentinel'),
    f.runner.privateKey.export({ type: 'pkcs8', format: 'pem' })]) {
    assert.throws(() => createSourceOnlyPinnedBoundarySession({ ...f.options, secretBytes }),
      (error) => error.message === 'Boundary in-memory signing key does not match reviewed public trust');
  }
  assert.throws(() => createSourceOnlyPinnedBoundarySession({ ...f.options, trustPin: otherPin }), /does not match/);
  assert.throws(() => createSourceOnlyPinnedBoundarySession({ ...f.options, bootstrapVerified: true }), /fields/);
  assert.throws(() => loadBetaSqsBoundarySigner({ ...f.options, claimFirstBoot: () => true }), /trust root/);
  f.options.secretBytes.fill(0);
});

test('pinned fixture retains retirement semantics on close, absolute expiry and failed/regressing clock', () => {
  for (const mode of ['close', 'expiry', 'regress', 'failure']) {
    const f = fixture(); let fail = false;
    const session = createSourceOnlyPinnedBoundarySession({ ...f.options, clock: mode === 'failure' ? () => {
      if (fail) throw new Error('private-clock-sentinel'); return Date.parse('2026-10-06T00:01:00Z');
    } : f.options.clock });
    if (mode === 'close') session.close();
    if (mode === 'expiry') f.setTime(Date.parse(f.options.deadline));
    if (mode === 'regress') f.setTime(Date.parse('2026-10-06T00:00:59Z'));
    if (mode === 'failure') fail = true;
    assert.throws(() => session.arm(f.attestation, 5), /closed|regressed|clock failed/);
    session.close(); f.options.secretBytes.fill(0);
  }
});

test('key-loading source has no disk/process transport, runtime adapter, logging or Service implementation import', async () => {
  const source = await readFile(new URL('./beta-sqs-boundary-signer.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /(?:from|import\()\s*['"](?:node:(?:fs|child_process)|@aws-sdk|.*(?:runtime-drill|beta-runtime-adapter|AnyWear-Service))/);
  assert.doesNotMatch(source, /console\.|writeFile|\.export\(|generateKeyPair/);
});
