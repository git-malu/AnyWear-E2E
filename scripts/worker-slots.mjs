/**
 * The eight-address Beta worker pool and the slot arithmetic (issue #213).
 *
 * Beta registration admits exactly the addresses on the tester allowlist. E2E
 * therefore cannot mint a fresh address per attempt any more: every attempt takes
 * one of the eight stable addresses the allowlist reserves for the harness, and a
 * slot is the address's index in that pool. The offset is an operator allocation
 * input, so it is validated here — before any address exists — instead of being
 * allowed to wrap into an address the allowlist never lists.
 */

export const WORKER_POOL_SIZE = 8;

/** The only address family an attempt may lease. */
export const WORKER_ADDRESS_SOURCE = 'e2e-beta-worker-[0-7]-chromium@anywear\\.local';
export const WORKER_ADDRESS_PATTERN = new RegExp(`^${WORKER_ADDRESS_SOURCE}$`);

export const WORKER_POOL_ADDRESSES = Object.freeze(
  Array.from({ length: WORKER_POOL_SIZE }, (_, slot) => `e2e-beta-worker-${slot}-chromium@anywear.local`),
);

/**
 * The first pool slot this run may use.
 *
 * `workers` is the configured Playwright parallel width. The offset plus the
 * width must fit inside the pool, so a run can never be handed a slot outside the
 * eight listed addresses. `raw` is matched as one canonical digit: `''`, `'-1'`,
 * `'1.5'`, `'02'`, `'1e0'` and `'8'` all fail instead of being coerced.
 */
export function workerSlotOffset(environment, workers) {
  const raw = environment.E2E_WORKER_SLOT_OFFSET ?? '0';
  if (!/^[0-7]$/.test(raw)
    || !Number.isInteger(workers) || workers < 1 || workers > WORKER_POOL_SIZE
    || Number(raw) + workers > WORKER_POOL_SIZE) {
    throw new Error(`E2E_WORKER_SLOT_OFFSET must be an integer 0 through ${WORKER_POOL_SIZE - 1} and fit ${WORKER_POOL_SIZE} slots with E2E_WORKERS`);
  }
  return Number(raw);
}

/** One pool address, by slot. Any other slot is a configuration error. */
export function workerPoolAddress(slot) {
  if (!Number.isInteger(slot) || slot < 0 || slot >= WORKER_POOL_SIZE) {
    throw new Error(`Beta worker-pool slot must be an integer 0 through ${WORKER_POOL_SIZE - 1}: ${slot}`);
  }
  return WORKER_POOL_ADDRESSES[slot];
}

/**
 * Every address one run with `workers` parallel attempts and this offset can
 * lease. The qualification pre-flight requires that all of them are allowlisted
 * before the first account exists.
 */
export function leaseableWorkerAddresses(environment, workers) {
  const offset = workerSlotOffset(environment, workers);
  return Array.from({ length: workers }, (_, index) => workerPoolAddress(offset + index));
}
