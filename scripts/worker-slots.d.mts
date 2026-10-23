export const WORKER_POOL_SIZE: 8;
export const WORKER_ADDRESS_SOURCE: string;
export const WORKER_ADDRESS_PATTERN: RegExp;
export const WORKER_POOL_ADDRESSES: readonly string[];
export function workerSlotOffset(environment: NodeJS.ProcessEnv, workers: number): number;
export function workerPoolAddress(slot: number): string;
export function leaseableWorkerAddresses(environment: NodeJS.ProcessEnv, workers: number): string[];
