import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { BOUNDARY_FIRST_BOOT_BUCKET, claimBetaBoundarySignerFirstBoot, createSourceOnlyFirstBootHarness } from './beta-sqs-boundary-first-boot.mjs';
import { BOUNDARY_PRODUCER_SHA, canonicalBoundaryJson } from './beta-sqs-boundary-protocol.mjs';
import { BOUNDARY_CONTROLLER_ROLE_ARN } from './beta-sqs-boundary-run-context.mjs';
import { describeBoundaryPublicKey } from './beta-sqs-boundary-trust.mjs';

function fixture(changes = {}) {
  const now = Date.parse('2026-10-07T00:00:00Z'); const calls = []; const store = changes.store ?? new Map();
  const sessionName = 'beta-sqs-123-0123456789abcdef';
  const context = { schemaVersion: 1, mode: 'source-only-server-response-fixture', runScope: '123-1-0123456789abcdef',
    accountId: '650880818323', region: 'ap-east-1', repository: 'git-malu/AnyWear-E2E', environment: 'beta', ref: 'refs/heads/main',
    e2eSha: 'a'.repeat(40), serviceSha: BOUNDARY_PRODUCER_SHA, roleArn: BOUNDARY_CONTROLLER_ROLE_ARN,
    principalArn: `arn:aws:sts:650880818323:assumed-role/beta-anywear-sqs-boundary-controller/${sessionName}`,
    principalId: `AROAFIXTURE:${sessionName}`, oidcSubject: 'repo:git-malu/AnyWear-E2E:environment:beta',
    workflowRef: 'git-malu/AnyWear-E2E/.github/workflows/future-signer.yml@refs/heads/main',
    issuedAt: '2026-10-07T00:00:00Z', deadline: '2026-10-07T00:05:00Z', oidcIdentityProven: false, ...changes.context };
  const trustPin = describeBoundaryPublicKey(generateKeyPairSync('ed25519').publicKey, 'fixture-public');
  const send = async (command) => {
    calls.push(command); const input = command.input;
    if (command.constructor.name === 'PutObjectCommand') {
      if (store.has(input.Key)) throw new Error('PreconditionFailed');
      store.set(input.Key, input);
      if (changes.responseLoss) throw new Error('private-transport-sentinel');
      return { $metadata: { httpStatusCode: 200 }, ETag: 'fixture-etag' };
    }
    const saved = store.get(input.Key);
    return { $metadata: { httpStatusCode: 200 }, ETag: 'fixture-etag', ContentType: 'application/json',
      ContentLength: Buffer.byteLength(saved.Body), Metadata: saved.Metadata,
      Body: { transformToByteArray: async () => Buffer.from(changes.body ?? saved.Body) }, ...changes.read };
  };
  const harness = createSourceOnlyFirstBootHarness({ context, trustPin, send, nonce: () => 'b'.repeat(64),
    clock: changes.clock ?? (() => now) });
  return { harness, calls, context, store };
}

test('hermetic first-boot CAS uses exact private signer namespace/account/bucket, conditional create and authoritative canonical nonce readback', async () => {
  const f = fixture(); const claim = await f.harness.claim();
  assert.equal(claim.mode, 'source-only-first-boot-fixture'); assert.equal(claim.durableAuthority, false);
  assert.equal(claim.permitsRestore, false); assert.equal(claim.liveExecutionEnabled, false);
  assert.equal(f.calls.length, 2);
  const put = f.calls[0].input; const get = f.calls[1].input;
  assert.equal(put.Bucket, BOUNDARY_FIRST_BOOT_BUCKET); assert.equal(put.ExpectedBucketOwner, '650880818323');
  assert.equal(put.Key, 'sqs-boundary/v1/runs/123-1-0123456789abcdef/signer/first-boot.json');
  assert.equal(put.IfNoneMatch, '*'); assert.equal(put.ServerSideEncryption, 'AES256');
  assert.deepEqual(get, { Bucket: put.Bucket, Key: put.Key, ExpectedBucketOwner: put.ExpectedBucketOwner });
  assert.equal(put.Body, canonicalBoundaryJson(claim.marker));
  assert.equal(claim.marker.bootNonce, 'b'.repeat(64)); assert.equal(claim.marker.e2eSha, 'a'.repeat(40));
  assert.equal(claim.marker.serviceSha, BOUNDARY_PRODUCER_SHA);
  assert.equal(claim.markerSha256, put.Metadata.sha256);
  assert.doesNotMatch(JSON.stringify(claim), /secretAccessKey|sessionToken|privateKey|ttl|expiresAt/);
});

test('existing marker refuses a second process, even exact same context; marker is never deleted', async () => {
  const f = fixture(); await f.harness.claim();
  const restarted = fixture({ store: f.store });
  await assert.rejects(() => restarted.harness.claim(), /restart are refused/);
  assert.equal(restarted.calls.length, 1); assert.equal(f.store.size, 1);
  assert.equal(f.harness.restore, undefined); assert.equal(f.harness.delete, undefined);
});

test('conditional-write response loss retains the marker, refuses loading and cannot be retried into success', async () => {
  const f = fixture({ responseLoss: true });
  await assert.rejects(() => f.harness.claim(), (error) => error.message ===
    'Beta signer first boot is existing, failed, or unknown; signer loading and restart are refused');
  assert.equal(f.calls.length, 1); assert.equal(f.store.size, 1);
  const restarted = fixture({ store: f.store });
  await assert.rejects(() => restarted.harness.claim(), /refused/); assert.equal(restarted.calls.length, 1);
});

test('changed nonce/envelope, ETag/content type/hash/length and missing body cannot authorize first boot', async () => {
  for (const changes of [{ body: '{}' }, { read: { ETag: 'foreign' } }, { read: { ContentType: 'text/plain' } },
    { read: { Metadata: { sha256: 'a'.repeat(64) } } }, { read: { ContentLength: 8193 } }, { read: { Body: undefined } }]) {
    const f = fixture(changes); await assert.rejects(() => f.harness.claim(), /refused/);
    assert.equal(f.store.size, 1); assert.equal(f.calls.length, 2);
  }
});

test('foreign immutable bindings/role/run/sha and stale/regressing clock refuse without mutation or remain disarmed after delayed readback', async () => {
  for (const context of [{ accountId: '123456789012' }, { region: 'us-east-1' }, { repository: 'foreign/repo' },
    { environment: 'prod' }, { ref: 'refs/heads/other' }, { serviceSha: 'a'.repeat(40) }, { e2eSha: 'main' },
    { roleArn: 'foreign-role' }, { runScope: '123-2-0123456789abcdef' }]) {
    const f = fixture({ context }); await assert.rejects(() => f.harness.claim(), /refused/);
    assert.equal(f.calls.length, 0);
  }
  let calls = 0; const now = Date.parse('2026-10-07T00:00:00Z');
  const f = fixture({ clock: () => now - calls++ });
  await assert.rejects(() => f.harness.claim(), /refused/); assert.equal(f.store.size, 1);
});

test('live first boot cannot be activated by a fixture context or caller trust pin', async () => {
  const f = fixture();
  await assert.rejects(() => claimBetaBoundarySignerFirstBoot({ ...f.context, oidcIdentityProven: true }), /trust root is missing/);
});

test('first-boot production source has maxAttempts1, official SDK owner guard and no delete, TTL, file, retry or runtime execution path', async () => {
  const source = await readFile(new URL('./beta-sqs-boundary-first-boot.mjs', import.meta.url), 'utf8');
  assert.match(source, /maxAttempts: 1/); assert.match(source, /IfNoneMatch: '\*'/);
  assert.doesNotMatch(source, /DeleteObject|expiresAt|ttl|node:fs|node:child_process|console\.|runtime-drill|beta-runtime-adapter/);
});
