import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildIdentitySet,
  buildReconcileRecord,
  cleanupGroups,
  cleanupRequest,
  judgeResult,
  manifestIdentities,
  normalizeAccountStatus,
  objectAction,
  orphanCreations,
  orphanRunScope,
  parseCreateUserEvents,
  parseManifestArtifactName,
  readManifest,
  reconcileAccounts,
  reconcileWindow,
  validateReconcileRecord,
  RECONCILE_MAX_USERS_PER_REQUEST,
  RECONCILE_RECORD_TYPE,
  RECONCILE_SCHEMA_VERSION,
  RECONCILE_WINDOW_DAYS,
} from './reconcile-accounts.mjs';
import { isCapturedBetaWorkerEmail } from '../tests/support/beta-address.ts';

const NOW = Date.parse('2026-10-23T00:00:00.000Z');
const DAY = 24 * 60 * 60_000;
const runIdentity = { runId: 900, attempt: 1 };
const stable = (slot = 0) => `e2e-beta-worker-${slot}-chromium@anywear.local`;
const scoped = (slot = 0, runScope = '123456789-1-0123456789abcdef') => `e2e-beta-${runScope}-${slot}-a1b2c3d4@anywear.local`;
const subject = (n = 1) => `10000000-0000-4000-8000-00000000000${n}`;
const qualificationRole = 'arn:aws:sts::650880818323:assumed-role/beta-e2e-qualification-role/awsexample';

function manifestRecord(overrides = {}) {
  return {
    email: stable(0),
    mode: 'worker',
    status: 'retained',
    createdAt: new Date(NOW - 2 * DAY).toISOString(),
    updatedAt: new Date(NOW - 2 * DAY + 60_000).toISOString(),
    retainedReason: 'teardown: business cleanup failed',
    reconcileBy: new Date(NOW - DAY).toISOString(),
    ...overrides,
  };
}

function manifestFixture(run, attempt, accounts, { createdAt = new Date(NOW - 2 * DAY).toISOString() } = {}) {
  return {
    artifact: { runId: run, attempt, smoke: false, createdAt },
    manifest: { version: 1, runScope: `${run}-${attempt}-0123456789abcdef`, config: { maxActiveAccounts: 2, maxNewAccountsPerRun: 6 }, accounts },
  };
}

function creation(email, { eventTime = new Date(NOW - 2 * DAY + 30_000).toISOString(), caller = qualificationRole, eventId = 'event-1', userPoolId } = {}) {
  return {
    EventId: eventId,
    EventTime: eventTime,
    CloudTrailEvent: JSON.stringify({
      eventName: 'AdminCreateUser',
      eventID: eventId,
      eventTime,
      userIdentity: { arn: caller },
      requestParameters: { username: email, ...(userPoolId ? { userPoolId } : {}) },
    }),
  };
}

function userNotFound() {
  return Object.assign(new Error('User does not exist.'), { name: 'UserNotFoundException' });
}

function committedResult(overrides = {}) {
  return { schema_version: 1, record_type: 'anywear_beta_cleanup_result', source: 'beta-tester-cleanup', transaction_committed: true, objects: 2, objectsMissing: 0, ...overrides };
}

function harness({ manifests, events = [], users = [], cleanup = async () => ({ proof_status: 'verified', committed_result: committedResult() }) }) {
  const directory = new Map(users.map((entry) => [entry.email, { username: `sub-${entry.sub.slice(0, 8)}`, sub: entry.sub }]));
  const calls = [];
  const artifacts = manifests.map((fixture, index) => ({
    id: index + 1,
    name: `beta-account-lifecycle-${fixture.artifact.runId}-${fixture.artifact.attempt}`,
    created_at: fixture.artifact.createdAt,
    digest: undefined,
  }));
  return {
    calls,
    directory,
    io: {
      async listArtifacts() { return artifacts; },
      async downloadManifest(artifact) {
        return Buffer.from(JSON.stringify(manifests[artifact.id - 1].manifest));
      },
      async lookupCreateUserEvents() { calls.push({ cloudtrail: true }); return events; },
      async getUser(email) {
        calls.push({ get: email });
        const entry = directory.get(email);
        if (!entry) throw userNotFound();
        return { Username: entry.username, UserAttributes: [{ Name: 'email', Value: email }, { Name: 'sub', Value: entry.sub }] };
      },
      async deleteUser(username) {
        calls.push({ delete: username });
        for (const [email, entry] of directory) if (entry.username === username) directory.delete(email);
      },
      async runServiceCleanup(inputs, environment) {
        calls.push({ service: inputs, environment });
        return cleanup(inputs, environment);
      },
    },
  };
}

test('the reconcile window is the reviewed seven-day span and the record refuses any other', () => {
  const window = reconcileWindow(NOW);
  assert.equal(window.to, '2026-10-23T00:00:00.000Z');
  assert.equal(window.from, '2026-10-16T00:00:00.000Z');
  assert.equal((Date.parse(window.to) - Date.parse(window.from)) / DAY, RECONCILE_WINDOW_DAYS);
  assert.throws(() => reconcileWindow(NOW, 0), /positive integer/);

  const record = buildReconcileRecord({
    reconcileId: '900-1', window, sources: { artifacts: 1, cloudtrail_events: 0 },
    identities: [], unresolved: [], result: 'passed',
  });
  assert.equal(record.record_type, RECONCILE_RECORD_TYPE);
  assert.equal(record.schema_version, RECONCILE_SCHEMA_VERSION);
  assert.throws(() => buildReconcileRecord({
    reconcileId: '900-1',
    window: { from: '2026-10-20T00:00:00.000Z', to: '2026-10-23T00:00:00.000Z' },
    sources: { artifacts: 1, cloudtrail_events: 0 }, identities: [], unresolved: [], result: 'passed',
  }), /reviewed lookback/);
});

test('the address grammar accepts the stable pool and the historical scoped family only', () => {
  assert.ok(isCapturedBetaWorkerEmail(stable(7)));
  assert.ok(isCapturedBetaWorkerEmail(scoped(3)));
  for (const foreign of [
    'e2e-beta-worker-8-chromium@anywear.local',
    'e2e-beta-worker-0-firefox@anywear.local',
    'e2e-functional-account@anywear.local',
    'tester@anywear.local',
    'e2e-beta-123456789-1-0123456789abcdef-0-A1B2C3D4@anywear.local',
    'e2e-beta-123456789-1-0123456789abcdef-8-a1b2c3d4@anywear.local',
  ]) {
    assert.equal(isCapturedBetaWorkerEmail(foreign), false, foreign);
  }
});

test('the lifecycle artifact name keeps the historical shape and rejects anything else', () => {
  assert.deepEqual(parseManifestArtifactName('beta-account-lifecycle-123-1'), { smoke: false, runId: 123, attempt: 1 });
  assert.deepEqual(parseManifestArtifactName('beta-smoke-account-lifecycle-123-2'), { smoke: true, runId: 123, attempt: 2 });
  for (const name of ['beta-account-lifecycle-0-1', 'beta-account-lifecycle-123', 'beta-account-reconcile-123-1', 'beta-account-lifecycle-123-1-extra']) {
    assert.equal(parseManifestArtifactName(name), undefined, name);
  }
});

test('a historical manifest reads its quarantined status as retained and keeps the reason', () => {
  assert.equal(normalizeAccountStatus('quarantined'), 'retained');
  assert.equal(normalizeAccountStatus('retained'), 'retained');
  assert.equal(normalizeAccountStatus('deleted'), 'deleted');
  assert.equal(normalizeAccountStatus('in_use'), 'in_use');
  assert.equal(normalizeAccountStatus('unknown'), undefined);

  const legacy = manifestFixture(123, 1, [{
    email: scoped(0, '123-1-0123456789abcdef'), mode: 'worker', status: 'quarantined', subject: subject(),
    createdAt: new Date(NOW - 3 * DAY).toISOString(), updatedAt: new Date(NOW - 3 * DAY + 60_000).toISOString(),
    reason: 'teardown: identity is still present',
  }]);
  const identities = manifestIdentities([legacy]);
  assert.equal(identities.length, 1);
  assert.equal(identities[0].status, 'retained');
  assert.equal(identities[0].retainedReason, 'teardown: identity is still present');
  // No stored bound on a historical record: the reviewed retention starts at its last write.
  assert.equal(identities[0].boundAt, Date.parse(new Date(NOW - 3 * DAY + 60_000).toISOString()) + DAY);
  assert.deepEqual(identities[0].origin, { kind: 'manifest', run: 123, attempt: 1 });
});

test('the latest manifest record for an address wins, and a deleted one removes it from the set', () => {
  const older = manifestFixture(123, 1, [manifestRecord({ status: 'retained', retainedReason: 'older' })]);
  const newer = manifestFixture(124, 1, [manifestRecord({ status: 'deleted', updatedAt: new Date(NOW - DAY).toISOString() })]);
  assert.deepEqual(manifestIdentities([older, newer]), []);

  const retainedAgain = manifestFixture(125, 1, [manifestRecord({
    status: 'retained', retainedReason: 'newer', updatedAt: new Date(NOW - 60_000).toISOString(),
  })]);
  const identities = manifestIdentities([older, newer, retainedAgain]);
  assert.equal(identities.length, 1);
  assert.equal(identities[0].retainedReason, 'newer');
  assert.deepEqual(identities[0].origin, { kind: 'manifest', run: 125, attempt: 1 });
});

test('a malformed manifest or an unknown account state refuses instead of guessing', () => {
  assert.throws(() => readManifest(Buffer.from('{"version":2,"runScope":"123-1-0123456789abcdef","accounts":[]}'), { runId: 1, attempt: 1 }), /bounded run scope/);
  assert.throws(() => readManifest(Buffer.from('not-json'), { runId: 1, attempt: 1 }));
  assert.throws(() => manifestIdentities([manifestFixture(123, 1, [manifestRecord({ status: 'exploded' })])]), /unknown account state/);
});

test('CloudTrail creations are attributed by caller and only inside the window and the pool grammar', () => {
  const window = reconcileWindow(NOW);
  const events = [
    creation(stable(0), { eventId: 'event-a' }),
    // A creation by a principal that is not the qualification role is reported, never deleted.
    creation(stable(1), { eventId: 'event-b', caller: 'arn:aws:sts::650880818323:assumed-role/some-other-role/session' }),
    // Not a Beta pool address: outside the grammar, ignored.
    creation('someone@example.com', { eventId: 'event-c' }),
    // Outside the window.
    creation(stable(2), { eventId: 'event-d', eventTime: new Date(NOW - 8 * DAY).toISOString() }),
    // Another user pool.
    creation(stable(3), { eventId: 'event-e', userPoolId: 'ap-east-1_other' }),
  ];
  const parsed = parseCreateUserEvents(events, window, { userPoolId: 'ap-east-1_beta' });
  assert.deepEqual(parsed.created.map((entry) => entry.eventId), ['event-a']);
  assert.deepEqual(parsed.unattributable.map((entry) => entry.eventId), ['event-b']);
  assert.equal(parsed.unattributable[0].caller, 'arn:aws:sts::650880818323:assumed-role/some-other-role/session');

  // A CLI that renders the timestamp as epoch seconds is normalized, not dropped.
  const epoch = parseCreateUserEvents([{ EventId: 'event-f', EventTime: (NOW - DAY) / 1000, CloudTrailEvent: JSON.stringify({
    eventName: 'AdminCreateUser', userIdentity: { arn: qualificationRole }, requestParameters: { username: stable(4) },
  }) }], window);
  assert.deepEqual(epoch.created.map((entry) => entry.eventTime), [new Date(NOW - DAY).toISOString()]);
  assert.throws(() => parseCreateUserEvents({}, window), /event array/);
});

test('a creation inside a manifest lifetime is attributed; one outside is an orphan, latest per address', () => {
  const { created } = parseCreateUserEvents([
    creation(stable(0), { eventId: 'attributed', eventTime: new Date(NOW - 2 * DAY + 30_000).toISOString() }),
    creation(stable(1), { eventId: 'orphan-early', eventTime: new Date(NOW - DAY).toISOString() }),
    creation(stable(1), { eventId: 'orphan-late', eventTime: new Date(NOW - 60_000).toISOString() }),
  ], reconcileWindow(NOW));
  // The attribution window of the one manifest record, with the reviewed clock skew.
  const attribution = new Map([[stable(0), [{
    from: Date.parse(new Date(NOW - 2 * DAY).toISOString()) - 5 * 60_000,
    to: Date.parse(new Date(NOW - 2 * DAY + 60_000).toISOString()) + 5 * 60_000,
  }]]]);
  const orphans = orphanCreations(created, attribution);
  // One entry per address: the address names a single Cognito identity, so the latest
  // creation is the one that has to be resolved.
  assert.deepEqual(orphans.map((entry) => entry.eventId), ['orphan-late']);
  assert.equal(orphans[0].email, stable(1));
});

test('an orphan without a manifest is attributable only through the scoped grammar', () => {
  assert.equal(orphanRunScope(scoped(2, '777-1-0123456789abcdef')), '777-1-0123456789abcdef');
  // A stable pool row carries no scope and no captured subject, so it has no ownership proof.
  assert.throws(() => orphanRunScope(stable(3)), /outside the scoped grammar/);
  assert.throws(() => orphanRunScope('someone@example.com'), /outside the scoped grammar/);
});

test('the identity set is manifests first, then scoped CloudTrail orphans, with unattributable creations reported', () => {
  const runScope = '123-1-0123456789abcdef';
  const fixture = manifestFixture(123, 1, [manifestRecord({ email: stable(0), subject: subject(1) })]);
  const { identities, unresolved } = buildIdentitySet({
    manifests: [fixture],
    events: [
      creation(scoped(1, runScope), { eventId: 'orphan', eventTime: new Date(NOW - DAY).toISOString() }),
      creation(stable(2), { eventId: 'foreign', caller: 'arn:aws:sts::650880818323:assumed-role/other/session' }),
    ],
    window: reconcileWindow(NOW),
  });
  assert.deepEqual(identities.map((identity) => identity.email).sort(), [stable(0), scoped(1, runScope)].sort());
  assert.equal(identities.find((identity) => identity.email === stable(0)).origin.kind, 'manifest');
  assert.equal(identities.find((identity) => identity.email === scoped(1, runScope)).origin.kind, 'cloudtrail');
  assert.deepEqual(unresolved.map((entry) => entry.reason), ['unattributable_caller']);
  assert.equal(unresolved[0].email, stable(2));
});

test('a stable allowlist row is reconciled only when the manifest captures its subject', () => {
  // Without a captured subject the eight shared allowlist rows prove nothing: a human tester
  // holds the same address, so the record is reported and never deleted (ADR-0031 §4).
  const withoutSubject = manifestFixture(123, 1, [manifestRecord({ email: stable(0), subject: undefined })]);
  const reported = buildIdentitySet({ manifests: [withoutSubject], events: [], window: reconcileWindow(NOW) });
  assert.deepEqual(reported.identities, []);
  assert.deepEqual(reported.unresolved.map((entry) => [entry.email, entry.reason]), [[stable(0), 'unprovable_ownership']]);

  const withSubject = manifestFixture(123, 1, [manifestRecord({ email: stable(0), subject: subject(1) })]);
  const reconciled = buildIdentitySet({ manifests: [withSubject], events: [], window: reconcileWindow(NOW) });
  assert.deepEqual(reconciled.identities.map((identity) => identity.email), [stable(0)]);
  assert.deepEqual(reconciled.unresolved, []);
});

test('a stable pool creation with no manifest entry is reported, never reconciled', () => {
  const empty = manifestFixture(123, 1, [manifestRecord({ email: stable(0), status: 'deleted' })]);
  const { identities, unresolved } = buildIdentitySet({
    manifests: [empty],
    events: [creation(stable(1), { eventId: 'stable-orphan', eventTime: new Date(NOW - DAY).toISOString() })],
    window: reconcileWindow(NOW),
  });
  assert.deepEqual(identities, []);
  assert.deepEqual(unresolved.map((entry) => [entry.email, entry.reason]), [[stable(1), 'unprovable_ownership']]);
  assert.equal(unresolved[0].origin.kind, 'cloudtrail');
});

test('a scoped manifest record without a captured subject stays reconcilable', () => {
  const runScope = '123-1-0123456789abcdef';
  const fixture = manifestFixture(123, 1, [manifestRecord({ email: scoped(0, runScope), subject: undefined })]);
  const { identities, unresolved } = buildIdentitySet({ manifests: [fixture], events: [], window: reconcileWindow(NOW) });
  assert.deepEqual(identities.map((identity) => identity.email), [scoped(0, runScope)]);
  assert.deepEqual(unresolved, []);
});

test('a non-worker or foreign manifest record is reported as unprovable ownership', () => {
  const fixture = manifestFixture(123, 1, [
    manifestRecord({ email: 'e2e-functional-account@anywear.local', mode: 'ephemeral' }),
  ]);
  const { identities, unresolved } = buildIdentitySet({ manifests: [fixture], events: [], window: reconcileWindow(NOW) });
  assert.deepEqual(identities, []);
  assert.deepEqual(unresolved.map((entry) => entry.reason), ['unprovable_ownership']);
});

test('cleanup groups keep one exact request per captured scope and admit at most eight users', () => {
  const identities = Array.from({ length: 10 }, (_, index) => ({
    email: scoped(index % 8, `123-1-0123456789abcdef`), runScope: '123-1-0123456789abcdef', boundAt: NOW + index,
  }));
  const groups = cleanupGroups(identities);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((group) => group.identities.length).sort((a, b) => a - b), [2, 8]);
  assert.equal(RECONCILE_MAX_USERS_PER_REQUEST, 8);
  assert.equal(cleanupRequest('123-1-0123456789abcdef', [{ sub: subject(), email: stable(0) }]),
    JSON.stringify({ runScope: '123-1-0123456789abcdef', users: [{ sub: subject(), email: stable(0) }] }));
  assert.throws(() => cleanupGroups([{ email: stable(0), runScope: 'not-a-scope', boundAt: NOW }]), /run scope is invalid/);
});

test('the object action is proven by the committed counters, never assumed', () => {
  assert.equal(objectAction(committedResult({ objects: 3, objectsMissing: 0 })), 'deleted');
  assert.equal(objectAction(committedResult({ objects: 0, objectsMissing: 4 })), 'absent');
  assert.equal(objectAction(committedResult({ objects: 0, objectsMissing: 0 })), 'none');
  assert.equal(objectAction(committedResult({ objects: undefined })), 'unavailable');
  assert.equal(objectAction(undefined), 'unavailable');
});

test('the run fails only for a leftover past its bound, and never for a foreign creation', () => {
  const bounds = new Map([[stable(0), NOW - 1], [stable(1), NOW + DAY]]);
  assert.equal(judgeResult([], NOW, bounds), 'passed');
  assert.equal(judgeResult([{ email: stable(0), reason: 'service_cleanup_refused' }], NOW, bounds), 'failed');
  assert.equal(judgeResult([{ email: stable(0), reason: 'deadline_exceeded' }], NOW, bounds), 'failed');
  assert.equal(judgeResult([{ email: stable(1), reason: 'service_cleanup_refused' }], NOW, bounds), 'passed');
  assert.equal(judgeResult([{ email: stable(1), reason: 'unattributable_caller' }], NOW, bounds), 'passed');
  assert.equal(judgeResult([{ email: stable(1), reason: 'unprovable_ownership' }], NOW, bounds), 'passed');
  assert.equal(judgeResult([{ email: stable(9), reason: 'service_cleanup_refused' }], NOW, bounds), 'failed', 'an entry with no bound fails closed');
});

test('the record is a closed contract: unknown members, actions and origins are refused', () => {
  const window = reconcileWindow(NOW);
  const identity = {
    email: stable(0), subject: subject(), origin: { kind: 'manifest', run: 123, attempt: 1 },
    actions: { service_cleanup: 'committed', cognito: 'deleted', objects: 'deleted', readback: 'absent' },
    outcome: 'reconciled',
  };
  const base = { reconcileId: '900-1', window, sources: { artifacts: 1, cloudtrail_events: 0 }, identities: [identity], unresolved: [], result: 'passed' };
  const record = buildReconcileRecord(base);
  assert.equal(validateReconcileRecord(record), record);

  assert.throws(() => validateReconcileRecord({ ...record, extra: 1 }), /unknown or missing member/);
  assert.throws(() => validateReconcileRecord({ ...record, identities: [{ ...identity, actions: { ...identity.actions, objects: 'assumed' } }] }), /outside the closed set/);
  assert.throws(() => validateReconcileRecord({ ...record, identities: [{ ...identity, outcome: 'quarantined' }] }), /outside the closed set/);
  assert.throws(() => validateReconcileRecord({ ...record, identities: [{ ...identity, origin: { kind: 'console' } }] }), /not manifest or cloudtrail/);
  assert.throws(() => validateReconcileRecord({ ...record, result: 'failed' }), /failed with no unresolved identity/);
  assert.throws(() => validateReconcileRecord({ ...record, unresolved: [{ email: stable(0), reason: 'made_up', origin: identity.origin }] }), /closed set/);
  assert.throws(() => validateReconcileRecord({ ...record, identities: [identity, identity] }), /duplicated/);
});

test('a retained manifest identity is reconciled through the exact cleanup, delete and absence read-back', async () => {
  const fixture = manifestFixture(123, 1, [manifestRecord({ email: stable(0), subject: subject(1) })]);
  const harnessed = harness({ manifests: [fixture], users: [{ email: stable(0), sub: subject(1) }] });
  const { record, result } = await reconcileAccounts({
    io: harnessed.io, now: NOW, runIdentity, window: reconcileWindow(NOW), environment: {},
  });
  assert.equal(result, 'passed');
  assert.equal(record.identities.length, 1);
  assert.deepEqual(record.identities[0], {
    email: stable(0), subject: subject(1), origin: { kind: 'manifest', run: 123, attempt: 1 },
    actions: { service_cleanup: 'committed', cognito: 'deleted', objects: 'deleted', readback: 'absent' },
    outcome: 'reconciled',
  });
  assert.deepEqual(record.unresolved, []);
  assert.deepEqual(record.sources, { artifacts: 1, cloudtrail_events: 0 });
  // The Service request is the exact captured scope and subject, normal mode.
  const serviceCall = harnessed.calls.find((call) => call.service);
  assert.deepEqual(JSON.parse(serviceCall.service.cleanup_json), {
    runScope: '123-1-0123456789abcdef', users: [{ sub: subject(1), email: stable(0) }],
  });
  assert.equal(serviceCall.environment.operation_mode, undefined);
  // Delete used the immutable username the ownership read returned, never the address.
  assert.deepEqual(harnessed.calls.filter((call) => call.delete), [{ delete: `sub-${subject(1).slice(0, 8)}` }]);
});

test('a scoped CloudTrail orphan whose manifest was never uploaded is reconciled from its own creation', async () => {
  const runScope = '321-1-0123456789abcdef';
  const orphan = scoped(1, runScope);
  const empty = manifestFixture(123, 1, [manifestRecord({ email: stable(0), status: 'deleted' })]);
  const harnessed = harness({
    manifests: [empty],
    events: [creation(orphan, { eventId: 'orphan-event', eventTime: new Date(NOW - DAY).toISOString() })],
    users: [{ email: orphan, sub: subject(2) }],
  });
  const { record } = await reconcileAccounts({ io: harnessed.io, now: NOW, runIdentity, window: reconcileWindow(NOW), environment: {} });
  assert.equal(record.identities.length, 1);
  assert.deepEqual(record.identities[0].origin, { kind: 'cloudtrail', event_id: 'orphan-event', event_time: new Date(NOW - DAY).toISOString() });
  assert.equal(record.identities[0].subject, subject(2), 'the orphan sub is read back from Cognito');
  assert.equal(record.identities[0].outcome, 'reconciled');
  assert.equal(record.sources.cloudtrail_events, 1);
  // The scoped address carries its own run scope, so the exact request is still provable.
  const serviceCall = harnessed.calls.find((call) => call.service);
  assert.deepEqual(JSON.parse(serviceCall.service.cleanup_json), { runScope, users: [{ sub: subject(2), email: orphan }] });
});

test('a stable pool creation with no manifest entry is reported and never deleted', async () => {
  const harnessed = harness({
    manifests: [manifestFixture(123, 1, [manifestRecord({ email: stable(0), status: 'deleted' })])],
    events: [creation(stable(1), { eventId: 'stable-orphan', eventTime: new Date(NOW - DAY).toISOString() })],
    users: [{ email: stable(1), sub: subject(3) }],
  });
  const { record } = await reconcileAccounts({ io: harnessed.io, now: NOW, runIdentity, window: reconcileWindow(NOW), environment: {} });
  assert.deepEqual(record.identities, []);
  assert.deepEqual(record.unresolved.map((entry) => [entry.email, entry.reason]), [[stable(1), 'unprovable_ownership']]);
  assert.equal(harnessed.calls.some((call) => call.delete), false);
  assert.equal(harnessed.calls.some((call) => call.service), false);
});

test('a creation by another role is reported and never deleted', async () => {
  const harnessed = harness({
    manifests: [manifestFixture(123, 1, [manifestRecord({ email: stable(0), status: 'deleted' })])],
    events: [creation(stable(2), { eventId: 'foreign', caller: 'arn:aws:sts::650880818323:assumed-role/other/session' })],
    users: [{ email: stable(2), sub: subject(3) }],
  });
  const { record } = await reconcileAccounts({ io: harnessed.io, now: NOW, runIdentity, window: reconcileWindow(NOW), environment: {} });
  assert.equal(record.identities.length, 0);
  assert.deepEqual(record.unresolved.map((entry) => [entry.reason, entry.caller]), [['unattributable_caller', 'arn:aws:sts::650880818323:assumed-role/other/session']]);
  assert.equal(harnessed.calls.some((call) => call.delete), false);
  assert.equal(harnessed.calls.some((call) => call.service), false);
});

test('an identity already absent with no captured subject is already absent, without a cleanup request', async () => {
  const orphan = scoped(1, '321-1-0123456789abcdef');
  const harnessed = harness({
    manifests: [manifestFixture(123, 1, [manifestRecord({ email: stable(0), status: 'deleted' })])],
    events: [creation(orphan, { eventId: 'gone', eventTime: new Date(NOW - DAY).toISOString() })],
    users: [],
  });
  const { record } = await reconcileAccounts({ io: harnessed.io, now: NOW, runIdentity, window: reconcileWindow(NOW), environment: {} });
  assert.deepEqual(record.identities.map((identity) => [identity.outcome, identity.actions.cognito, identity.actions.service_cleanup]), [['already_absent', 'already_absent', 'not_required']]);
  assert.equal(harnessed.calls.some((call) => call.service), false);
});

test('an absent identity with a captured subject still replays the cleanup that owes rows and objects', async () => {
  const fixture = manifestFixture(123, 1, [manifestRecord({ email: stable(0), subject: subject(1) })]);
  const harnessed = harness({ manifests: [fixture], users: [] });
  const { record } = await reconcileAccounts({ io: harnessed.io, now: NOW, runIdentity, window: reconcileWindow(NOW), environment: {} });
  assert.equal(harnessed.calls.filter((call) => call.service).length, 1);
  assert.deepEqual(record.identities[0].actions, { service_cleanup: 'committed', cognito: 'already_absent', objects: 'deleted', readback: 'absent' });
  assert.equal(record.identities[0].outcome, 'already_absent');
});

test('a refused Service cleanup retains the identity, and a past-bound refusal fails the run', async () => {
  const fixture = manifestFixture(123, 1, [manifestRecord({
    email: stable(0), subject: subject(1), reconcileBy: new Date(NOW + DAY).toISOString(),
  })]);
  const withinBound = harness({
    manifests: [fixture], users: [{ email: stable(0), sub: subject(1) }],
    cleanup: async () => { throw new Error('service cleanup refused'); },
  });
  const passed = await reconcileAccounts({ io: withinBound.io, now: NOW, runIdentity, window: reconcileWindow(NOW), environment: {} });
  assert.equal(passed.record.result, 'passed', 'a retry inside the bound is the ordinary path');
  assert.deepEqual(passed.record.unresolved.map((entry) => entry.reason), ['service_cleanup_refused']);
  assert.deepEqual(passed.record.identities[0].actions, { service_cleanup: 'refused', cognito: 'not_attempted', objects: 'unavailable', readback: 'not_attempted' });

  const pastBound = harness({
    manifests: [manifestFixture(200, 1, [manifestRecord({
      email: stable(0), subject: subject(1), updatedAt: new Date(NOW - 3 * DAY).toISOString(), reconcileBy: new Date(NOW - 2 * DAY).toISOString(),
    })])],
    users: [{ email: stable(0), sub: subject(1) }],
    cleanup: async () => { throw new Error('service cleanup refused'); },
  });
  const failed = await reconcileAccounts({ io: pastBound.io, now: NOW, runIdentity, window: reconcileWindow(NOW), environment: {} });
  assert.equal(failed.record.result, 'failed');
});

test('a committed result without object counters proves nothing and retains the identity', async () => {
  const fixture = manifestFixture(123, 1, [manifestRecord({ email: stable(0), subject: subject(1) })]);
  const harnessed = harness({
    manifests: [fixture], users: [{ email: stable(0), sub: subject(1) }],
    cleanup: async () => ({ proof_status: 'verified', committed_result: committedResult({ objects: undefined, objectsMissing: undefined }) }),
  });
  const { record } = await reconcileAccounts({ io: harnessed.io, now: NOW, runIdentity, window: reconcileWindow(NOW), environment: {} });
  assert.deepEqual(record.unresolved.map((entry) => entry.reason), ['object_cleanup_unproven']);
  assert.equal(record.identities[0].actions.objects, 'unavailable');
  assert.equal(record.identities[0].actions.cognito, 'not_attempted');
  assert.equal(harnessed.calls.some((call) => call.delete), false);
});

test('a subject mismatch refuses the identity instead of deleting a foreign one', async () => {
  const fixture = manifestFixture(123, 1, [manifestRecord({ email: stable(0), subject: subject(1) })]);
  const harnessed = harness({ manifests: [fixture], users: [{ email: stable(0), sub: subject(9) }] });
  const { record } = await reconcileAccounts({ io: harnessed.io, now: NOW, runIdentity, window: reconcileWindow(NOW), environment: {} });
  assert.deepEqual(record.unresolved.map((entry) => entry.reason), ['subject_mismatch']);
  assert.equal(harnessed.calls.some((call) => call.delete), false);
  assert.equal(harnessed.calls.some((call) => call.service), false);
});

test('a deadline that has already passed records the leftover and starts no cleanup', async () => {
  const fixture = manifestFixture(123, 1, [manifestRecord({ email: stable(0), subject: subject(1) })]);
  const harnessed = harness({ manifests: [fixture], users: [{ email: stable(0), sub: subject(1) }] });
  const { record } = await reconcileAccounts({
    io: harnessed.io, now: NOW, runIdentity, window: reconcileWindow(NOW), environment: {}, deadlineMs: -1_000,
  });
  assert.deepEqual(record.unresolved.map((entry) => entry.reason), ['deadline_exceeded']);
  assert.equal(harnessed.calls.some((call) => call.service), false);
  assert.equal(harnessed.calls.some((call) => call.delete), false);
});

test('an unavailable source fails closed before any deletion', async () => {
  const fixture = manifestFixture(123, 1, [manifestRecord({ email: stable(0), subject: subject(1) })]);
  const withUsers = harness({ manifests: [fixture], users: [{ email: stable(0), sub: subject(1) }] });
  await assert.rejects(reconcileAccounts({ io: { ...withUsers.io, listArtifacts: async () => [] }, now: NOW, runIdentity }), /No lifecycle artifact/);
  await assert.rejects(reconcileAccounts({
    io: { ...withUsers.io, lookupCreateUserEvents: async () => { throw new Error('CloudTrail unavailable'); } },
    now: NOW, runIdentity, window: reconcileWindow(NOW), environment: {},
  }), /CloudTrail unavailable/);
  assert.equal(withUsers.calls.some((call) => call.delete), false);
});
