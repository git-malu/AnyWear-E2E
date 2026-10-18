import { parseStrictJson } from './evidence-contract.mjs';

/**
 * Beta admission is one SSM parameter carrying one small record (issues #132 and #159).
 *
 * `/anywear/beta/admission_mode` replaces the `admission_suspended` and `intake_open`
 * boolean pair. Its value is exactly `{"mode":"closed"}` or `{"mode":"testers"}`.
 *
 * The record is windowless: there is no bound, expiry or clock in an admission decision.
 * A `testers` record admits until an explicit close writes `closed`; nothing closes it by
 * time passing. The record's exact key set, canonical bytes and duplicate-key rejection
 * are what a reader enforces.
 *
 * `/anywear/beta/tester_allowlist` is a separate parameter and the only other admission
 * parameter this repository reads.
 */

export const ADMISSION_MODE_PARAMETER = '/anywear/beta/admission_mode';
export const TESTER_ALLOWLIST_PARAMETER = '/anywear/beta/tester_allowlist';

/** The exact key set each declared mode carries; an extra key is not this record. */
const MODE_KEYS = { closed: ['mode'], testers: ['mode'] };
/** The only two accepted mode words. */
const MODE_VALUES = ['closed', 'testers'];

/**
 * The record's declared mode, or `null` when no reader would accept the record.
 *
 * Rejection is structural: JSON validity (through the strict parser, which refuses
 * duplicate keys that `JSON.parse` would silently collapse to the last one), object
 * shape, a mode that is *one of the two strings*, the exact key set for that mode, and
 * the canonical serialization. There is nothing time-shaped to validate: the legacy
 * two-key record that carried `expires_at` is not a reader-valid record.
 *
 * Two rules carry more weight than they look:
 *
 * - The mode is matched by value, never by property-key lookup. A key lookup coerces its
 *   operand, so `{"mode":["testers"]}` would index the `testers` key and be accepted as
 *   open, and `{"mode":{"toString":0}}` would throw `TypeError` out of a check that is
 *   supposed to refuse. `MODE_VALUES.includes(record.mode)` uses strict equality, so a
 *   non-string mode is refused with no coercion at all.
 * - `JSON.stringify(record) === value` is the canonical-bytes rule the Service reader and
 *   the Infra reader both apply. It refuses whitespace, trailing bytes, escaped spellings
 *   such as `"test\u0065rs"`, and reordered keys in one rule instead of four.
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
  return { mode: record.mode };
}

/**
 * The admission decision this record yields, applying every fail-closed rule.
 *
 * There is no clock and no bound to apply: a well-formed `testers` record admits work
 * until an explicit close writes `closed`. Anything that is not exactly a well-formed
 * record reads as `closed`. This is also the decision every service gate uses and the
 * one an operator sees, so it is what a drift check must compare.
 */
export function effectiveAdmissionMode(value) {
  const declared = parseAdmissionMode(value);
  return declared ? { mode: declared.mode } : { mode: 'closed' };
}
