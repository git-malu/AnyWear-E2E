import { hashBytes } from './beta-sizing-workload.mjs';

const finite = value => Number.isFinite(value) && value >= 0;
const one = items => items.length === 1 ? items[0] : undefined;

export function correlateSizingTask(resourceId, events) {
  const acceptance = one(events.filter(event => event.event === 'task_acceptance_precommit' && event.resourceId === resourceId));
  if (!acceptance?.taskId) return { gap: 'Unique accepted task/resource correlation missing' };
  const related = events.filter(event => event.taskId === acceptance.taskId);
  const processing = one(related.filter(event => event.event === 'task_processing_timing'));
  const started = one(related.filter(event => event.event === 'task_execution_started'));
  const send = one(related.filter(event => event.event === 'task_outbox_send_started'));
  const ack = one(related.filter(event => event.event === 'task_outbox_send_acknowledged'));
  const config = one(related.filter(event => event.event === 'provider_configuration'));
  if (!processing || !started || !send || !ack || !config
    || processing.outcome !== 'completed' || processing.executionToken !== 1 || started.executionToken !== 1
    || send.attemptCount !== 1 || ack.awsSdkAttempts !== 1 || send.outboxId !== ack.outboxId || !ack.awsRequestId
    || typeof config.model !== 'string' || !config.model || !finite(processing.localProcessingMs) || !finite(processing.providerMs)
    || !finite(started.startedMonotonicMs)) return { gap: 'First successful execution, provider config and unique send/ACK evidence required' };
  const sameClock = [send, ack, started, processing, config];
  if (!send.processInstance || sameClock.some(event => event.processInstance !== send.processInstance
    || event.workerTaskArn !== send.workerTaskArn || event.serviceSha !== acceptance.serviceSha
    || !finite(event.monotonicMs))) return { gap: 'Worker process/task/source changed across causal evidence' };
  const snapshot = one(events.filter(event => event.event === 'outbox_causal_snapshot'
    && event.processInstance === send.processInstance && event.workerTaskArn === send.workerTaskArn
    && event.startedMonotonicMs === send.absentSnapshotStartedMonotonicMs));
  if (!snapshot || snapshot.complete !== true || snapshot.cap !== 256 || snapshot.statementTimeoutMs !== 200
    || snapshot.querySemantics !== 'unfiltered-immutable-outbox-ids-read-committed'
    || !Array.isArray(snapshot.ids) || snapshot.ids.length > 256 || new Set(snapshot.ids).size !== snapshot.ids.length
    || snapshot.ids.includes(send.outboxId) || !finite(snapshot.startedMonotonicMs)
    || send.monotonicMs < snapshot.startedMonotonicMs || ack.monotonicMs < send.monotonicMs
    || started.startedMonotonicMs < send.monotonicMs) return { gap: 'Complete same-clock immutable-ID absence proof unavailable' };
  const proof = [acceptance, snapshot, send, ack, started, processing, config];
  return { task_id: acceptance.taskId, worker_task_arn: send.workerTaskArn,
    worker_process_instance: send.processInstance, started_monotonic_ms: started.startedMonotonicMs,
    finished_monotonic_ms: processing.monotonicMs,
    started_at: started.observedAt, finished_at: processing.observedAt,
    provider_configuration: Object.fromEntries(['provider', 'model', 'size', 'outputFormat', 'stream', 'imageCount',
      'sequentialImageGeneration', 'watermark'].filter(key => config[key] !== undefined).map(key => [key, config[key]])),
    timing: { task_id: acceptance.taskId, provider_separated: true,
      local_processing_ms: processing.localProcessingMs, provider_ms: processing.providerMs,
      queue: { kind: 'same-worker-causal-bounds', task_correlation_verified: true, clock_bound_verified: true,
        clock_evidence_sha256: hashBytes(JSON.stringify(proof)), process_instance: send.processInstance,
        outbox_id: send.outboxId, send_request_id: ack.awsRequestId,
        complete_unfiltered_absence_verified: true, first_attempt_verified: true, send_sdk_attempts: ack.awsSdkAttempts,
        absent_snapshot_started_ms: snapshot.startedMonotonicMs,
        send_started_ms: send.monotonicMs, send_acknowledged_ms: ack.monotonicMs,
        first_execution_started_ms: started.startedMonotonicMs } } };
}

export function correlateSizingWorkload(workload, events) {
  const gaps = [];
  const timings = [];
  const configuration = [];
  const result = {};
  for (const kind of ['uploads', 'vto']) {
    result[kind] = workload[kind].map(item => {
      const task = correlateSizingTask(item.resource_id, events);
      if (task.gap) { gaps.push({ resource_id: item.resource_id, reason: task.gap }); return item; }
      timings.push(task.timing);
      configuration.push({ case_id: item.case_id, ...task.provider_configuration });
      return { ...item, task_id: task.task_id, worker_task_arn: task.worker_task_arn,
        worker_process_instance: task.worker_process_instance, started_monotonic_ms: task.started_monotonic_ms,
        finished_monotonic_ms: task.finished_monotonic_ms,
        started_at: task.started_at, finished_at: task.finished_at };
    });
  }
  result.overlap = [];
  for (const intent of workload.overlap_intent) {
    const generation = result.vto.find(item => item.resource_id === intent.vto_resource_id);
    const upload = result.uploads.find(item => intent.upload_resource_ids.includes(item.resource_id)
      && item.worker_task_arn && item.worker_task_arn === generation.worker_task_arn
      && item.worker_process_instance === generation.worker_process_instance
      && Math.max(item.started_monotonic_ms, generation.started_monotonic_ms)
        < Math.min(item.finished_monotonic_ms, generation.finished_monotonic_ms));
    if (upload && generation.task_id) result.overlap.push({ upload_task_id: upload.task_id, vto_task_id: generation.task_id });
  }
  configuration.sort((a, b) => a.case_id.localeCompare(b.case_id));
  return { workload: result, task_timings: timings, gaps,
    provider_configuration: configuration, provider_configuration_sha256: hashBytes(JSON.stringify(configuration)) };
}
