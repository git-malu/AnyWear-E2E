import { FENCING_CASES } from '../runtime-fencing-evidence.mjs';
import { TERMINAL_STABILITY_MS } from '../runtime-task-audit.mjs';

export function auditFixture(request, { status = 'ready', token = 1, version = 3, after = false } = {}) {
  const id = (after ? 'b' : 'a').repeat(32);
  return { schema_version: 1, source: 'durable-task-audit', binding: request,
    observed_at: new Date(Date.parse('2026-10-05T01:00:00Z') + (after ? TERMINAL_STABILITY_MS : 0)).toISOString(),
    task: { id: request.taskId, task_type: 'auto-tagging', status: status === 'ready' ? 'complete' : 'failed',
      execution_token: token, attempt_count: status === 'ready' ? 1 : 3, state_version: 3, terminal_at: '2026-10-05T00:59:00Z' },
    resource: { item_id: request.itemId, tagging_status: status, state_version: version },
    current_rows: { same_resource_tasks: 1, exact_idempotency_records: 1 },
    outbox: { task_id: request.taskId, status: 'published', published_at: '2026-10-05T00:58:00Z' },
    credit: { applicability: 'not-applicable', reason: 'auto-tagging' },
    extraction: { task_arn: `arn:aws:ecs:ap-east-1:650880818323:task/beta-anywear/${id}`,
      log_group: '/anywear/beta/one-shot', log_stream: `beta-anywear-task-audit/OneShot/${id}`, exit_code: 0 } };
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
