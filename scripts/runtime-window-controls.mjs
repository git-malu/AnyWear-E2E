import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parseAdmissionMode } from './beta-admission-mode.mjs';
import { payloadHash, recoverOneShotRegistrations, verifyOneShotTask } from './runtime-one-shot.mjs';

// One mode record replaces the two admission booleans (issue #132), and the record is
// windowless (issue #159): `closed` or `testers`, no bound and no clock. A lifecycle
// action changes one parameter at a time: `suspend` and `resume` each write the mode once
// with no payload, and `set-testers` writes the tester list once and the mode not at all.
// The per-action SSM version deltas below move with the writer for exactly that reason.
const POLICY_KEYS = ['admission_mode', 'tester_allowlist'];
const POLICY_DELTAS = {
  suspend: { admission_mode: 1, tester_allowlist: 0 },
  resume: { admission_mode: 1, tester_allowlist: 0 },
  'set-testers': { admission_mode: 0, tester_allowlist: 1 },
};

export function testerHash(values) {
  return createHash('sha256').update(JSON.stringify([...new Set(values.map((value) => value.trim().toLowerCase()))].sort())).digest('hex');
}

// The record's mode, and its only decision. An open `testers` record is open until an
// explicit close writes `closed`; there is no bound to apply and no separate effective
// mode to compute.
function declaredMode(parameter) {
  const record = parseAdmissionMode(parameter?.value);
  if (!record) throw new Error('Runtime admission mode is not a reader-valid record');
  return record.mode;
}

export async function readRuntimePolicy(io) {
  const entries = await Promise.all(POLICY_KEYS.map(async (name) => {
    const response = await io.aws(['ssm', 'get-parameter', '--name', `/anywear/beta/${name}`]);
    const parameter = response.Parameter;
    if (typeof parameter?.Value !== 'string' || !Number.isInteger(parameter.Version) || parameter.Version < 1) {
      throw new Error('Runtime policy requires exact SSM values and write versions');
    }
    return [name, { value: parameter.Value, version: parameter.Version }];
  }));
  const result = Object.fromEntries(entries);
  if (!parseAdmissionMode(result.admission_mode.value)) {
    throw new Error('Runtime admission mode is not a reader-valid record');
  }
  const emails = JSON.parse(result.tester_allowlist.value);
  if (!Array.isArray(emails) || emails.length > 50 || emails.some((email) => typeof email !== 'string')
    || Buffer.byteLength(result.tester_allowlist.value) > 4096) throw new Error('Runtime tester policy is invalid');
  return result;
}

export async function auditRuntimePolicy(io, scope, snapshot, { requireEmpty = false } = {}) {
  if (typeof io.auditRuntimeWindow !== 'function') throw new Error('Runtime requires authoritative DB window census');
  const audit = await io.auditRuntimeWindow({ scope, request: { runScope: scope.runScope, mode: 'window-preflight' } });
  const emails = JSON.parse(snapshot.tester_allowlist.value);
  if (audit?.schema_version !== 1 || audit.source !== 'durable-runtime-window-audit'
    || !isDeepStrictEqual(audit.binding, { runScope: scope.runScope, mode: 'window-preflight' })
    || !Number.isFinite(Date.parse(audit.observed_at)) || !Number.isFinite(Date.parse(audit.policy?.updated_at))
    // The Service reports the admission mode its gates use, which is the same decision
    // this reader reaches from the mirror: both read the one windowless record, so
    // comparing them still catches real drift.
    || audit.policy.admission_mode !== declaredMode(snapshot.admission_mode)
    || audit.policy.tester_count !== new Set(emails.map((value) => value.trim().toLowerCase())).size
    || audit.policy.tester_allowlist_hash !== testerHash(emails)
    || ['active_tasks', 'unpublished_outbox', 'manual_intervention_outbox'].some((name) =>
      !Number.isInteger(audit.current_rows?.[name]) || audit.current_rows[name] < 0
      || (requireEmpty && audit.current_rows[name] !== 0))) {
    throw new Error('DB/SSM admission policy mismatch or authoritative durable backlog is not empty');
  }
  return audit;
}

export async function captureRuntimeWindow(io, scope) {
  const baseline = await readRuntimePolicy(io);
  scope.runtimeWindow = { run_scope: scope.runScope, synthetic_owner: { sub: scope.subject, email: scope.email },
    baseline, expected: baseline, write_ledger: [], phase: 'captured', restored: false,
    // The decision this run found, captured once: restoration restores the baseline
    // decision, because a `testers` record is open until an explicit close.
    baseline_mode: declaredMode(baseline.admission_mode) };
  if (io.saveRecovery) await io.saveRecovery(scope);
  scope.runtimeWindow.baseline_audit = await auditRuntimePolicy(io, scope, baseline, { requireEmpty: true });
  if (io.saveRecovery) await io.saveRecovery(scope);
}

export async function guardRuntimeWindow(io, scope, { requireEmpty = false } = {}) {
  if (!scope.runtimeWindow) throw new Error('Runtime policy baseline is not captured');
  const current = await readRuntimePolicy(io);
  if (!isDeepStrictEqual(current, scope.runtimeWindow.expected)) throw new Error('Foreign SSM policy/version drift; runtime mutation refused');
  await auditRuntimePolicy(io, scope, current, { requireEmpty });
  return current;
}

// A lifecycle write is nominal only when every parameter moved by the delta its action
// owns and the values it did not write are byte-identical to what they were before.
function nominalWrite(beforeVersions, before, after, action, expectedTesterHash) {
  const deltas = POLICY_DELTAS[action];
  if (!deltas || POLICY_KEYS.some((key) => after[key].version !== beforeVersions[key] + deltas[key])) return false;
  if (action === 'set-testers') {
    return after.admission_mode.value === before.admission_mode.value
      && testerHash(JSON.parse(after.tester_allowlist.value)) === expectedTesterHash;
  }
  return after.tester_allowlist.value === before.tester_allowlist.value
    && declaredMode(after.admission_mode) === (action === 'resume' ? 'testers' : 'closed');
}

export async function reconcilePendingPolicy(io, scope, notStarted,
  { allowRetainedProofForMissingTask = false } = {}) {
  const intent = scope.runtimeWindow?.pending_write;
  if (!intent) return;
  if (intent.one_shot_index === undefined) {
    const operation = { run_scope: scope.runScope, purpose: 'lifecycle', action: intent.action,
      request_payload: intent.request_payload, payload_sha256: typeof intent.request_payload === 'string' ? payloadHash(intent.request_payload) : '',
      started_at: intent.started_at, completed: false, deregistered: false };
    scope.oneShots ??= [];
    scope.oneShots.push(operation);
    intent.one_shot_index = scope.oneShots.length - 1;
    notStarted = await recoverOneShotRegistrations(io, scope);
  }
  const operation = scope.oneShots?.[intent.one_shot_index];
  if (!operation || operation.purpose !== 'lifecycle' || operation.action !== intent.action
    || (intent.request_payload !== undefined && operation.request_payload !== intent.request_payload)
    || (intent.action === 'set-testers' && testerHash(JSON.parse(operation.request_payload)) !== intent.tester_hash)) {
    throw new Error('Pending admission write has no exact owned lifecycle task proof');
  }
  if (notStarted?.has(operation)) {
    const before = intent.before_policy ?? scope.runtimeWindow.expected;
    const after = await readRuntimePolicy(io);
    if (intent.run_scope !== scope.runScope || !isDeepStrictEqual(before, scope.runtimeWindow.expected)
      || !isDeepStrictEqual(after, before)
      || POLICY_KEYS.some((key) => before[key].version !== intent.before_versions?.[key])) {
      throw new Error('Unstarted admission write has foreign SSM value/version drift');
    }
    await auditRuntimePolicy(io, scope, after);
    scope.runtimeWindow.write_ledger.push({ ...intent, recovered: true, not_started: true,
      after_versions: Object.fromEntries(POLICY_KEYS.map((key) => [key, after[key].version])) });
    delete scope.runtimeWindow.pending_write;
    if (io.saveRecovery) await io.saveRecovery(scope);
    return;
  }
  await verifyOneShotTask(io, scope, operation,
    { requireSuccess: false, allowRetainedProofForMissingTask });
  const after = await readRuntimePolicy(io);
  if (!nominalWrite(intent.before_versions, intent.before_policy ?? scope.runtimeWindow.expected, after,
    intent.action, intent.tester_hash)) {
    throw new Error('Pending admission write cannot be reconciled without foreign drift');
  }
  await auditRuntimePolicy(io, scope, after);
  scope.runtimeWindow.expected = after;
  scope.runtimeWindow.write_ledger.push({ ...intent, recovered: true,
    extraction: operation.proof,
    after_versions: Object.fromEntries(POLICY_KEYS.map((key) => [key, after[key].version])) });
  delete scope.runtimeWindow.pending_write;
  if (io.saveRecovery) await io.saveRecovery(scope);
}

// `payload` is the exact bytes the one-shot helper will carry: the canonical tester array
// for `set-testers`, and nothing for `suspend` and `resume`. The same bytes go into the
// durable intent, because reconciliation compares them.
async function writePolicy(io, scope, action, payload = '') {
  const before = await guardRuntimeWindow(io, scope);
  const intent = { run_scope: scope.runScope, action, before_versions: Object.fromEntries(POLICY_KEYS.map((key) => [key, before[key].version])),
    before_policy: before, request_payload: payload, started_at: new Date().toISOString(),
    tester_hash: action === 'set-testers' ? testerHash(JSON.parse(payload)) : testerHash(JSON.parse(before.tester_allowlist.value)) };
  scope.runtimeWindow.pending_write = intent;
  if (io.saveRecovery) await io.saveRecovery(scope);
  const operation = await io.runLifecycle({ scope, action, payload });
  if (operation?.operation?.proof) intent.extraction = operation.operation.proof;
  const after = await readRuntimePolicy(io);
  if (!nominalWrite(intent.before_versions, before, after, action, intent.tester_hash)) {
    throw new Error('Lifecycle SSM write versions are non-nominal; policy ownership is unresolved and restoration refused');
  }
  await auditRuntimePolicy(io, scope, after);
  scope.runtimeWindow.expected = after;
  scope.runtimeWindow.write_ledger.push({ ...intent,
    after_versions: Object.fromEntries(POLICY_KEYS.map((key) => [key, after[key].version])) });
  delete scope.runtimeWindow.pending_write;
  if (io.saveRecovery) await io.saveRecovery(scope);
}

export async function activateRuntimeWindow(io, scope) {
  // The run owns exactly one tester for its admission state, and only `resume` opens
  // admission: the tester write itself changes no admission state. `resume` carries no
  // payload, because there is no window request to state.
  await writePolicy(io, scope, 'set-testers', JSON.stringify([scope.email]));
  await writePolicy(io, scope, 'resume');
  scope.runtimeWindow.phase = 'private-owned-tester';
  if (io.saveRecovery) await io.saveRecovery(scope);
}

export async function pauseRuntimeWindow(io, scope) {
  if (!scope.runtimeWindow || scope.runtimeWindow.restored) return;
  // Admission never closes by time: a `testers` decision stays open until an explicit
  // write, so pausing it always suspends. Only a record that already says `closed`
  // needs no write.
  if (declaredMode(scope.runtimeWindow.expected.admission_mode) !== 'closed') await writePolicy(io, scope, 'suspend');
  else await guardRuntimeWindow(io, scope);
  scope.runtimeWindow.phase = 'paused';
  if (io.saveRecovery) await io.saveRecovery(scope);
}

export async function restoreRuntimeWindow(io, scope) {
  if (!scope.runtimeWindow) return;
  if (!scope.ownedCleanupCompleted || (scope.runtimeControl && !scope.runtimeControl.restored)) {
    throw new Error('Admission restoration withheld until owned cleanup and exact worker restoration pass');
  }
  await guardRuntimeWindow(io, scope, { requireEmpty: true });
  const baseline = scope.runtimeWindow.baseline;
  const baselineMode = scope.runtimeWindow.baseline_mode ?? declaredMode(baseline.admission_mode);
  if (scope.runtimeWindow.restored) {
    if (scope.runtimeWindow.expected.tester_allowlist.value !== baseline.tester_allowlist.value
      || declaredMode(scope.runtimeWindow.expected.admission_mode) !== baselineMode) {
      throw new Error('Saved restored policy values differ from baseline');
    }
    return;
  }
  // The Service refuses `set-testers` unless the database's effective mode is closed — not
  // the mirror's, which can lag the row — so admission is suspended before the tester
  // list is written.
  if (declaredMode(scope.runtimeWindow.expected.admission_mode) !== 'closed') await writePolicy(io, scope, 'suspend');
  await writePolicy(io, scope, 'set-testers', JSON.stringify(JSON.parse(baseline.tester_allowlist.value)));
  // A tester write changes no admission state, so the found decision is restored by its
  // own operation: `resume` with no payload when the run found admission open, nothing
  // when it did not. An open baseline is restored open because that is explicitly allowed.
  if (baselineMode !== 'closed') await writePolicy(io, scope, 'resume');
  const actual = await guardRuntimeWindow(io, scope, { requireEmpty: true });
  if (actual.tester_allowlist.value !== baseline.tester_allowlist.value
    || declaredMode(actual.admission_mode) !== baselineMode) {
    throw new Error('Original private admission decision and tester list were not restored');
  }
  scope.runtimeWindow.restored = true;
  scope.runtimeWindow.phase = 'restored';
  scope.runtimeWindow.final_audit = await auditRuntimePolicy(io, scope, actual, { requireEmpty: true });
  if (io.saveRecovery) await io.saveRecovery(scope);
}
