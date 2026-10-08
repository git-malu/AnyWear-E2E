import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertStableDeploymentEvidence,
  buildQualificationRecord,
  collectDeploymentEvidence,
  verifyQualificationRecord,
} from './qualification-record.mjs';
import { qualificationFixture } from './fixtures/infra-qualification.mjs';

const compatibility = {
  client: { repository: 'git-malu/AnyWear-Client', sha: 'a'.repeat(40) },
  service: { repository: 'git-malu/AnyWear-Service', sha: 'b'.repeat(40) },
};
const evidence = {
  client: {
    url: 'https://beta.anywear.example',
    source_commit: compatibility.client.sha,
    built_at: '2026-08-03T00:00:00.000Z',
  },
  service: {
    url: 'https://api.beta.anywear.example',
    source_commit: compatibility.service.sha,
    image_digest: `sha256:${'c'.repeat(64)}`,
  },
};
const input = {
  result: 'passed',
  e2eSha: 'd'.repeat(40),
  repository: 'git-malu/AnyWear-E2E',
  runId: '123',
  runAttempt: '1',
  serverUrl: 'https://github.com',
  awsAccountId: '123456789012',
  awsRegion: 'us-east-1',
};

test('collects only deployed revisions matching compatibility.json', async () => {
  const fetcher = async (url) => {
    const body = url.pathname === '/build-metadata.json'
      ? { component: 'AnyWear-Client', source_commit: compatibility.client.sha, built_at: evidence.client.built_at }
      : { status: 'ok', service_commit: compatibility.service.sha, image_digest: evidence.service.image_digest };
    return new Response(JSON.stringify(body), { status: 200 });
  };

  const result = await collectDeploymentEvidence({
    clientUrl: evidence.client.url,
    serviceUrl: evidence.service.url,
    runId: '123',
  }, compatibility, fetcher);

  assert.equal(result.client.source_commit, compatibility.client.sha);
  assert.equal(result.service.image_digest, evidence.service.image_digest);
});

test('creates and verifies a checksummed passing record', () => {
  const fixture = qualificationFixture();
  const record = buildQualificationRecord(fixture.input, fixture.compatibility, fixture.evidence, new Date('2026-10-08T00:20:00.000Z'));
  assert.equal(record.qualification_id, 'beta-123-1');
  assert.equal(verifyQualificationRecord(record), true);

  const tampered = structuredClone(record);
  tampered.revisions.service.sha = 'e'.repeat(40);
  assert.throws(() => verifyQualificationRecord(tampered), /checksum mismatch/);
});

test('accepts stable deployment identities before and after qualification', () => {
  assert.doesNotThrow(() => assertStableDeploymentEvidence(evidence, structuredClone(evidence)));
});

test('rejects an image or client rebuild that changes during qualification', () => {
  const changedImage = structuredClone(evidence);
  changedImage.service.image_digest = `sha256:${'e'.repeat(64)}`;
  assert.throws(
    () => assertStableDeploymentEvidence(evidence, changedImage),
    /service image_digest changed during qualification/,
  );

  const changedClient = structuredClone(evidence);
  changedClient.client.built_at = '2026-08-03T01:00:00.000Z';
  assert.throws(
    () => assertStableDeploymentEvidence(evidence, changedClient),
    /client built_at changed during qualification/,
  );
});

test('refuses to issue a record for a failed run', () => {
  assert.throws(
    () => buildQualificationRecord({ ...input, result: 'failed' }, compatibility, evidence),
    /completed passing test run/,
  );
});

test('rejects a deployed revision that differs from the reviewed compatibility set', async () => {
  const fetcher = async (url) => {
    const body = url.pathname === '/build-metadata.json'
      ? { component: 'AnyWear-Client', source_commit: 'f'.repeat(40), built_at: evidence.client.built_at }
      : { status: 'ok', service_commit: compatibility.service.sha, image_digest: evidence.service.image_digest };
    return new Response(JSON.stringify(body), { status: 200 });
  };

  await assert.rejects(
    collectDeploymentEvidence({
      clientUrl: evidence.client.url,
      serviceUrl: evidence.service.url,
    }, compatibility, fetcher),
    /Client does not match compatibility.json/,
  );
});
