import assert from 'node:assert/strict';
import test from 'node:test';
import { correlateSizingTask } from './beta-sizing-telemetry.mjs';
import { loadSizingFixtures, sizingUploadCases, sizingVtoCases } from './beta-sizing-workload.mjs';

function logs() {
  const common = { taskId: 'task', workerTaskArn: 'worker', processInstance: 'process', serviceSha: 'b'.repeat(40),
    observedAt: '2026-10-10T00:01:00Z', monotonicMs: 800, workerId: 'worker-process' };
  return [
    { ...common, event: 'task_acceptance_precommit', resourceId: 'resource', workerTaskArn: 'api', processInstance: 'api' },
    { ...common, event: 'outbox_causal_snapshot', taskId: undefined, startedMonotonicMs: 100, complete: true,
      cap: 256, statementTimeoutMs: 200, ids: ['existing'], querySemantics: 'unfiltered-immutable-outbox-ids-read-committed' },
    { ...common, event: 'task_outbox_send_started', outboxId: 'outbox', attemptCount: 1,
      absentSnapshotStartedMonotonicMs: 100, monotonicMs: 600 },
    { ...common, event: 'task_outbox_send_acknowledged', outboxId: 'outbox', awsRequestId: 'request', monotonicMs: 900 },
    { ...common, event: 'task_execution_started', executionToken: 1, startedMonotonicMs: 750, monotonicMs: 750 },
    { ...common, event: 'provider_configuration', model: 'model', provider: 'tagging' },
    { ...common, event: 'task_processing_timing', executionToken: 1, outcome: 'completed', localProcessingMs: 100, providerMs: 1000 },
  ];
}

test('correlates first execution on one Worker clock even when it starts before SQS ACK', () => {
  const result = correlateSizingTask('resource', logs());
  assert.equal(result.gap, undefined);
  assert.equal(result.timing.queue.kind, 'same-worker-causal-bounds');
  assert.equal(result.timing.queue.first_execution_started_ms, 750);
  assert.equal(result.timing.queue.send_acknowledged_ms, 900);
  assert.match(result.timing.queue.clock_evidence_sha256, /^[a-f0-9]{64}$/);
});

test('missing/truncated absence proof, re-publication, retries and process changes stay unavailable', () => {
  for (const alter of [events => { events[1].complete = false; },
    events => { events[1].ids.push('outbox'); }, events => { events[2].attemptCount = 2; },
    events => { events[4].processInstance = 'other'; }, events => { events.push(events[3]); },
    events => { events[4].startedMonotonicMs = 500; }, events => { events.splice(1, 1); }]) {
    const events = logs(); alter(events);
    assert.ok(correlateSizingTask('resource', events).gap);
  }
});

test('freezes valid representative image bytes and exactly 24 uploads / ten VTO shapes', async () => {
  const frozen = await loadSizingFixtures(new URL('../tests/fixtures/beta-sizing/', import.meta.url));
  const uploads = sizingUploadCases();
  assert.equal(uploads.length, 24);
  assert.equal(new Set(uploads.map(item => item.case_id)).size, 24);
  for (const item of uploads) assert.ok(frozen.fixtures.has(item.fixture));
  for (const mime of ['image/jpeg', 'image/png', 'image/webp']) {
    for (const size of ['ordinary', 'near-supported-limit']) {
      for (const mode of ['sequential', 'burst']) {
        const cases = uploads.filter(item => item.size_class === size && item.submission === mode
          && frozen.fixtures.get(item.fixture).mime === mime);
        assert.equal(cases.length, 2);
        if (size === 'near-supported-limit') for (const item of cases) assert.ok(frozen.fixtures.get(item.fixture).bytes >= 9_000_000);
      }
    }
  }
  const vto = sizingVtoCases();
  assert.equal(vto.length, 10);
  assert.equal(vto.filter(item => item.garment_count === 5 && item.advanced_settings.size === '4K').length, 2);
});
