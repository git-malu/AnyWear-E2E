/**
 * Beta synthetic worker addresses (issue #129).
 *
 * The Beta worker address used to be the fixed allowlist row
 * `e2e-beta-worker-{slot}-chromium@anywear.local`. Every retry of one worker
 * therefore re-bound that same address to a fresh Cognito subject, and the
 * Service's first profile sync refused the second binding with 409 `CONFLICT`
 * ("Email is already provisioned to a different Cognito user") because the
 * address was still owned by the earlier subject. A run/attempt-scoped address
 * is never-before-bound, so the first profile sync inserts cleanly.
 *
 * The scoped shape is not invented here. The Service's own cleanup parser
 * accepts `^e2e-beta-${runScope}-[0-9]+-[a-f0-9]{8}@anywear\.local$`
 * (`AnyWear-Service/src/ops/beta-tester-cleanup.ts`), and the deployed runtime
 * drill already mints `e2e-beta-${runScope}-0-[a-f0-9]{8}@anywear\.local`
 * (`scripts/runtime-identity-creation.mjs`). This module states that grammar
 * once, so allocation and every captured-identity consumer cannot drift apart.
 *
 * The two stable allowlist rows are no longer required by any admission check: the
 * E2E admission-eligibility pre-flight requires an open admission window and the tester
 * list's own validity, not any membership. Removing them from the live allowlist is a Beta
 * mutation outside this work.
 * They are only ever accepted here as *historical* artifacts: an account
 * manifest written before this change still names them, and account recovery
 * still has to delete the identities they left in Cognito.
 */

/** The Service's run-scope grammar, which its cleanup parser matches byte-for-byte. */
const RUN_SCOPE_SOURCE = '[1-9][0-9]{0,19}-[1-9][0-9]{0,5}-[a-f0-9]{16}';

export const BETA_RUN_SCOPE_PATTERN = new RegExp(`^${RUN_SCOPE_SOURCE}$`);

/** The retained Beta tester allowlist rows' family. No attempt address is built from it. */
export const STABLE_WORKER_EMAIL_PATTERN = /^e2e-beta-worker-[0-7]-chromium@anywear\.local$/;

/** The scoped family with its run scope still embedded and unbound. */
export const SCOPED_WORKER_EMAIL_PATTERN = new RegExp(`^e2e-beta-${RUN_SCOPE_SOURCE}-[0-7]-[a-f0-9]{8}@anywear\\.local$`);

/** The Service refuses a captured cleanup identity whose local part exceeds this. */
export const MAX_ADDRESS_LOCAL_PART_LENGTH = 64;

function quoted(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The scoped family bound to one exact run scope.
 *
 * Binding the address to the manifest's own run scope is what makes a captured
 * identity attributable: the Service matches the same scope in the cleanup
 * request, so an address from another run can never be cleaned up as this one.
 */
export function scopedWorkerEmailPattern(runScope: string): RegExp {
  return new RegExp(`^e2e-beta-${quoted(runScope)}-[0-7]-[a-f0-9]{8}@anywear\\.local$`);
}

/** A captured Beta worker address without binding it to one run scope. */
export function isCapturedBetaWorkerEmail(email: string): boolean {
  return STABLE_WORKER_EMAIL_PATTERN.test(email) || SCOPED_WORKER_EMAIL_PATTERN.test(email);
}

/** A captured Beta worker address for this run scope, or a retained stable row. */
export function isBetaWorkerEmailForScope(email: string, runScope: string): boolean {
  return STABLE_WORKER_EMAIL_PATTERN.test(email) || scopedWorkerEmailPattern(runScope).test(email);
}

/**
 * One attempt's address.
 *
 * `suffix` is the attempt's fresh randomizer, and it is the whole point: the
 * address must never have been bound before, so it is deliberately not derived
 * from the slot, the retry index or anything else the next attempt could repeat.
 * The scope is carried verbatim — not truncated or sanitized — because the
 * Service requires its exact cleanup run scope, and an identity the cleanup
 * capability cannot address would be unrecoverable.
 */
export function betaWorkerAddress(runScope: string, slot: string, suffix: string): string {
  if (!BETA_RUN_SCOPE_PATTERN.test(runScope)) {
    throw new Error(`Beta worker addresses require a Service-cleanable run scope (E2E_ACCOUNT_RUN_SCOPE): ${runScope}`);
  }
  if (!/^[0-7]$/.test(slot)) throw new Error(`Beta worker slot must be a single digit 0 through 7: ${slot}`);
  if (!/^[a-f0-9]{8}$/.test(suffix)) throw new Error(`Beta worker address suffix must be eight lowercase hex characters: ${suffix}`);
  const localPart = `e2e-beta-${runScope}-${slot}-${suffix}`;
  if (localPart.length > MAX_ADDRESS_LOCAL_PART_LENGTH) {
    throw new Error(`Beta worker address exceeds the Service local-part limit: ${localPart}`);
  }
  return `${localPart}@anywear.local`;
}
