import { parseStrictJson } from './evidence-contract.mjs';

/**
 * Beta admission is one SSM parameter carrying one small record (issue #132).
 *
 * `/anywear/beta/admission_mode` replaces the `admission_suspended` and `intake_open`
 * boolean pair. Its value is `{"mode":"closed"}` or
 * `{"mode":"testers","expires_at":"<ISO-8601 UTC instant>"}`. The bound travels inside
 * the record, so a reader enforces expiry instead of remembering it: an abandoned
 * window closes itself on every surface that reads this parameter.
 *
 * `/anywear/beta/tester_allowlist` is unchanged and is the only other admission
 * parameter this repository reads.
 */

export const ADMISSION_MODE_PARAMETER = '/anywear/beta/admission_mode';
export const TESTER_ALLOWLIST_PARAMETER = '/anywear/beta/tester_allowlist';

/** The longest window a writer may set, plus the read's one-minute clock-skew allowance. */
export const ADMISSION_WINDOW_CEILING_MS = 240 * 60_000;
export const ADMISSION_WINDOW_SKEW_MS = 60_000;

/** The exact key set each declared mode carries; an extra key is not this record. */
/** The exact key set each declared mode carries, and the only two accepted mode words. */
const MODE_KEYS = { closed: ['mode'], testers: ['mode', 'expires_at'] };
const MODE_VALUES = ['closed', 'testers'];

/**
 * The record's declared mode, or `null` when no reader would accept the record.
 *
 * Rejection is structural: JSON validity (through the strict parser, which refuses
 * duplicate keys that `JSON.parse` would silently collapse to the last one), object
 * shape, a mode that is *one of the two strings*, the exact key set for that mode, the
 * canonical serialization, and an instant in the exact canonical form the writer emits.
 *
 * Two rules carry more weight than they look:
 *
 * - The mode is matched by value, never by property-key lookup. A key lookup coerces its
 *   operand, so `{"mode":["testers"],…}` would index the `testers` key and be accepted as
 *   open, and `{"mode":{"toString":0},…}` would throw `TypeError` out of a check that is
 *   supposed to refuse. `MODE_VALUES.includes(record.mode)` uses strict equality, so a
 *   non-string mode is refused with no coercion at all.
 * - `JSON.stringify(record) === value` is the canonical-bytes rule the Service reader and
 *   the Infra reader both apply. It refuses whitespace, trailing bytes, escaped spellings
 *   such as `"test\u0065rs"`, and reordered keys in one rule instead of four.
 *
 * `Date.parse` alone is not enough either: it accepts date-only values, slashes, naive
 * timestamps read in the reader's own zone, and impossible dates that roll over (for
 * example `2030-02-30T00:00:00.000Z`). Round-tripping through `toISOString` proves both
 * the syntax and that the calendar fields are real.
 *
 * Whether a declared `testers` window is still inside its bound is a separate question
 * that `effectiveAdmissionMode` answers, because a well-formed record can already be
 * past it.
 */
export function parseAdmissionMode(value) {
  // A reader refuses; it must never crash. A thrown `TypeError` out of the pre-flight
  // reads as a broken check rather than a closed environment, so any unexpected shape
  // still ends as `null`.
  try { return readAdmissionMode(value); }
  catch { return null; }
}

function readAdmissionMode(value) {
  if (typeof value !== 'string') return null;
  let record;
  try { record = parseStrictJson(value); }
  catch { return null; }
  if (!record || typeof record !== 'object') return null;
  if (!MODE_VALUES.includes(record.mode)) return null;
  const expected = MODE_KEYS[record.mode];
  const keys = Object.keys(record);
  if (keys.length !== expected.length || expected.some((key) => !keys.includes(key))) return null;
  if (JSON.stringify(record) !== value) return null;
  if (record.mode === 'closed') return { mode: 'closed' };
  const instant = record.expires_at;
  if (typeof instant !== 'string') return null;
  const expiresAtMs = Date.parse(instant);
  if (!Number.isFinite(expiresAtMs) || new Date(expiresAtMs).toISOString() !== instant) return null;
  return { mode: 'testers', expires_at: instant, expires_at_ms: expiresAtMs };
}

/**
 * The admission decision this record yields at `now`, applying every fail-closed rule.
 *
 * Anything that is not exactly a well-formed `testers` record whose bound is strictly
 * ahead and inside the ceiling plus the read's skew allowance reads as `closed`. The
 * mirror therefore needs no writer, grant or deployment to stop admitting work: the
 * instant passing is enough. This is also the decision every service gate uses and the
 * one an operator sees, so it is what a drift check must compare.
 */
export function effectiveAdmissionMode(value, now = Date.now()) {
  const declared = parseAdmissionMode(value);
  if (!declared || declared.mode !== 'testers') return { mode: 'closed' };
  const remaining = declared.expires_at_ms - now;
  if (remaining <= 0 || remaining > ADMISSION_WINDOW_CEILING_MS + ADMISSION_WINDOW_SKEW_MS) return { mode: 'closed' };
  return { mode: 'testers', expires_at: declared.expires_at };
}
