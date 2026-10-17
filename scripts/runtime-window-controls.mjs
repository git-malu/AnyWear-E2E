import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { payloadHash, recoverOneShotRegistrations, verifyOneShotTask } from './runtime-one-shot.mjs';

const POLICY_KEYS = ['intake_open', 'admission_suspended', 'tester_allowlist'];

export function testerHash(values) {
  return createHash('sha256').update(JSON.stringify([...new Set(values.map((value) => value.trim().toLowerCase()))].sort())).digest('hex');
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
  if (result.intake_open.value !== 'false' || !['true', 'false'].includes(result.admission_suspended.value)) {
    throw new Error('Non-paid runtime requires private-only public intake closed');
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
    || audit.policy.intake_open !== false
    || audit.policy.admission_suspended !== (snapshot.admission_suspended.value === 'true')
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
    baseline, expected: baseline, write_ledger: [], phase: 'captured', restored: false };
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
    || (intent.action === 'configure-testers' && testerHash(JSON.parse(operation.request_payload)) !== intent.tester_hash)) {
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
  const deltas = intent.action === 'configure-testers' ? { intake_open: 0, tester_allowlist: 1, admission_suspended: 2 }
    : { intake_open: 0, tester_allowlist: 0, admission_suspended: 1 };
  if (POLICY_KEYS.some((key) => after[key].version !== intent.before_versions[key] + deltas[key])
    || after.intake_open.value !== 'false' || testerHash(JSON.parse(after.tester_allowlist.value)) !== intent.tester_hash
    || after.admission_suspended.value !== (intent.action === 'close' ? 'true' : 'false')) {
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

async function writePolicy(io, scope, action, emails) {
  const before = await guardRuntimeWindow(io, scope);
  const intent = { run_scope: scope.runScope, action, before_versions: Object.fromEntries(POLICY_KEYS.map((key) => [key, before[key].version])),
    before_policy: before, request_payload: emails === undefined ? '' : JSON.stringify(emails), started_at: new Date().toISOString(),
    tester_hash: emails ? testerHash(emails) : testerHash(JSON.parse(before.tester_allowlist.value)) };
  scope.runtimeWindow.pending_write = intent;
  if (io.saveRecovery) await io.saveRecovery(scope);
  const operation = await io.runLifecycle({ scope, action, payload: emails === undefined ? '' : JSON.stringify(emails) });
  if (operation?.operation?.proof) intent.extraction = operation.operation.proof;
  const after = await readRuntimePolicy(io);
  const deltas = action === 'configure-testers' ? { intake_open: 0, tester_allowlist: 1, admission_suspended: 2 }
    : { intake_open: 0, tester_allowlist: 0, admission_suspended: 1 };
  if (POLICY_KEYS.some((key) => after[key].version !== before[key].version + deltas[key])
    || after.intake_open.value !== before.intake_open.value
    || after.admission_suspended.value !== (action === 'close' ? 'true' : 'false')
    || testerHash(JSON.parse(after.tester_allowlist.value)) !== intent.tester_hash) {
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
  await writePolicy(io, scope, 'configure-testers', [scope.email]);
  scope.runtimeWindow.phase = 'private-owned-tester';
  if (io.saveRecovery) await io.saveRecovery(scope);
}

export async function pauseRuntimeWindow(io, scope) {
  if (!scope.runtimeWindow || scope.runtimeWindow.restored) return;
  if (scope.runtimeWindow.expected.admission_suspended.value !== 'true') await writePolicy(io, scope, 'close');
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
  if (scope.runtimeWindow.restored) {
    if (POLICY_KEYS.some((key) => scope.runtimeWindow.expected[key].value !== baseline[key].value)) throw new Error('Saved restored policy values differ from baseline');
    return;
  }
  await writePolicy(io, scope, 'configure-testers', JSON.parse(baseline.tester_allowlist.value));
  if (baseline.admission_suspended.value === 'true') await writePolicy(io, scope, 'close');
  const actual = await guardRuntimeWindow(io, scope, { requireEmpty: true });
  if (POLICY_KEYS.some((key) => actual[key].value !== baseline[key].value)) {
    throw new Error('Original private admission policy values were not restored exactly');
  }
  scope.runtimeWindow.restored = true;
  scope.runtimeWindow.phase = 'restored';
  scope.runtimeWindow.final_audit = await auditRuntimePolicy(io, scope, actual, { requireEmpty: true });
  if (io.saveRecovery) await io.saveRecovery(scope);
}
