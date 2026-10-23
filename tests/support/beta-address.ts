/**
 * Beta worker addresses (issues #129, #137 and #213).
 *
 * Beta registration is gated by the exact tester allowlist, so an E2E attempt may
 * only use an address the allowlist already lists. The harness therefore leases
 * from the eight stable pool addresses declared in `scripts/worker-slots.mjs`
 * (`e2e-beta-worker-0-chromium@anywear.local` … `-7-`), which is also the
 * Service's retirable worker family. A stable address is reused by its slot's
 * next attempt; issue #137's release/adopt contract, not a fresh address, is what
 * lets that reuse provision cleanly after a stale profile row.
 *
 * A pre-#129 account manifest still names run-scoped addresses
 * (`e2e-beta-<runScope>-<slot>-<8 hex>@anywear.local`). The Service's cleanup
 * parser accepts both families, so captured-identity deletion must keep
 * accepting them: the reconcile operation still has to delete a historical
 * identity a manifest names. No attempt address is built from the scoped family
 * any more, and the address never carries the creating run (#217).
 */

import { WORKER_ADDRESS_PATTERN } from '../../scripts/worker-slots.mjs';

export { WORKER_POOL_ADDRESSES, WORKER_POOL_SIZE, workerPoolAddress } from '../../scripts/worker-slots.mjs';

/** The Service's run-scope grammar, which its cleanup parser matches byte-for-byte. */
const RUN_SCOPE_SOURCE = '[1-9][0-9]{0,19}-[1-9][0-9]{0,5}-[a-f0-9]{16}';

/** The eight stable pool rows; the only family a new attempt may lease. */
export const STABLE_WORKER_EMAIL_PATTERN = WORKER_ADDRESS_PATTERN;

/** The historical run-scoped family with its run scope still embedded and unbound. */
export const SCOPED_WORKER_EMAIL_PATTERN = new RegExp(`^e2e-beta-${RUN_SCOPE_SOURCE}-[0-7]-[a-f0-9]{8}@anywear\\.local$`);

function quoted(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The historical scoped family bound to one exact run scope.
 *
 * Binding the address to the manifest's own run scope is what makes a captured
 * historical identity attributable: the Service matches the same scope in the
 * cleanup request, so an address from another run can never be cleaned up as this
 * one. A stable pool row is scope-free and is accepted by both predicates.
 */
export function scopedWorkerEmailPattern(runScope: string): RegExp {
  return new RegExp(`^e2e-beta-${quoted(runScope)}-[0-7]-[a-f0-9]{8}@anywear\\.local$`);
}

/** A captured Beta worker address: a stable pool row, or a historical scoped one. */
export function isCapturedBetaWorkerEmail(email: string): boolean {
  return STABLE_WORKER_EMAIL_PATTERN.test(email) || SCOPED_WORKER_EMAIL_PATTERN.test(email);
}

/** A captured Beta worker address for this run scope, or a stable pool row. */
export function isBetaWorkerEmailForScope(email: string, runScope: string): boolean {
  return STABLE_WORKER_EMAIL_PATTERN.test(email) || scopedWorkerEmailPattern(runScope).test(email);
}
