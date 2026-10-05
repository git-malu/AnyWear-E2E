import assert from 'node:assert/strict';
import test from 'node:test';
import { auditFixture, fencingCiFixture } from './fixtures/runtime-evidence.mjs';
import { assertStableAudits, extractAuditLog, extractAuditTaskBinding, TERMINAL_STABILITY_MS, validateTaskAudit } from './runtime-task-audit.mjs';
import { verifyFencingCiEvidence } from './runtime-fencing-evidence.mjs';

const request = { runScope: '123-1-aaaaaaaaaaaaaaaa',
  user: { sub: '123e4567-e89b-12d3-a456-426614174000', email: 'e2e-beta-123-1-aaaaaaaaaaaaaaaa-0-01234567@anywear.local' },
  taskId: '123e4567-e89b-12d3-a456-426614174001', itemId: '123e4567-e89b-12d3-a456-426614174002',
  idempotencyKey: '123e4567-e89b-12d3-a456-426614174003' };

test('audit binds exact task/user/resource/idempotency/current state and labels credit N/A', () => {
  assert.equal(validateTaskAudit(auditFixture(request), request, 'ready').credit.applicability, 'not-applicable');
  for (const mutate of [
    (audit) => { audit.binding.user.sub = 'foreign'; },
    (audit) => { audit.resource.item_id = 'foreign'; },
    (audit) => { audit.task.execution_token = 0; },
    (audit) => { audit.current_rows.same_resource_tasks = 2; },
    (audit) => { audit.credit.applicability = 'settled'; },
  ]) {
    const audit = structuredClone(auditFixture(request));
    mutate(audit);
    assert.throws(() => validateTaskAudit(audit, request, 'ready'), /validation/);
  }
});

test('one-shot extraction accepts only the exact Beta ECS task log stream and one audit JSON', () => {
  const id = 'a'.repeat(32);
  const stdout = `Task ARN: arn:aws:ecs:ap-east-1:650880818323:task/beta-anywear/${id}\nTask log group: /anywear/beta/one-shot\nTask log stream: beta-anywear-task-audit/OneShot/${id}\n`;
  assert.equal(extractAuditTaskBinding(stdout).logStream, `beta-anywear-task-audit/OneShot/${id}`);
  assert.throws(() => extractAuditTaskBinding(stdout.replace(id, 'b'.repeat(32))), /not exact/);
  assert.throws(() => extractAuditTaskBinding(`${stdout}${stdout}`), /one exact/);
  const event = { message: JSON.stringify(auditFixture(request)) };
  assert.equal(extractAuditLog([event], request).task.id, request.taskId);
  assert.throws(() => extractAuditLog([event, event], request), /one durable/);
});

test('delayed stability is finite current-state proof, never historical/stale/credit proof', () => {
  const before = auditFixture(request);
  const after = auditFixture(request, { after: true });
  const result = assertStableAudits(before, after);
  assert.equal(result.observation_window_ms, 440_000);
  assert.equal(result.late_stale_rejection_proven, false);
  assert.equal(result.missed_heartbeat_proven, false);
  assert.throws(() => assertStableAudits(before, { ...after, observed_at: before.observed_at }), /window/);
  assert.throws(() => assertStableAudits(before, { ...after, resource: { ...after.resource, state_version: 4 } }), /changed/);
  assert.throws(() => assertStableAudits(before, after, TERMINAL_STABILITY_MS - 1), /window/);
});

test('post-provider fencing proof is pinned to DB-enabled passing main CI with both exact assertions', () => {
  const sha = 'b'.repeat(40);
  assert.equal(verifyFencingCiEvidence(fencingCiFixture(sha), sha).binding.checked_out_commit, sha);
  for (const mutate of [
    (proof) => { proof.binding.event_name = 'pull_request'; },
    (proof) => { proof.binding.checked_out_commit = 'c'.repeat(40); },
    (proof) => { proof.binding.database_integration_enabled = false; },
    (proof) => { proof.results.testResults[0].assertionResults[0].status = 'pending'; },
    (proof) => { proof.results.testResults[0].assertionResults.pop(); },
  ]) {
    const proof = fencingCiFixture(sha);
    mutate(proof);
    assert.throws(() => verifyFencingCiEvidence(proof, sha), /CI|assertion/);
  }
});
