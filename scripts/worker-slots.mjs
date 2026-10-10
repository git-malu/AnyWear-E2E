export function workerSlotOffset(environment, workers) {
  const raw = environment.E2E_WORKER_SLOT_OFFSET ?? '0';
  if (!/^[0-6]$/.test(raw) || !Number.isInteger(workers) || workers < 1 || workers > 8 || Number(raw) + workers > 8) {
    throw new Error('E2E_WORKER_SLOT_OFFSET must be 0 through 6 and fit E2E_WORKERS within eight slots');
  }
  return Number(raw);
}
