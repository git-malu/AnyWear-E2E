import { isDeepStrictEqual } from 'node:util';
import { validateOneShotProof } from './runtime-one-shot.mjs';

export async function readOneShotLog(io, proof, source) {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const events = [];
    let token;
    for (let page = 0; page < 20; page += 1) {
      let response;
      try {
        response = await io.aws(['logs', 'get-log-events', '--log-group-name', proof.log_group,
          '--log-stream-name', proof.log_stream, '--start-from-head', ...(token ? ['--next-token', token] : [])]);
      } catch (error) {
        if (error.name !== 'ResourceNotFoundException') throw error;
        break;
      }
      events.push(...(response.events ?? []));
      if (!response.nextForwardToken || response.nextForwardToken === token) break;
      if (page === 19) throw new Error('One-shot log pagination incomplete');
      token = response.nextForwardToken;
    }
    const parsed = events.flatMap((event) => {
      try { return [JSON.parse(event.message)]; } catch { return []; }
    });
    const matches = parsed.filter((event) => event.source === source);
    if (matches.length > 1) throw new Error('One-shot log contains duplicate authoritative records');
    if (matches.length === 1) return { event: matches[0], events: parsed };
    if (attempt < 14) await io.sleep(2_000);
  }
  throw new Error('Exact one-shot log did not expose the authoritative committed record');
}

export function cleanupPayload(scope, { original = false } = {}) {
  return JSON.stringify({ runScope: scope.runScope, users: [{ sub: scope.subject, email: scope.email }],
    ...(scope.knownDLQMessageId && (original || !scope.knownDLQDeletionEvidence) ? { knownDLQMessageId: scope.knownDLQMessageId } : {}) });
}

export function validateKnownDLQDeletionEvidence(evidence, scope) {
  if (!scope.knownDLQMessageId) throw new Error('No original known DLQ binding');
  validateOneShotProof(evidence?.extraction, scope, 'tester-cleanup', cleanupPayload(scope, { original: true }), '', { requireSuccess: false });
  if (!isDeepStrictEqual(evidence.deletion, { schema_version: 1, source: 'beta-tester-dlq-cleanup',
    known_message: { ...scope.knownDLQMessageId, deleted: true } })) throw new Error('Irreversible DLQ deletion marker is foreign or missing');
  return evidence;
}

export function validateCleanupEvidence(evidence, scope, { requireSuccess = true } = {}) {
  validateOneShotProof(evidence?.extraction, scope, 'tester-cleanup', cleanupPayload(scope), '', { requireSuccess });
  const event = evidence.committed;
  const counters = ['users', 'missingUsers', 'tasks', 'outbox', 'idempotency', 'generations', 'relations', 'outfits', 'items', 'photos'];
  if (event?.schema_version !== 1 || event.source !== 'beta-tester-cleanup' || event.cleanup !== 'beta-testers'
    || event.run_scope !== scope.runScope || event.transaction_committed !== true || event.users + event.missingUsers !== 1
    || counters.some((name) => !Number.isInteger(event[name]) || event[name] < 0)
    || !Number.isInteger(event.dlq?.deleted) || event.dlq.deleted < 0
    || !Number.isInteger(event.dlq?.preserved) || event.dlq.preserved < 0) throw new Error('Tester cleanup lacks an exact committed transaction record');
  if (scope.knownDLQMessageId) {
    const known = { ...scope.knownDLQMessageId, deleted: true };
    if (scope.knownDLQDeletionEvidence) {
      validateKnownDLQDeletionEvidence(evidence.preceding_deletion, scope);
      if (!isDeepStrictEqual(evidence.preceding_deletion, scope.knownDLQDeletionEvidence)
        || evidence.deletion || event.dlq.known_message) throw new Error('Retried DB cleanup is not bound to the previously proven exact DLQ deletion');
    } else if (event.users !== 1 || event.dlq.deleted < 1 || !isDeepStrictEqual(event.dlq.known_message, known)
      || !isDeepStrictEqual(evidence.deletion, { schema_version: 1, source: 'beta-tester-dlq-cleanup', known_message: known })) {
      throw new Error('Known DLQ deletion is not bound to the exact committed cleanup/task/message');
    }
  } else if (event.dlq.known_message || evidence.deletion) throw new Error('Unexpected known DLQ deletion evidence');
  return evidence;
}

export async function collectCleanupEvidence(io, scope, operation, options) {
  const { event, events } = await readOneShotLog(io, operation.proof, 'beta-tester-cleanup');
  const deletions = events.filter((entry) => entry.source === 'beta-tester-dlq-cleanup');
  if (deletions.length > 1) throw new Error('Duplicate irreversible known DLQ deletion records');
  return validateCleanupEvidence({ committed: event, extraction: operation.proof,
    ...(deletions.length ? { deletion: deletions[0] } : {}),
    ...(scope.knownDLQDeletionEvidence ? { preceding_deletion: scope.knownDLQDeletionEvidence } : {}) }, scope, options);
}
