/**
 * Issue 86 follow-on: per-attempt business-cleanup declaration.
 *
 * One test attempt owns one lease, one identity and one Service cleanup
 * operation. The operation's owner (`DirectTeardown`) knows whether the
 * attempt's business cleanup committed; the attempt's `workerAccount` fixture
 * teardown, which runs after the attempt's `afterEach` hooks, is what decides
 * whether that identity may be deleted and the address released. This module is
 * the explicit handoff between the two, and nothing else.
 *
 * The key is the Playwright `TestInfo` object of the attempt, held in a
 * `WeakMap`: the key *is* the attempt identity, so no recomputed key (email,
 * test name or lease generation) can drift between writer and reader, and no
 * entry outlives the attempt that wrote it. A record is written only by the
 * attempt that owns it, and the fixture only ever reads the record for its own
 * `TestInfo`.
 *
 * Absence is not success. A missing record means the attempt declared nothing,
 * which is an anomaly rather than evidence that it created no business
 * resources, so the reader reports `undeclared` and the lease disposition fails
 * closed. `declareNoBusinessCleanup` is the deliberate, auditable opt-out for an
 * attempt that provably owns no business resources.
 *
 * This is local test-process state: it routes the lease and never participates
 * in a deletion, release or Service decision by itself.
 */

/** The outcome vocabulary of one attempt's business cleanup. */
export type AttemptTeardownResult = 'passed' | 'failed' | 'partial';

/**
 * `open` means the attempt bound a business cleanup that never reached a
 * terminal acknowledgement; `none` means the attempt declared that it owns no
 * business resources; `undeclared` means it declared nothing at all.
 */
export type AttemptBusinessCleanupState = 'open' | 'closed' | 'none' | 'undeclared';

export interface AttemptBusinessCleanupDeclaration {
  /** The allowlisted address the declaring attempt leased. */
  email: string;
  state: AttemptBusinessCleanupState;
  teardownResult?: AttemptTeardownResult;
  /** Sanitized, single-line, bounded; safe to carry into a quarantine record. */
  reason?: string;
}

/** The lease decision only needs the declaration; the address is already known. */
export type AttemptBusinessCleanupOutcome = Omit<AttemptBusinessCleanupDeclaration, 'email'>;

/**
 * The identity of one test attempt. The registry never inspects the key, it only
 * compares it by identity, so a Playwright `TestInfo` and a test double are both
 * valid keys.
 */
export type AttemptKey = object;

/** Bounded so a Service or Cognito message can never enlarge a quarantine record. */
const MAX_REASON_LENGTH = 300;

interface AttemptCleanupRecord {
  email: string;
  state: 'open' | 'closed' | 'none';
  teardownResult?: AttemptTeardownResult;
  reason?: string;
}

// No mutable module-level Map and no generation key: entries live exactly as
// long as the attempt that owns them, so nothing can leak across tests or
// misroute a later attempt.
const records = new WeakMap<AttemptKey, AttemptCleanupRecord>();

/** One line, whitespace collapsed, bounded. */
function sanitizedReason(reason: string): string {
  return reason.replace(/\s+/g, ' ').trim().slice(0, MAX_REASON_LENGTH);
}

/** The attempt owns business cleanup; the record is open until it closes. */
export function bindAttemptBusinessCleanup(testInfo: AttemptKey, email: string): void {
  records.set(testInfo, { email, state: 'open' });
}

/**
 * Terminal business-cleanup outcome for the attempt. Last writer wins, so
 * `acknowledge()` (which `finalize()` calls) may close a record that `finalize()`
 * left open; a throw before this call leaves the record `open` and the lease
 * fails closed.
 */
export function closeAttemptBusinessCleanup(
  testInfo: AttemptKey,
  outcome: { teardownResult: AttemptTeardownResult; reason?: string },
): void {
  const existing = records.get(testInfo);
  if (!existing) return;
  existing.state = 'closed';
  existing.teardownResult = outcome.teardownResult;
  if (outcome.reason) existing.reason = sanitizedReason(outcome.reason);
  else delete existing.reason;
}

/**
 * Explicit opt-out for an attempt that provably creates no business resources.
 * The declaration carries the outcome it is standing in for, so the lease reason
 * stays auditable at the call site.
 */
export function declareNoBusinessCleanup(
  testInfo: AttemptKey,
  outcome: { teardownResult: AttemptTeardownResult; reason: string },
): void {
  records.set(testInfo, {
    email: '',
    state: 'none',
    teardownResult: outcome.teardownResult,
    reason: sanitizedReason(outcome.reason),
  });
}

/**
 * Read the declaration for one attempt. A missing record is `undeclared` — never
 * an implicit "created nothing".
 */
export function readAttemptBusinessCleanup(testInfo: AttemptKey): AttemptBusinessCleanupDeclaration {
  const record = records.get(testInfo);
  if (!record) return { email: '', state: 'undeclared' };
  return {
    email: record.email,
    state: record.state,
    ...(record.teardownResult ? { teardownResult: record.teardownResult } : {}),
    ...(record.reason ? { reason: record.reason } : {}),
  };
}
