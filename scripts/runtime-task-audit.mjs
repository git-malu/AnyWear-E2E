import { isDeepStrictEqual } from 'node:util';

const TASK_ARN = /^arn:aws:ecs:ap-east-1:650880818323:task\/[^/]+\/([a-f0-9]{32})$/;
export const TERMINAL_STABILITY_MS = 440_000;

export function auditRequest(scope, details, taskId) {
  return { runScope: scope.runScope, user: { sub: scope.subject, email: scope.email },
    taskId, itemId: details.itemId, idempotencyKey: details.idempotencyKey };
}

export function validateTaskAudit(audit, request, terminalStatus) {
  if (audit?.schema_version !== 1 || audit.source !== 'durable-task-audit'
    || !isDeepStrictEqual(audit.binding, request) || !Number.isFinite(Date.parse(audit.observed_at))
    || audit.task?.id !== request.taskId || audit.task?.task_type !== 'auto-tagging'
    || audit.resource?.item_id !== request.itemId
    || !Number.isInteger(audit.task.execution_token) || audit.task.execution_token < 1
    || !Number.isInteger(audit.task.attempt_count) || audit.task.attempt_count < 1
    || !Number.isInteger(audit.task.state_version) || audit.task.state_version < 1
    || !Number.isInteger(audit.resource.state_version) || audit.resource.state_version < 1
    || audit.current_rows?.same_resource_tasks !== 1 || audit.current_rows?.exact_confirmation_records !== 1
    || audit.outbox?.task_id !== request.taskId || audit.outbox?.status !== 'published'
    || !Number.isFinite(Date.parse(audit.outbox.published_at))
    || audit.credit?.applicability !== 'not-applicable' || audit.credit?.reason !== 'auto-tagging') {
    throw new Error('Exact run-owned durable task audit failed binding/current-state validation');
  }
  if (terminalStatus && (audit.task.status !== (terminalStatus === 'ready' ? 'complete' : 'failed')
    || audit.resource.tagging_status !== terminalStatus || !Number.isFinite(Date.parse(audit.task.terminal_at)))) {
    throw new Error('Durable task/resource audit did not match the observed terminal state');
  }
  if (!terminalStatus && !['pending', 'processing', 'retry', 'complete', 'failed'].includes(audit.task.status)) {
    throw new Error('Durable task audit has an invalid task status');
  }
  return audit;
}

export function extractAuditTaskBinding(stdout) {
  const exactLine = (label) => {
    const values = String(stdout).split(/\r?\n/).filter((line) => line.startsWith(`${label}: `))
      .map((line) => line.slice(label.length + 2));
    if (values.length !== 1) throw new Error(`One-shot audit requires one exact ${label} line`);
    return values[0];
  };
  const taskArn = exactLine('Task ARN');
  const id = TASK_ARN.exec(taskArn)?.[1];
  const logGroup = exactLine('Task log group');
  const logStream = exactLine('Task log stream');
  if (!id || logGroup !== '/anywear/beta/one-shot' || logStream !== `beta-anywear-task-audit/OneShot/${id}`) {
    throw new Error('One-shot audit task/log attribution is not exact');
  }
  return { taskArn, logGroup, logStream };
}

export function extractAuditLog(events, request) {
  const audits = (events ?? []).flatMap((event) => {
    try {
      const parsed = JSON.parse(event.message);
      return parsed?.source === 'durable-task-audit' ? [parsed] : [];
    } catch { return []; }
  });
  if (audits.length !== 1) throw new Error('Exact one-shot stream did not contain one durable task audit');
  return validateTaskAudit(audits[0], request);
}

export function assertStableAudits(before, after, minimumMs = TERMINAL_STABILITY_MS) {
  if (!Number.isInteger(minimumMs) || minimumMs < TERMINAL_STABILITY_MS
    || Date.parse(after.observed_at) - Date.parse(before.observed_at) < minimumMs
    || !isDeepStrictEqual(before.binding, after.binding)
    || !isDeepStrictEqual(before.task, after.task) || !isDeepStrictEqual(before.resource, after.resource)
    || !isDeepStrictEqual(before.current_rows, after.current_rows)
    || !isDeepStrictEqual(before.outbox, after.outbox)) {
    throw new Error('Terminal task/resource snapshot changed or the finite stability window was too short');
  }
  return { observation_window_ms: minimumMs, before, after,
    scope: 'current-terminal-snapshot-only', late_stale_rejection_proven: false, missed_heartbeat_proven: false };
}
