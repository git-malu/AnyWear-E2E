import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertStableDeploymentEvidence,
  buildQualificationRecord,
  collectDeploymentEvidence,
  verifyQualificationRecord,
} from './qualification-record.mjs';
import { ENVIRONMENT_VERDICT_PATH, environmentVerdict, qualificationRefusalMessage } from './beta-sizing-environment.mjs';
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

// The worker identity comparison behind each verdict. The comparison inputs are
// assembled here because this suite drives the verdict fields directly; the verdict
// record itself still comes from `environmentVerdict`, which owns its key set.
const workerComparison = (overrides = {}) => ({
  verdict: 'unchanged',
  reason: 'The worker task set and the worker task definition are unchanged across the suite window',
  before_observed_at: '2026-10-08T00:00:00.000Z',
  after_observed_at: '2026-10-08T00:10:00.000Z',
  before_identity_sha256: 'a'.repeat(64),
  after_identity_sha256: 'a'.repeat(64),
  before_task_arns: [],
  after_task_arns: [],
  added_task_arns: [],
  removed_task_arns: [],
  task_definition_changed: false,
  ...overrides,
});
const environmentFor = (comparison, suiteOutcome = 'success') =>
  ({ record: environmentVerdict({ comparison, suiteOutcome }), problem: null });

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
  const record = buildQualificationRecord(fixture.input, fixture.compatibility, fixture.evidence,
    new Date('2026-10-08T00:20:00.000Z'), fixture.environment);
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

test('refuses a passing suite measured across two worker task definitions', () => {
  const fixture = qualificationFixture();
  const environment = environmentFor(workerComparison({
    verdict: 'changed',
    reason: 'The worker task definition serving Beta changed during the suite',
    after_identity_sha256: 'b'.repeat(64),
    task_definition_changed: true,
  }));
  let refusal;
  try {
    buildQualificationRecord(fixture.input, fixture.compatibility, fixture.evidence,
      new Date('2026-10-08T00:20:00.000Z'), environment);
  } catch (error) { refusal = error; }
  assert.ok(refusal, 'a passing suite across two worker task definitions must not yield a record');
  assert.equal(refusal.message, qualificationRefusalMessage(environment.record));
  assert.equal(refusal.message, 'A passing suite measured across two worker task definitions cannot issue a '
    + `qualification record: ${environment.record.reason}. Worker tasks added: 0; removed: 0. `
    + 'Re-run the qualification on one stable worker task definition.');
  assert.doesNotMatch(refusal.message, /replaced/);
});

test('still qualifies a passing suite that only rotated worker task ARNs', () => {
  const fixture = qualificationFixture();
  const environment = environmentFor(workerComparison({
    verdict: 'changed',
    reason: 'The workers serving Beta were replaced during the suite: 1 worker task(s) disappeared and 1 worker task(s) appeared',
    after_identity_sha256: 'b'.repeat(64),
    added_task_arns: [`arn:aws:ecs:ap-east-1:650880818323:task/beta-anywear/${'b'.repeat(32)}`],
    removed_task_arns: [`arn:aws:ecs:ap-east-1:650880818323:task/beta-anywear/${'a'.repeat(32)}`],
  }));
  assert.equal(environment.record.verdict, 'environment-changed');
  assert.equal(environment.record.comparison.task_definition_changed, false);
  const record = buildQualificationRecord(fixture.input, fixture.compatibility, fixture.evidence,
    new Date('2026-10-08T00:20:00.000Z'), environment);
  assert.equal(record.qualification_id, 'beta-123-1');
  assert.equal(verifyQualificationRecord(record), true);
});

test('requires the environment verdict before it issues a record', () => {
  const fixture = qualificationFixture();
  const build = (environment) => buildQualificationRecord(fixture.input, fixture.compatibility, fixture.evidence,
    new Date('2026-10-08T00:20:00.000Z'), environment);
  for (const [name, environment] of [
    ['omitted', undefined],
    ['missing', { record: null, problem: `${ENVIRONMENT_VERDICT_PATH} is missing` }],
    ['malformed', { record: [], problem: null }],
  ]) {
    let refusal;
    try { build(environment); } catch (error) { refusal = error; }
    assert.ok(refusal, `${name} environment must refuse`);
    assert.match(refusal.message, /no qualification record is issued/);
    assert.ok(refusal.message.includes(ENVIRONMENT_VERDICT_PATH), `${name} must name the verdict path`);
  }
  assert.doesNotThrow(() => build(fixture.environment));
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
