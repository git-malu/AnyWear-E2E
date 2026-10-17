import { parseStrictJson } from './evidence-contract.mjs';

/**
 * The lifecycle `resume` request payload (issue #132).
 *
 * The Service requires a bounded window request on `resume`: it refuses before any write
 * when the payload is absent, is not exactly `{"window_minutes":n}`, or carries a minute
 * bound outside 15..240. The mirror then carries the resulting instant, which is why the
 * request states minutes and the record states an absolute bound — the Service owns the
 * clock, and this repository only names how long it wants.
 *
 * One constant and one builder live here so a drill cannot emit a bound the Service would
 * refuse, and the retained one-shot proof is only valid for the canonical bytes below.
 */

export const ADMISSION_WINDOW_MINUTES = Object.freeze({ default: 60, minimum: 15, maximum: 240 });

/** The canonical payload bytes for a `resume` request. */
export function admissionWindowPayload(minutes = ADMISSION_WINDOW_MINUTES.default) {
  if (!Number.isInteger(minutes) || minutes < ADMISSION_WINDOW_MINUTES.minimum || minutes > ADMISSION_WINDOW_MINUTES.maximum) {
    throw new Error(`Admission window payload requires an integer minute bound from ${ADMISSION_WINDOW_MINUTES.minimum} to ${ADMISSION_WINDOW_MINUTES.maximum}`);
  }
  return JSON.stringify({ window_minutes: minutes });
}

/**
 * The minute bound a payload requests, or `null` when the Service would refuse it.
 *
 * Rejection is structural and exact: one key, an integer inside the range, no duplicate
 * keys (through the strict parser), and the canonical serialization of that object. A
 * payload carrying anything else is not this request, and hashing non-canonical bytes
 * would bind a recovery to a request the Service never accepted.
 */
export function parseAdmissionWindowPayload(payload) {
  if (typeof payload !== 'string') return null;
  let record;
  try { record = parseStrictJson(payload); }
  catch { return null; }
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== 'window_minutes') return null;
  const minutes = record.window_minutes;
  if (!Number.isInteger(minutes) || minutes < ADMISSION_WINDOW_MINUTES.minimum || minutes > ADMISSION_WINDOW_MINUTES.maximum) return null;
  if (JSON.stringify(record) !== payload) return null;
  return minutes;
}
