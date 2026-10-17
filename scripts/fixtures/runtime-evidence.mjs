import { FENCING_CASES } from '../runtime-fencing-evidence.mjs';
import { admissionWindowPayload } from '../admission-window.mjs';
import { TERMINAL_STABILITY_MS } from '../runtime-task-audit.mjs';
import { oneShotProof, payloadHash } from '../runtime-one-shot.mjs';
import { cleanupPayload } from '../runtime-one-shot-logs.mjs';
import { testerHash } from '../runtime-window-controls.mjs';

export function proofFixture(scope, purpose, payload, id = 'a', action = '') {
  return oneShotProof(scope, { purpose, action, request_payload: payload, payload_sha256: payloadHash(payload),
    task_arn: `arn:aws:ecs:ap-east-1:650880818323:task/beta-anywear/${id.repeat(32)}`,
    task_definition_arn: `arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-${purpose}:1` });
}

export function scopeFixture(request) {
  return { runScope: request.runScope, subject: request.user.sub, email: request.user.email,
    deployment: { service: { source_commit: 'b'.repeat(40), image_digest: `sha256:${'c'.repeat(64)}` } } };
}

export function cleanupFixture(scope) {
  scope = { ...scope, deployment: { service: scope.deployment.service ?? {
    source_commit: scope.deployment.service_source_commit, image_digest: scope.deployment.service_image_digest } } };
  const known = scope.knownDLQMessageId ? { ...scope.knownDLQMessageId, deleted: true } : undefined;
  return { extraction: proofFixture(scope, 'tester-cleanup', cleanupPayload(scope), '9'),
    committed: { schema_version: 1, source: 'beta-tester-cleanup', cleanup: 'beta-testers', run_scope: scope.runScope,
      transaction_committed: true, users: 1, missingUsers: 0, tasks: 2, outbox: 2, idempotency: 2, generations: 0,
      relations: 0, outfits: 0, items: 2, photos: 2, dlq: { deleted: known ? 1 : 0, preserved: 0, ...(known ? { known_message: known } : {}) } },
    ...(known ? { deletion: { schema_version: 1, source: 'beta-tester-dlq-cleanup', known_message: known } } : {}) };
}

export function windowFixture(scope) {
  // One mode parameter replaces the boolean pair, so the per-action version deltas are
  // the point of this fixture: `set-testers` moves the list only, and `resume`/`suspend`
  // move the mode only. Activation is therefore two writes, not one.
  const baseline = { admission_mode: 1, tester_allowlist: 2 };
  let versions = baseline;
  const ledger = [['set-testers', [scope.email]], ['resume'], ['suspend'], ['set-testers', []]].map(([action, emails], index) => {
    const after = { admission_mode: versions.admission_mode + (action === 'set-testers' ? 0 : 1),
      tester_allowlist: versions.tester_allowlist + (emails ? 1 : 0) };
    // The two payload-carrying actions carry different bytes: the canonical tester array,
    // and the bounded window request the Service requires before it opens a window.
    const payload = action === 'set-testers' ? JSON.stringify(emails)
      : action === 'resume' ? admissionWindowPayload() : '';
    const entry = { run_scope: scope.runScope, action, before_versions: versions, after_versions: after,
      tester_hash: testerHash(emails ?? [scope.email]),
      extraction: proofFixture(scope, 'lifecycle', payload, String(index + 1), action) };
    versions = after;
    return entry;
  });
  const request = { runScope: scope.runScope, mode: 'window-preflight' };
  const audit = (id) => ({ schema_version: 1, source: 'durable-runtime-window-audit', binding: request, observed_at: '2026-10-05T01:00:00Z',
    policy: { admission_mode: 'closed', tester_count: 0, tester_allowlist_hash: testerHash([]), updated_at: '2026-10-05T01:00:00Z' },
    current_rows: { active_tasks: 0, unpublished_outbox: 0, manual_intervention_outbox: 0 },
    extraction: proofFixture(scope, 'task-audit', JSON.stringify(request), id) });
  return { run_scope: scope.runScope, synthetic_owner: { sub: scope.subject, email: scope.email }, phase: 'restored', restored: true,
    baseline_versions: baseline, final_versions: versions, write_ledger: ledger, baseline_audit: audit('e'), final_audit: audit('f') };
}

export function auditFixture(request, { status = 'ready', token = 1, version = 3, after = false } = {}) {
  return { schema_version: 1, source: 'durable-task-audit', binding: request,
    observed_at: new Date(Date.parse('2026-10-05T01:00:00Z') + (after ? TERMINAL_STABILITY_MS : 0)).toISOString(),
    task: { id: request.taskId, task_type: 'auto-tagging', status: status === 'ready' ? 'complete' : 'failed',
      execution_token: token, attempt_count: status === 'ready' ? 1 : 3, state_version: 3, terminal_at: '2026-10-05T00:59:00Z' },
    resource: { item_id: request.itemId, tagging_status: status, state_version: version },
    current_rows: { same_resource_tasks: 1, exact_idempotency_records: 1 },
    outbox: { task_id: request.taskId, status: 'published', published_at: '2026-10-05T00:58:00Z' },
    credit: { applicability: 'not-applicable', reason: 'auto-tagging' },
    extraction: proofFixture(scopeFixture(request), 'task-audit', JSON.stringify(request), status === 'ready' ? (after ? 'b' : 'a') : (after ? 'd' : 'c')) };
}

export function stableAuditFixture(request, options) {
  return { observation_window_ms: TERMINAL_STABILITY_MS, before: auditFixture(request, options),
    after: auditFixture(request, { ...options, after: true }), scope: 'current-terminal-snapshot-only',
    late_stale_rejection_proven: false, missed_heartbeat_proven: false };
}

export function fencingCiFixture(serviceCommit) {
  return { binding: { schema_version: 1, repository: 'git-malu/AnyWear-Service', service_source_commit: serviceCommit,
    checked_out_commit: serviceCommit, run_id: '123', run_attempt: '1', event_name: 'push', ref: 'refs/heads/main',
    database_integration_enabled: true }, results: { success: true, numPassedTests: 2, numFailedTests: 0,
    testResults: [{ name: '/src/db/business-result-fencing.integration.test.ts', status: 'passed',
      assertionResults: FENCING_CASES.map((fullName) => ({ fullName, status: 'passed' })) }] } };
}
