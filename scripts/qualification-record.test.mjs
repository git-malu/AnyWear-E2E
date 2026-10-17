import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertStableDeploymentEvidence,
  buildQualificationRecord,
  collectDeploymentEvidence,
  verifyQualificationAgainstReport,
  verifyQualificationRecord,
} from './qualification-record.mjs';
import { ENVIRONMENT_VERDICT_PATH, environmentVerdict, qualificationRefusalMessage } from './beta-sizing-environment.mjs';
import { byteHash, payloadDigest } from './evidence-contract.mjs';
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
    new Date('2026-10-08T00:20:00.000Z'), fixture.environment, fixture.report);
  assert.equal(record.qualification_id, 'beta-123-1');
  assert.deepEqual(record.test.scenarios, [
    { file: 'tests/auth-startup.spec.ts', outcome: 'passed', collected: 1, skipped: 0 },
    { file: 'tests/auth.spec.ts', outcome: 'skipped', collected: 1, skipped: 1 },
    { file: 'tests/wardrobe.spec.ts', outcome: 'passed', collected: 1, skipped: 0 },
    { file: 'tests/worker-smoke.spec.ts', outcome: 'passed', collected: 1, skipped: 0 },
  ]);
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
      new Date('2026-10-08T00:20:00.000Z'), environment, fixture.report);
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
    new Date('2026-10-08T00:20:00.000Z'), environment, fixture.report);
  assert.equal(record.qualification_id, 'beta-123-1');
  assert.equal(verifyQualificationRecord(record), true);
});

test('requires the environment verdict before it issues a record', () => {
  const fixture = qualificationFixture();
  const build = (environment) => buildQualificationRecord(fixture.input, fixture.compatibility, fixture.evidence,
    new Date('2026-10-08T00:20:00.000Z'), environment, fixture.report);
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

// Re-digesting a hand-edited record proves only that whoever wrote it knew the algorithm.
// Every case below edits a field and recomputes `integrity.payload_sha256`, so the record
// passes its checksum and has to be refused by the verifier's own derivation instead.
function redigest(record) {
  const { integrity: ignored, ...payload } = record;
  void ignored;
  return { ...payload, integrity: { algorithm: 'sha256', payload_sha256: payloadDigest(payload) } };
}

const issuedRecord = () => {
  const fixture = qualificationFixture();
  return {
    fixture,
    record: buildQualificationRecord(fixture.input, fixture.compatibility, fixture.evidence,
      new Date('2026-10-08T00:20:00.000Z'), fixture.environment, fixture.report),
  };
};

test('refuses a record whose stated selection differs from the one the repository declares', () => {
  const { record } = issuedRecord();
  for (const [label, mutate] of [
    ['tag', (test) => { test.selection.tag = '@full-stack'; }],
    ['invocation', (test) => { test.selection.invocation = 'test:smoke'; }],
  ]) {
    const tampered = structuredClone(record);
    mutate(tampered.test);
    assert.throws(() => verifyQualificationRecord(redigest(tampered)), /Qualification selection mismatch/, label);
  }
  // The stated tag is also what the scenario list is judged against, so a tag moved to one
  // that selects more scenarios cannot be hidden behind matching invocation and counts.
  const widened = structuredClone(record);
  widened.test.selection = { invocation: 'test:full-stack', tag: '@full-stack' };
  assert.throws(() => verifyQualificationRecord(redigest(widened)), /Qualification selection mismatch/);
});

test('refuses a record that omits a collected but skipped scenario', () => {
  const { record } = issuedRecord();
  const skipped = record.test.scenarios.find(({ file }) => file === 'tests/auth.spec.ts');
  assert.deepEqual(skipped, { file: 'tests/auth.spec.ts', outcome: 'skipped', collected: 1, skipped: 1 });
  const tampered = structuredClone(record);
  tampered.test.scenarios = tampered.test.scenarios.filter(({ file }) => file !== 'tests/auth.spec.ts');
  assert.throws(() => verifyQualificationRecord(redigest(tampered)), /omits tests\/auth\.spec\.ts/);
});

test('refuses the retired constant suite shape instead of accepting two vocabularies', () => {
  const { record } = issuedRecord();
  const tampered = structuredClone(record);
  tampered.test = { runner: 'playwright', suite: 'complete', result: 'passed' };
  assert.throws(() => verifyQualificationRecord(redigest(tampered)), /test result\.selection is required/);
});

test('requires the run report before it can state what it measured', () => {
  const fixture = qualificationFixture();
  for (const [name, report] of [['omitted', undefined], ['null', null]]) {
    let refusal;
    try {
      buildQualificationRecord(fixture.input, fixture.compatibility, fixture.evidence,
        new Date('2026-10-08T00:20:00.000Z'), fixture.environment, report);
    } catch (error) { refusal = error; }
    assert.ok(refusal, `${name} report must refuse`);
    assert.match(refusal.message, /qualification-report\.json/);
    assert.ok(refusal.message.includes('E2E_QUALIFICATION_REPORT'), `${name} must name the variable that declares the path`);
  }
});

test('verifies the record against the report the suite wrote and refuses another run report', () => {
  const { fixture, record } = issuedRecord();
  assert.equal(verifyQualificationAgainstReport(record, fixture.report), true);

  // A report from a narrower selection: one declared member never ran, and its digest is
  // not the one the record states.
  const report = JSON.parse(fixture.report.toString('utf8'));
  report.suites = report.suites.slice(1);
  const narrower = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
  assert.throws(() => verifyQualificationAgainstReport(record, narrower), /checksums differ/);

  // Even a record that adopts the other report's digest has to state that report's
  // scenarios, so the digest cannot be moved without the scenario list moving with it.
  const retargeted = { ...record, test: { ...record.test, report_sha256: byteHash(narrower) } };
  assert.throws(() => verifyQualificationAgainstReport(retargeted, narrower),
    /Qualification scenarios and the Playwright report mismatch/);

  assert.throws(() => verifyQualificationAgainstReport(record), /qualification-report\.json/);
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
