import {
  deleteCapturedCognitoIdentity,
  type CapturedIdentity,
  type CognitoCleanupIo,
} from './cognito-cleanup.ts';

interface WorkerAccountRecord {
  email: string;
  subject?: string;
  mode: 'worker' | 'ephemeral';
  status: string;
}

export interface WorkerAccountManifest {
  version: 1;
  runScope: string;
  accounts: WorkerAccountRecord[];
}

export interface ServiceCleanupInputs {
  action: 'cleanup';
  emails: '[]';
  cleanup_json: string;
}

export interface WorkerCleanupIo extends CognitoCleanupIo {
  // false means the dispatch command could not start a Service workflow. Once
  // dispatch succeeds, failures must reject and keep the lease retained.
  runServiceCleanup(inputs: ServiceCleanupInputs): Promise<boolean | void>;
}

export async function releaseWorkerLease(
  email: string,
  reserved: boolean,
  provisioned: boolean,
  markCleanupPending: (accountEmail: string) => Promise<void>,
): Promise<void> {
  if (reserved && provisioned) await markCleanupPending(email);
}

const RUN_SCOPE_PATTERN = /^[1-9][0-9]{0,19}-[1-9][0-9]{0,5}-[a-f0-9]{16}$/;
const SUBJECT_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const WORKER_EMAIL_PATTERN = /^e2e-beta-worker-[0-7]-chromium@anywear\.local$/;

export function createServiceCleanupInputs(manifest: WorkerAccountManifest): ServiceCleanupInputs | undefined {
  if (manifest.version !== 1 || !RUN_SCOPE_PATTERN.test(manifest.runScope) || !Array.isArray(manifest.accounts)) {
    throw new Error('E2E worker cleanup requires a valid bounded account manifest');
  }

  const activeWorkers = manifest.accounts.filter((account) => account.mode === 'worker' && account.status === 'cleanup_pending');
  if (activeWorkers.some((account) => !WORKER_EMAIL_PATTERN.test(account.email)
    || typeof account.subject !== 'string' || !SUBJECT_PATTERN.test(account.subject))) {
    throw new Error('E2E worker cleanup requires captured stable worker emails and subjects');
  }
  if (activeWorkers.length > 8
    || new Set(activeWorkers.map((account) => account.email)).size !== activeWorkers.length
    || new Set(activeWorkers.map((account) => account.subject?.toLowerCase())).size !== activeWorkers.length) {
    throw new Error('E2E worker cleanup manifest contains duplicate or excessive identities');
  }
  if (activeWorkers.length === 0) return undefined;

  const request = {
    runScope: manifest.runScope,
    users: activeWorkers.map(({ email, subject }) => ({ sub: subject as string, email })),
  };
  const cleanupJson = JSON.stringify(request);
  if (Buffer.byteLength(cleanupJson, 'utf8') > 16_384) {
    throw new Error('E2E worker cleanup payload exceeds the Service limit');
  }

  return { action: 'cleanup', emails: '[]', cleanup_json: cleanupJson };
}

export async function cleanupWorkerAccounts(
  manifest: WorkerAccountManifest,
  io: WorkerCleanupIo,
): Promise<number | undefined> {
  const inputs = createServiceCleanupInputs(manifest);
  if (!inputs) return 0;

  const dispatched = await io.runServiceCleanup(inputs);
  if (dispatched === false) return undefined;
  const identities: CapturedIdentity[] = JSON.parse(inputs.cleanup_json).users;
  for (const identity of identities) await deleteCapturedCognitoIdentity(identity, io);
  return identities.length;
}
