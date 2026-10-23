import { execFile, execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  AdminDeleteUserCommand,
  AdminGetUserCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { ghApi } from './github-read.mjs';
import { assertE2EExecution } from './execution-guard.mjs';
import { byteHash, parseStrictJson, repositories } from './evidence-contract.mjs';
import { runCleanupOperation } from '../tests/support/service-cleanup-operation.ts';
import { isCapturedBetaWorkerEmail, STABLE_WORKER_EMAIL_PATTERN } from '../tests/support/beta-address.ts';

// #217: the reconciler that replaces the manual `recover` exit.
//
// Every identity a protected `qualify` run creates is attributable to that run: its
// `e2e-beta-*` address is never reused by a different attempt, and the run's
// `beta-account-lifecycle-<run>-<attempt>` artifact records the address and its captured
// subject. A teardown that cannot prove deletion records the identity `retained`; this
// operation finds it again, replays the same exact-reference Service cleanup, deletes the
// Cognito identity by its immutable username, reads absence back, and records the outcome
// against the original run. It runs before every `qualify` suite and daily through the
// scheduled dispatch of the same protected `workflow_dispatch` entry.
//
// Two sources, one identity set:
//   - the manifests of the previous seven days are authoritative for their address and
//     subject;
//   - CloudTrail `AdminCreateUser` events over the same window find a creation whose
//     manifest was never uploaded, and prove the caller is the E2E qualification role.
//     Such an orphan's grammar proves it synthetic and its `sub` is read back.
//
// The record is `anywear_e2e_account_reconcile` v1. It is the audit trail; the artifacts
// it was built from expire, the record does not.
//
// Nothing here lists Cognito users or deletes by prefix: an identity is only ever touched
// when a manifest names it or CloudTrail proves its creation, and the Service cleanup
// receives the exact captured `{runScope, users}` request.

export const RECONCILE_RECORD_TYPE = 'anywear_e2e_account_reconcile';
export const RECONCILE_SCHEMA_VERSION = 1;
export const RECONCILE_WINDOW_DAYS = 7;
export const RECONCILE_RETENTION_HOURS = 24;
export const RECONCILE_MAX_ARTIFACTS = 60;
export const RECONCILE_MAX_EVENTS = 1000;
export const RECONCILE_MAX_USERS_PER_REQUEST = 8;
export const RECONCILE_JOB_MINUTES = 15;
export const DEFAULT_RECONCILE_DEADLINE_SECONDS = 720;
export const E2E_QUALIFICATION_CALLER = /^arn:aws:sts::650880818323:assumed-role\/beta-e2e-qualification-role\/[A-Za-z0-9+=,.@_-]{1,64}$/;
export const E2E_QUALIFICATION_ROLE = /^arn:aws:iam::650880818323:role\/beta-e2e-qualification-role$/;
export const RECONCILE_RUN_SCOPE = /^[1-9][0-9]{0,19}-[1-9][0-9]{0,5}-[a-f0-9]{16}$/;
export const CAPTURED_SUBJECT = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const ACCOUNT_STATUSES = Object.freeze([
  'reserved', 'provisioning', 'in_use', 'cleanup_pending', 'deleted', 'retained',
]);
export const CLEANUP_ACTION = Object.freeze(['committed', 'refused', 'unavailable', 'not_required']);
export const COGNITO_ACTION = Object.freeze(['deleted', 'already_absent', 'refused', 'not_attempted']);
export const OBJECT_ACTION = Object.freeze(['deleted', 'absent', 'none', 'unavailable', 'not_required']);
export const READBACK_ACTION = Object.freeze(['absent', 'present', 'unreadable', 'not_attempted']);
export const IDENTITY_OUTCOMES = Object.freeze(['reconciled', 'already_absent', 'retained']);
export const UNRESOLVED_REASONS = Object.freeze([
  'cognito_delete_refused',
  'cognito_readback_failed',
  'deadline_exceeded',
  'object_cleanup_unproven',
  'service_cleanup_refused',
  'service_cleanup_unavailable',
  'subject_mismatch',
  'unattributable_caller',
  'unprovable_ownership',
]);

const execute = promisify(execFile);
const SKEW_MS = 5 * 60_000;
const ARTIFACT_NAME = /^(beta-account-lifecycle|beta-smoke-account-lifecycle)-([1-9][0-9]*)-([1-9][0-9]*)$/;
const ISO_INSTANT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?Z$/;
const WORKER_SCOPE = /^e2e-beta-([1-9][0-9]{0,19}-[1-9][0-9]{0,5}-[a-f0-9]{16})-[0-7]-[a-f0-9]{8}@anywear\.local$/;

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is required`);
  return value;
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}

/** A normalized ISO-8601 UTC instant. CloudTrail may hand back a number or a string. */
function instant(value, label) {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value * 1000).toISOString();
  if (typeof value === 'string' && ISO_INSTANT.test(value) && Number.isFinite(Date.parse(value))) return new Date(Date.parse(value)).toISOString();
  throw new Error(`${label} must be an ISO-8601 UTC instant`);
}

/**
 * The record window. Both sources are read over exactly this span, so the record can be
 * re-read against the artifacts and the CloudTrail history it names.
 */
export function reconcileWindow(now = Date.now(), days = RECONCILE_WINDOW_DAYS) {
  requirePositiveInteger(days, 'Reconcile lookback');
  const to = new Date(now);
  const from = new Date(to.getTime() - days * 24 * 60 * 60_000);
  return { from: from.toISOString(), to: to.toISOString() };
}

/** The bound an identity must be resolved inside. */
export function reconcileBound(from, hours = RECONCILE_RETENTION_HOURS) {
  requirePositiveInteger(hours, 'Reconcile retention');
  const at = Date.parse(instant(from, 'Reconcile bound start'));
  return new Date(at + hours * 60 * 60_000).toISOString();
}

/**
 * Parse one lifecycle artifact name. The manifest artifact name is unchanged from before
 * #217, so historical records stay readable.
 */
export function parseManifestArtifactName(name) {
  if (typeof name !== 'string') return undefined;
  const match = ARTIFACT_NAME.exec(name);
  if (!match) return undefined;
  return { smoke: match[1] === 'beta-smoke-account-lifecycle', runId: Number(match[2]), attempt: Number(match[3]) };
}

/**
 * The one compatibility read the new model keeps: a manifest written before #217 records
 * `quarantined`, which is the state this design replaced. It is read as `retained` and its
 * original reason is preserved, so a historical leftover resolves through the same path
 * and no operator has to translate it.
 */
export function normalizeAccountStatus(status) {
  if (status === 'quarantined') return 'retained';
  if (typeof status !== 'string' || !ACCOUNT_STATUSES.includes(status)) return undefined;
  return status;
}

/** One manifest, validated in the manifest's own terms. */
export function readManifest(bytes, artifact) {
  const manifest = parseStrictJson(bytes);
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('Account manifest must be an object');
  if (manifest.version !== 1 || !RECONCILE_RUN_SCOPE.test(manifest.runScope ?? '')
    || !Array.isArray(manifest.accounts) || manifest.accounts.length > 50) {
    throw new Error('Account manifest does not describe one bounded run scope');
  }
  return { manifest, artifact };
}

/**
 * The identity set the manifests contribute.
 *
 * Every non-`deleted` worker record is a leftover: `reserved`, `provisioning`, `in_use` and
 * `cleanup_pending` mean the teardown never proved absence, and `retained` (or a legacy
 * `quarantined`) means it ran and failed. A stable pool address is reused by later runs, so
 * the latest record for an address wins: a later `deleted` record proves the address was
 * resolved after the older record was written, and re-reconciling the older one would
 * touch an identity another attempt owns.
 */
export function manifestIdentities(manifests) {
  const latest = new Map();
  for (const { manifest, artifact } of manifests) {
    for (const account of manifest.accounts) {
      if (!account || typeof account !== 'object' || Array.isArray(account)) throw new Error('Account manifest record is malformed');
      const email = requireString(account.email, 'Account manifest address');
      const createdAt = instant(account.createdAt ?? account.updatedAt, 'Account manifest creation time');
      const updatedAt = instant(account.updatedAt ?? account.createdAt, 'Account manifest transition time');
      const status = normalizeAccountStatus(account.status);
      if (!status) throw new Error(`Account manifest records an unknown account state: ${email}`);
      const record = {
        email,
        mode: account.mode,
        status,
        createdAt,
        updatedAt,
        subject: typeof account.subject === 'string' && CAPTURED_SUBJECT.test(account.subject) ? account.subject.toLowerCase() : undefined,
        // `retainedReason` is the #217 field; `reason` is what every historical manifest
        // wrote for a quarantined record. Both are bounded prose and neither selects a
        // deletion, so the older name is read rather than invented.
        retainedReason: typeof account.retainedReason === 'string' ? account.retainedReason
          : typeof account.reason === 'string' ? account.reason : undefined,
        reconcileBy: typeof account.reconcileBy === 'string' && Number.isFinite(Date.parse(account.reconcileBy))
          ? instant(account.reconcileBy, 'Account manifest reconcile bound') : undefined,
        origin: { kind: 'manifest', run: requirePositiveInteger(artifact.runId, 'Manifest run'), attempt: requirePositiveInteger(artifact.attempt, 'Manifest attempt') },
        runScope: manifest.runScope,
      };
      const previous = latest.get(email);
      if (!previous || Date.parse(record.updatedAt) >= Date.parse(previous.updatedAt)) latest.set(email, record);
    }
  }
  return [...latest.values()]
    .filter((record) => record.status !== 'deleted')
    .map((record) => ({ ...record, boundAt: Date.parse(record.reconcileBy ?? reconcileBound(record.updatedAt)) }))
    .sort((left, right) => left.boundAt - right.boundAt || left.email.localeCompare(right.email));
}

/** Every manifest record for an address, for CloudTrail attribution. */
export function manifestAttributionWindows(manifests) {
  const windows = new Map();
  for (const { manifest, artifact } of manifests) {
    for (const account of manifest.accounts) {
      if (!account || typeof account !== 'object' || Array.isArray(account)) continue;
      const email = typeof account.email === 'string' ? account.email : undefined;
      const createdAt = Date.parse(account.createdAt ?? '');
      const updatedAt = Date.parse(account.updatedAt ?? account.createdAt ?? '');
      if (!email || !Number.isFinite(createdAt) || !Number.isFinite(updatedAt)) continue;
      if (!windows.has(email)) windows.set(email, []);
      windows.get(email).push({ from: createdAt - SKEW_MS, to: updatedAt + SKEW_MS, run: artifact.runId, attempt: artifact.attempt });
    }
  }
  return windows;
}

function callerOf(event) {
  const identity = event.userIdentity;
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) return undefined;
  if (typeof identity.arn === 'string') return identity.arn;
  const issuer = identity.sessionContext?.sessionIssuer?.arn;
  return typeof issuer === 'string' ? issuer : undefined;
}

function createdUsername(event) {
  const parameters = event.requestParameters;
  if (parameters && typeof parameters === 'object' && !Array.isArray(parameters)) {
    if (typeof parameters.username === 'string' && parameters.username.length > 0) return parameters.username;
    if (typeof parameters.userName === 'string' && parameters.userName.length > 0) return parameters.userName;
  }
  if (Array.isArray(event.Resources)) {
    for (const resource of event.Resources) {
      if (resource && typeof resource.ResourceName === 'string' && resource.ResourceType === 'AWS::Cognito::UserPoolUser') return resource.ResourceName;
    }
  }
  return undefined;
}

/**
 * Read the `AdminCreateUser` history into creation facts.
 *
 * A creation is attributable when its caller assumed the E2E qualification role. Any other
 * caller is reported and never deleted: the design forbids a broad Identity sweep, and the
 * reconciler has no ownership proof for a principal that is not the qualification role. A
 * creation for another user pool is ignored rather than attributed.
 */
export function parseCreateUserEvents(events, window, { userPoolId } = {}) {
  if (!Array.isArray(events)) throw new Error('CloudTrail response must be an event array');
  if (events.length > RECONCILE_MAX_EVENTS) throw new Error('CloudTrail read exceeds its bound');
  const created = [];
  const unattributable = [];
  for (const entry of events) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('CloudTrail event is malformed');
    let detail;
    try { detail = JSON.parse(String(entry.CloudTrailEvent)); } catch { throw new Error('CloudTrail event detail is not JSON'); }
    if (!detail || typeof detail !== 'object' || Array.isArray(detail)) throw new Error('CloudTrail event detail is malformed');
    if (detail.eventName !== undefined && detail.eventName !== 'AdminCreateUser') continue;
    if (typeof detail.errorCode === 'string' && detail.errorCode.length > 0) continue;
    const email = createdUsername(detail);
    if (!email || !isCapturedBetaWorkerEmail(email)) continue;
    const parameters = detail.requestParameters;
    if (userPoolId && parameters && typeof parameters === 'object' && typeof parameters.userPoolId === 'string'
      && parameters.userPoolId !== userPoolId) continue;
    const eventTime = instant(entry.EventTime ?? detail.eventTime, 'CloudTrail event time');
    if (Date.parse(eventTime) < Date.parse(window.from) || Date.parse(eventTime) > Date.parse(window.to)) continue;
    const caller = callerOf(detail);
    const eventId = requireString(entry.EventId ?? detail.eventID, 'CloudTrail event id');
    if (!caller || (!E2E_QUALIFICATION_CALLER.test(caller) && !E2E_QUALIFICATION_ROLE.test(caller))) {
      unattributable.push({ email, caller: caller ?? 'unknown', eventId, eventTime });
      continue;
    }
    created.push({ email, eventId, eventTime, caller });
  }
  return { created, unattributable };
}

/**
 * Diff the creations against the manifest windows. A creation inside a manifest record's own
 * lifetime belongs to that record; one outside every window has no manifest entry and is
 * the orphan the design reconciles. Multiple creations of one address collapse to the
 * latest, because the address names a single Cognito identity and deletion is idempotent.
 */
export function orphanCreations(created, windows) {
  const byAddress = new Map();
  for (const creation of created) {
    const at = Date.parse(creation.eventTime);
    const attributed = (windows.get(creation.email) ?? []).some((span) => at >= span.from && at <= span.to);
    if (attributed) continue;
    const previous = byAddress.get(creation.email);
    if (!previous || Date.parse(creation.eventTime) > Date.parse(previous.eventTime)) byAddress.set(creation.email, creation);
  }
  return [...byAddress.values()];
}

/**
 * The run scope of a creation no manifest names.
 *
 * Only an address in the scoped historical grammar can be reconciled without a manifest: the
 * grammar embeds the run scope, so the exact request is still provable. A stable pool row does
 * not carry one, which is one of the two reasons it needs the captured subject instead (§4 of
 * ADR-0031); this function therefore refuses it rather than inventing a scope.
 */
export function orphanRunScope(email) {
  const scoped = WORKER_SCOPE.exec(email);
  if (scoped) return scoped[1];
  throw new Error('An address outside the scoped grammar cannot be attributed a run scope');
}

/** One reconcile identity set: manifests authoritative, CloudTrail additions reported. */
export function buildIdentitySet({ manifests, events, window, userPoolId }) {
  const unresolved = [];
  const identities = [];
  for (const record of manifestIdentities(manifests)) {
    if (record.mode !== 'worker' || !isCapturedBetaWorkerEmail(record.email)) {
      unresolved.push({
        email: record.email,
        reason: 'unprovable_ownership',
        origin: record.origin,
        boundAt: record.boundAt,
      });
      continue;
    }
    // A stable allowlist row is an address a human tester can hold too, so its grammar proves
    // nothing: the captured subject is the only ownership proof, and without one the record is
    // reported instead of deleted (ADR-0031 §4). A scoped address carries its own proof.
    if (STABLE_WORKER_EMAIL_PATTERN.test(record.email) && !record.subject) {
      unresolved.push({
        email: record.email,
        reason: 'unprovable_ownership',
        origin: record.origin,
        boundAt: record.boundAt,
      });
      continue;
    }
    identities.push(record);
  }
  const windows = manifestAttributionWindows(manifests);
  const { created, unattributable } = parseCreateUserEvents(events, window, { userPoolId });
  for (const entry of unattributable) {
    unresolved.push({
      email: entry.email,
      reason: 'unattributable_caller',
      caller: entry.caller,
      origin: { kind: 'cloudtrail', event_id: entry.eventId, event_time: entry.eventTime },
      boundAt: Date.parse(reconcileBound(entry.eventTime)),
    });
  }
  for (const creation of orphanCreations(created, windows)) {
    const existing = identities.find((identity) => identity.email === creation.email);
    if (existing) {
      // A later creation of an address a retained record already names: one deletion
      // resolves both, and the later creation moves the bound out.
      existing.boundAt = Math.max(existing.boundAt, Date.parse(reconcileBound(creation.eventTime)));
      continue;
    }
    // A creation with no manifest entry is only attributable through the scoped grammar: a
    // stable pool row has no captured subject here and no scope in its address, so it is
    // reported rather than deleted.
    if (STABLE_WORKER_EMAIL_PATTERN.test(creation.email)) {
      unresolved.push({
        email: creation.email,
        reason: 'unprovable_ownership',
        origin: { kind: 'cloudtrail', event_id: creation.eventId, event_time: creation.eventTime },
        boundAt: Date.parse(reconcileBound(creation.eventTime)),
      });
      continue;
    }
    identities.push({
      email: creation.email,
      mode: 'worker',
      status: 'retained',
      subject: undefined,
      retainedReason: 'manifest artifact missing for this creation',
      reconcileBy: undefined,
      origin: { kind: 'cloudtrail', event_id: creation.eventId, event_time: creation.eventTime },
      runScope: orphanRunScope(creation.email),
      boundAt: Date.parse(reconcileBound(creation.eventTime)),
    });
  }
  identities.sort((left, right) => left.boundAt - right.boundAt || left.email.localeCompare(right.email));
  return { identities, unresolved, created, unattributable };
}

/**
 * Group the Service cleanup requests by the run scope they were captured under, oldest
 * first. The Service admits at most eight exact users per request, and one request per
 * captured scope keeps the execution name deterministic for a retry.
 */
export function cleanupGroups(identities, { maxUsers = RECONCILE_MAX_USERS_PER_REQUEST } = {}) {
  requirePositiveInteger(maxUsers, 'Cleanup users per request');
  const byScope = new Map();
  for (const identity of identities) {
    if (!byScope.has(identity.runScope)) byScope.set(identity.runScope, []);
    byScope.get(identity.runScope).push(identity);
  }
  const groups = [];
  for (const [runScope, members] of byScope) {
    if (!RECONCILE_RUN_SCOPE.test(runScope)) throw new Error('Cleanup group run scope is invalid');
    for (let index = 0; index < members.length; index += maxUsers) {
      const chunk = members.slice(index, index + maxUsers);
      groups.push({ runScope, identities: chunk, boundAt: Math.min(...chunk.map((identity) => identity.boundAt)) });
    }
  }
  return groups.sort((left, right) => left.boundAt - right.boundAt || left.runScope.localeCompare(right.runScope));
}

/** The canonical exact-reference cleanup request the Service accepts. */
export function cleanupRequest(runScope, users) {
  return JSON.stringify({ runScope, users: users.map(({ sub, email }) => ({ sub, email })) });
}

/**
 * The `actions.objects` value a committed cleanup result proves. A Service release that does
 * not state both counters cannot prove the object phase, so it is `unavailable` and the
 * identity is retained rather than reported clean on an assumption.
 */
export function objectAction(committed) {
  if (!committed || typeof committed !== 'object' || Array.isArray(committed)) return 'unavailable';
  const { objects, objectsMissing } = committed;
  if (!Number.isSafeInteger(objects) || objects < 0 || !Number.isSafeInteger(objectsMissing) || objectsMissing < 0) return 'unavailable';
  if (objects > 0) return 'deleted';
  if (objectsMissing > 0) return 'absent';
  return 'none';
}

function recordIdentity(identity, { subject, actions, outcome }) {
  return {
    email: identity.email,
    subject: typeof subject === 'string' && CAPTURED_SUBJECT.test(subject) ? subject.toLowerCase() : null,
    origin: identity.origin.kind === 'manifest'
      ? { kind: 'manifest', run: identity.origin.run, attempt: identity.origin.attempt }
      : { kind: 'cloudtrail', event_id: identity.origin.event_id, event_time: identity.origin.event_time },
    actions,
    outcome,
  };
}

/**
 * Build and validate the `anywear_e2e_account_reconcile` v1 record. The record is the audit
 * trail for leftovers, so it names the original run, the address and the outcome of every
 * identity, and it fails closed on any field outside the reviewed contract.
 */
export function buildReconcileRecord({ reconcileId, window, sources, identities, unresolved, result }) {
  const record = {
    schema_version: RECONCILE_SCHEMA_VERSION,
    record_type: RECONCILE_RECORD_TYPE,
    reconcile_id: reconcileId,
    window: { from: window.from, to: window.to },
    sources: { artifacts: sources.artifacts, cloudtrail_events: sources.cloudtrail_events },
    identities,
    unresolved,
    result,
  };
  validateReconcileRecord(record);
  return record;
}

export function validateReconcileRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Reconcile record must be an object');
  if (Object.keys(record).sort().join(',') !== 'identities,reconcile_id,record_type,result,schema_version,sources,unresolved,window') {
    throw new Error('Reconcile record has an unknown or missing member');
  }
  if (record.schema_version !== RECONCILE_SCHEMA_VERSION || record.record_type !== RECONCILE_RECORD_TYPE) throw new Error('Reconcile record schema is not v1');
  if (typeof record.reconcile_id !== 'string' || !/^[1-9][0-9]*-[1-9][0-9]*$/.test(record.reconcile_id)) throw new Error('Reconcile record id is not a run/attempt pair');
  if (!record.window || Object.keys(record.window).sort().join(',') !== 'from,to') throw new Error('Reconcile window has an unknown or missing member');
  const from = Date.parse(instant(record.window.from, 'Reconcile window start'));
  const to = Date.parse(instant(record.window.to, 'Reconcile window end'));
  if (from >= to) throw new Error('Reconcile window is not a positive span');
  if (Math.round((to - from) / 60_000) !== RECONCILE_WINDOW_DAYS * 24 * 60) throw new Error('Reconcile window is not the reviewed lookback');
  if (!record.sources || Object.keys(record.sources).sort().join(',') !== 'artifacts,cloudtrail_events') throw new Error('Reconcile sources have an unknown or missing member');
  requirePositiveInteger(record.sources.artifacts, 'Reconcile artifact count');
  if (record.sources.artifacts > RECONCILE_MAX_ARTIFACTS) throw new Error('Reconcile artifact count exceeds its bound');
  if (!Number.isSafeInteger(record.sources.cloudtrail_events) || record.sources.cloudtrail_events < 0 || record.sources.cloudtrail_events > RECONCILE_MAX_EVENTS) {
    throw new Error('Reconcile CloudTrail count is unbounded');
  }
  if (!['passed', 'failed'].includes(record.result)) throw new Error('Reconcile result is not passed or failed');
  if (!Array.isArray(record.identities) || record.identities.length > 500) throw new Error('Reconcile identities are unbounded');
  const addresses = new Set();
  for (const identity of record.identities) {
    if (!identity || typeof identity !== 'object' || Array.isArray(identity)) throw new Error('Reconcile identity is malformed');
    if (Object.keys(identity).sort().join(',') !== 'actions,email,origin,outcome,subject') throw new Error('Reconcile identity has an unknown member');
    if (!isCapturedBetaWorkerEmail(identity.email)) throw new Error('Reconcile identity address is outside the captured Beta worker families');
    if (addresses.has(identity.email)) throw new Error('Reconcile identity is duplicated');
    addresses.add(identity.email);
    if (!(identity.subject === null || typeof identity.subject === 'string' && CAPTURED_SUBJECT.test(identity.subject))) {
      throw new Error('Reconcile identity subject is not a captured subject');
    }
    if (!identity.actions || Object.keys(identity.actions).sort().join(',') !== 'cognito,objects,readback,service_cleanup') {
      throw new Error('Reconcile identity actions have an unknown member');
    }
    if (!CLEANUP_ACTION.includes(identity.actions.service_cleanup) || !COGNITO_ACTION.includes(identity.actions.cognito)
      || !OBJECT_ACTION.includes(identity.actions.objects) || !READBACK_ACTION.includes(identity.actions.readback)) {
      throw new Error('Reconcile identity action value is outside the closed set');
    }
    if (!IDENTITY_OUTCOMES.includes(identity.outcome)) throw new Error('Reconcile identity outcome is outside the closed set');
    validateOrigin(identity.origin, 'Reconcile identity origin');
  }
  if (!Array.isArray(record.unresolved) || record.unresolved.length > 500) throw new Error('Reconcile unresolved list is unbounded');
  for (const entry of record.unresolved) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Reconcile unresolved entry is malformed');
    if (!['caller,email,origin,reason', 'email,origin,reason'].includes(Object.keys(entry).sort().join(','))) throw new Error('Reconcile unresolved entry has an unknown member');
    if (!isCapturedBetaWorkerEmail(entry.email)) throw new Error('Reconcile unresolved address is outside the captured Beta worker families');
    if (!UNRESOLVED_REASONS.includes(entry.reason)) throw new Error('Reconcile unresolved reason is outside the closed set');
    validateOrigin(entry.origin, 'Reconcile unresolved origin');
  }
  if (record.result === 'failed' && record.unresolved.length === 0) throw new Error('Reconcile result is failed with no unresolved identity');
  return record;
}

function validateOrigin(origin, label) {
  if (origin?.kind === 'manifest') {
    if (Object.keys(origin).sort().join(',') !== 'attempt,kind,run') throw new Error(`${label} has an unknown member`);
    requirePositiveInteger(origin.run, `${label} run`);
    requirePositiveInteger(origin.attempt, `${label} attempt`);
    return;
  }
  if (origin?.kind === 'cloudtrail') {
    if (Object.keys(origin).sort().join(',') !== 'event_id,event_time,kind') throw new Error(`${label} has an unknown member`);
    requireString(origin.event_id, `${label} event id`);
    instant(origin.event_time, `${label} event time`);
    return;
  }
  throw new Error(`${label} is not manifest or cloudtrail`);
}

/**
 * The run fails only for a leftover it was supposed to resolve inside its bound. A retry
 * inside the bound is the ordinary path: the identity is recorded and the next run — or the
 * daily schedule — tries again. A creation by a foreign principal and an address outside the
 * captured grammar are reported but never resolved by this operation, so neither fails the
 * run on its own.
 */
export function judgeResult(unresolved, now, bounds) {
  for (const entry of unresolved) {
    if (entry.reason === 'unattributable_caller' || entry.reason === 'unprovable_ownership') continue;
    const bound = bounds.get(entry.email);
    if (bound === undefined || now > bound) return 'failed';
  }
  return 'passed';
}

/** The Service cleanup evidence path for one group, so groups cannot overwrite each other. */
export function cleanupEvidencePath(directory, index, runScope) {
  return resolve(directory, `service-cleanup-${index}-${runScope}.json`);
}

/**
 * The reconcile operation.
 *
 * `io` is the whole transport seam, so the offline tests exercise the diff, the bounds and
 * the record without an AWS or GitHub call:
 *   listArtifacts(window)          -> artifact rows in the window
 *   downloadManifest(artifact)     -> the artifact's account-budget.json bytes
 *   lookupCreateUserEvents(window) -> CloudTrail lookup-events rows
 *   getUser(email)                 -> { Username, UserAttributes } or UserNotFoundException
 *   deleteUser(username)           -> deletes by immutable username
 *   runServiceCleanup(inputs, env) -> { proof_status, committed_result } or undefined
 */
export async function reconcileAccounts({
  io,
  environment = process.env,
  now = Date.now(),
  runIdentity,
  window = reconcileWindow(now, Number(environment.E2E_ACCOUNT_RECONCILE_LOOKBACK_DAYS ?? RECONCILE_WINDOW_DAYS)),
  deadlineMs = Number(environment.E2E_ACCOUNT_RECONCILE_DEADLINE_SECONDS ?? DEFAULT_RECONCILE_DEADLINE_SECONDS) * 1000,
  log = (line) => process.stdout.write(`${line}\n`),
} = {}) {
  if (!io) throw new Error('Reconcile requires its transport');
  requirePositiveInteger(runIdentity?.runId, 'Reconcile run id');
  requirePositiveInteger(runIdentity?.attempt, 'Reconcile run attempt');
  const reconcileId = `${runIdentity.runId}-${runIdentity.attempt}`;
  const deadline = Date.now() + deadlineMs;

  const artifacts = await io.listArtifacts(window);
  if (!Array.isArray(artifacts) || artifacts.length < 1) throw new Error('No lifecycle artifact was readable in the reconcile window');
  if (artifacts.length > RECONCILE_MAX_ARTIFACTS) throw new Error('Lifecycle artifacts in the window exceed the reconcile bound');
  const manifests = [];
  for (const artifact of artifacts) {
    if (!parseManifestArtifactName(artifact.name)) throw new Error('Reconcile was offered a non-lifecycle artifact');
    const bytes = await io.downloadManifest(artifact);
    manifests.push(readManifest(bytes, parseManifestArtifactName(artifact.name)));
  }
  const events = await io.lookupCreateUserEvents(window);
  const identitySet = buildIdentitySet({ manifests, events, window, userPoolId: environment.USER_POOL_ID });
  log(`Reconcile ${reconcileId}: ${manifests.length} manifest(s), ${events.length} CloudTrail event(s), `
    + `${identitySet.identities.length} attributable identit(ies), ${identitySet.unresolved.length} unattributable creation(s).`);

  const recordIdentities = [];
  const unresolved = [];
  const bounds = new Map();
  for (const entry of identitySet.unresolved) {
    bounds.set(entry.email, entry.boundAt);
    unresolved.push({
      email: entry.email,
      reason: entry.reason,
      ...(entry.caller ? { caller: entry.caller } : {}),
      origin: entry.origin,
    });
  }
  for (const identity of identitySet.identities) bounds.set(identity.email, identity.boundAt);

  const groups = cleanupGroups(identitySet.identities);
  for (const [index, group] of groups.entries()) {
    if (Date.now() > deadline) {
      for (const identity of group.identities) {
        unresolved.push({ email: identity.email, reason: 'deadline_exceeded', origin: identity.origin });
        recordIdentities.push(recordIdentity(identity, {
          subject: identity.subject,
          actions: { service_cleanup: 'not_required', cognito: 'not_attempted', objects: 'not_required', readback: 'not_attempted' },
          outcome: 'retained',
        }));
      }
      continue;
    }
    await reconcileGroup({ group, index, io, environment, recordIdentities, unresolved });
  }

  const result = judgeResult(unresolved, now, bounds);
  const record = buildReconcileRecord({
    reconcileId,
    window,
    sources: { artifacts: manifests.length, cloudtrail_events: events.length },
    identities: recordIdentities.sort((left, right) => left.email.localeCompare(right.email)),
    unresolved: unresolved.sort((left, right) => left.email.localeCompare(right.email)),
    result,
  });
  return { record, result, identitySet };
}

async function reconcileGroup({ group, index, io, environment, recordIdentities, unresolved }) {
  const members = [];
  for (const identity of group.identities) {
    let live;
    try {
      live = await io.getUser(identity.email);
    } catch (error) {
      if (isUserNotFound(error)) {
        // An absent identity with a captured subject still owes the row and object cleanup:
        // the ordered teardown deletes those first, so absence alone does not prove them.
        // Without a captured subject the exact request cannot be built, and the absence is
        // the completed re-run case the design records as `already_absent`.
        if (identity.subject) members.push({ identity, subject: identity.subject, username: undefined });
        else {
          recordIdentities.push(recordIdentity(identity, {
            subject: null,
            actions: { service_cleanup: 'not_required', cognito: 'already_absent', objects: 'not_required', readback: 'absent' },
            outcome: 'already_absent',
          }));
        }
        continue;
      }
      unresolved.push({ email: identity.email, reason: 'cognito_readback_failed', origin: identity.origin });
      recordIdentities.push(recordIdentity(identity, {
        subject: identity.subject,
        actions: { service_cleanup: 'not_required', cognito: 'not_attempted', objects: 'not_required', readback: 'unreadable' },
        outcome: 'retained',
      }));
      continue;
    }
    const attributes = Object.fromEntries((live.UserAttributes ?? []).map(({ Name, Value }) => [Name, Value]));
    if (typeof live.Username !== 'string' || live.Username.length === 0 || live.Username.includes('@')
      || attributes.email !== identity.email
      || typeof attributes.sub !== 'string' || !CAPTURED_SUBJECT.test(attributes.sub)) {
      unresolved.push({ email: identity.email, reason: 'unprovable_ownership', origin: identity.origin });
      recordIdentities.push(recordIdentity(identity, {
        subject: identity.subject,
        actions: { service_cleanup: 'not_required', cognito: 'not_attempted', objects: 'not_required', readback: 'not_attempted' },
        outcome: 'retained',
      }));
      continue;
    }
    // The captured subject stays a consistency check when the manifest has one: a
    // disagreement means this is not the identity the run created.
    if (identity.subject && identity.subject.toLowerCase() !== attributes.sub.toLowerCase()) {
      unresolved.push({ email: identity.email, reason: 'subject_mismatch', origin: identity.origin });
      recordIdentities.push(recordIdentity(identity, {
        subject: identity.subject,
        actions: { service_cleanup: 'not_required', cognito: 'not_attempted', objects: 'not_required', readback: 'not_attempted' },
        outcome: 'retained',
      }));
      continue;
    }
    members.push({ identity, subject: attributes.sub.toLowerCase(), username: live.Username });
  }
  if (members.length === 0) return;

  const inputs = {
    action: 'cleanup',
    emails: '[]',
    cleanup_json: cleanupRequest(group.runScope, members.map(({ identity, subject }) => ({ sub: subject, email: identity.email }))),
  };
  let evidence;
  try {
    evidence = await io.runServiceCleanup(inputs, {
      ...environment,
      E2E_SERVICE_CLEANUP_EVIDENCE_PATH: cleanupEvidencePath(environment.E2E_ACCOUNT_RECONCILE_DIRECTORY ?? 'reconcile', index, group.runScope),
    });
  } catch {
    recordServiceFailure(members, recordIdentities, unresolved, 'service_cleanup_refused');
    return;
  }
  if (!evidence) {
    recordServiceFailure(members, recordIdentities, unresolved, 'service_cleanup_unavailable');
    return;
  }
  if (evidence.proof_status !== 'verified') {
    recordServiceFailure(members, recordIdentities, unresolved, 'service_cleanup_refused');
    return;
  }
  // The object phase is proven by the committed result's own counters. A Service that cannot
  // state them cannot prove the objects are gone, so the identity is retained until the
  // reviewed Service release is deployed rather than reported clean on an assumption.
  const objects = objectAction(evidence.committed_result);
  for (const member of members) {
    if (objects === 'unavailable') {
      unresolved.push({ email: member.identity.email, reason: 'object_cleanup_unproven', origin: member.identity.origin });
      recordIdentities.push(recordIdentity(member.identity, {
        subject: member.identity.subject ?? member.subject,
        actions: { service_cleanup: 'committed', cognito: 'not_attempted', objects: 'unavailable', readback: 'not_attempted' },
        outcome: 'retained',
      }));
      continue;
    }
    if (member.username === undefined) {
      recordIdentities.push(recordIdentity(member.identity, {
        subject: member.identity.subject ?? member.subject,
        actions: { service_cleanup: 'committed', cognito: 'already_absent', objects, readback: 'absent' },
        outcome: 'already_absent',
      }));
      continue;
    }
    try {
      await io.deleteUser(member.username);
    } catch (error) {
      if (!isUserNotFound(error)) {
        unresolved.push({ email: member.identity.email, reason: 'cognito_delete_refused', origin: member.identity.origin });
        recordIdentities.push(recordIdentity(member.identity, {
          subject: member.identity.subject ?? member.subject,
          actions: { service_cleanup: 'committed', cognito: 'refused', objects, readback: 'not_attempted' },
          outcome: 'retained',
        }));
        continue;
      }
    }
    try {
      await io.getUser(member.identity.email);
    } catch (error) {
      if (isUserNotFound(error)) {
        recordIdentities.push(recordIdentity(member.identity, {
          subject: member.identity.subject ?? member.subject,
          actions: { service_cleanup: 'committed', cognito: 'deleted', objects, readback: 'absent' },
          outcome: 'reconciled',
        }));
        continue;
      }
      unresolved.push({ email: member.identity.email, reason: 'cognito_readback_failed', origin: member.identity.origin });
      recordIdentities.push(recordIdentity(member.identity, {
        subject: member.identity.subject ?? member.subject,
        actions: { service_cleanup: 'committed', cognito: 'deleted', objects, readback: 'unreadable' },
        outcome: 'retained',
      }));
      continue;
    }
    unresolved.push({ email: member.identity.email, reason: 'cognito_readback_failed', origin: member.identity.origin });
    recordIdentities.push(recordIdentity(member.identity, {
      subject: member.identity.subject ?? member.subject,
      actions: { service_cleanup: 'committed', cognito: 'deleted', objects, readback: 'present' },
      outcome: 'retained',
    }));
  }
}

function recordServiceFailure(members, recordIdentities, unresolved, reason) {
  for (const member of members) {
    unresolved.push({ email: member.identity.email, reason, origin: member.identity.origin });
    recordIdentities.push(recordIdentity(member.identity, {
      subject: member.identity.subject ?? member.subject,
      actions: {
        service_cleanup: reason === 'service_cleanup_refused' ? 'refused' : 'unavailable',
        cognito: 'not_attempted',
        objects: 'unavailable',
        readback: 'not_attempted',
      },
      outcome: 'retained',
    }));
  }
}

function isUserNotFound(error) {
  return error instanceof Error && (error.name === 'UserNotFoundException' || /UserNotFoundException/.test(error.message));
}

// The artifact zip's `account-budget.json`, checked the same way the recovery reader checks
// its own archive: known names only, bounded size, no directories or symlinks. A v4 artifact
// upload flattens `test-results/account-budget.json` to `account-budget.json`.
const ACCOUNT_ARCHIVE_READER = [
  'import sys, zipfile, base64',
  'with zipfile.ZipFile(sys.argv[1]) as z:',
  ' entries=z.infolist()',
  ' names=[e.filename for e in entries]',
  ' if len(names)!=len(set(names)) or names!=["account-budget.json"]: raise ValueError("Unexpected account artifact contents")',
  ' if any(e.is_dir() or e.file_size>1048576 or (e.external_attr>>16)&0o170000==0o120000 for e in entries): raise ValueError("Unbounded or unsafe account artifact file")',
  ' print(base64.b64encode(z.read("account-budget.json")).decode("ascii"))',
].join('\n');

function extractAccountManifest(archivePath) {
  const stdout = execFileSync('python3', ['-c', ACCOUNT_ARCHIVE_READER, archivePath], {
    timeout: 15_000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8',
  });
  return Buffer.from(stdout.trim(), 'base64');
}

// The production transports. They are the only places that touch GitHub, AWS or the Service
// cleanup capability; the tests inject the same interface instead.
export function createReconcileIo(environment = process.env) {
  const repository = repositories.e2e;
  const userPoolId = environment.USER_POOL_ID;
  if (!userPoolId) throw new Error('USER_POOL_ID is required to read the Beta pool');
  const client = new CognitoIdentityProviderClient({ region: environment.AWS_REGION ?? 'ap-east-1' });

  async function listArtifacts(window) {
    const artifacts = [];
    for (let page = 1; page <= 5; page += 1) {
      const response = parseStrictJson(ghApi(`repos/${repository}/actions/artifacts?per_page=100&page=${page}`, false, environment));
      if (!response || !Array.isArray(response.artifacts)) throw new Error('Artifact list response is malformed');
      for (const artifact of response.artifacts) {
        if (artifact.expired !== false || !parseManifestArtifactName(artifact.name)) continue;
        const createdAt = Date.parse(artifact.created_at ?? '');
        if (!Number.isFinite(createdAt) || createdAt < Date.parse(window.from) || createdAt > Date.parse(window.to)) continue;
        artifacts.push({ id: requirePositiveInteger(artifact.id, 'Artifact id'), name: artifact.name, digest: artifact.digest });
      }
      if (response.artifacts.length < 100) break;
    }
    return artifacts;
  }

  async function downloadManifest(artifact) {
    const archive = ghApi(`repos/${repository}/actions/artifacts/${artifact.id}/zip`, true, environment);
    if (!Buffer.isBuffer(archive) || archive.length === 0 || archive.length > 8 * 1024 * 1024) throw new Error('Lifecycle artifact is empty or exceeds its bound');
    if (typeof artifact.digest === 'string' && /^sha256:[a-f0-9]{64}$/.test(artifact.digest) && artifact.digest !== `sha256:${byteHash(archive)}`) {
      throw new Error('Lifecycle artifact digest does not match its bytes');
    }
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const directory = await mkdtemp(join(tmpdir(), 'anywear-reconcile-'));
    const path = join(directory, 'artifact.zip');
    await writeFile(path, archive);
    return extractAccountManifest(path);
  }

  async function lookupCreateUserEvents(window) {
    const rows = [];
    let token;
    for (let page = 0; page < 20; page += 1) {
      const args = ['cloudtrail', 'lookup-events', '--region', 'ap-east-1',
        '--lookup-attributes', 'AttributeKey=EventName,AttributeValue=AdminCreateUser',
        '--start-time', window.from, '--end-time', window.to, '--max-results', '50',
        '--output', 'json', '--no-cli-pager', ...(token ? ['--next-token', token] : [])];
      const { stdout } = await execute('aws', args, { timeout: 30_000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8', windowsHide: true });
      const response = parseStrictJson(stdout);
      if (!response || !Array.isArray(response.Events)) throw new Error('CloudTrail lookup response is malformed');
      rows.push(...response.Events);
      if (rows.length > RECONCILE_MAX_EVENTS) throw new Error('CloudTrail read exceeds its bound');
      if (typeof response.NextToken !== 'string' || response.NextToken.length === 0) return rows;
      if (page === 19) throw new Error('CloudTrail pagination exceeds its bound');
      token = response.NextToken;
    }
    return rows;
  }

  return {
    listArtifacts,
    downloadManifest,
    lookupCreateUserEvents,
    async getUser(email) {
      const user = await client.send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: email }));
      return { Username: user.Username, UserAttributes: user.UserAttributes };
    },
    async deleteUser(username) {
      assertE2EExecution(environment);
      await client.send(new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: username }));
    },
    async runServiceCleanup(inputs, cleanupEnvironment) {
      const evidence = await runCleanupOperation(inputs, cleanupEnvironment);
      if (!evidence) return undefined;
      const operation = evidence.operation ?? {};
      return { proof_status: operation.proof_status, committed_result: operation.committed_result };
    },
    destroy() { client.destroy(); },
  };
}

async function main() {
  const recordPath = process.env.E2E_ACCOUNT_RECONCILE_RECORD_PATH ?? 'reconcile/account-reconcile.json';
  let io;
  try {
    assertE2EExecution();
    io = createReconcileIo(process.env);
    const runIdentity = { runId: Number(process.env.GITHUB_RUN_ID), attempt: Number(process.env.GITHUB_RUN_ATTEMPT) };
    const { record } = await reconcileAccounts({ io, environment: process.env, runIdentity });
    await mkdir(dirname(resolve(recordPath)), { recursive: true });
    await writeFile(resolve(recordPath), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`Reconcile record: ${record.reconcile_id} result=${record.result} identities=${record.identities.length} unresolved=${record.unresolved.length}\n`);
    if (record.result !== 'passed') {
      for (const entry of record.unresolved) {
        const origin = entry.origin.kind === 'manifest'
          ? `run ${entry.origin.run} attempt ${entry.origin.attempt}`
          : `CloudTrail event ${entry.origin.event_id} at ${entry.origin.event_time}`;
        process.stderr.write(`::error title=Unresolved E2E leftover::${entry.email} (${entry.reason}) from ${origin}\n`);
      }
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Account reconcile failed'}\n`);
    process.exitCode = 1;
  } finally {
    io?.destroy?.();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
