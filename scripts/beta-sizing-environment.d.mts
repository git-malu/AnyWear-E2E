export interface WorkerIdentityTask {
  task_arn: string;
  task_definition_arn: string | null;
  last_status: string | null;
  started_at: string | null;
}

export interface WorkerIdentity {
  schema_version: number;
  record_type: string;
  phase: 'before' | 'after';
  observed_at: string;
  account_id: string;
  region: string;
  cluster: string;
  service: string;
  task_definition_arn: string | null;
  desired_count: number;
  running_count: number;
  pending_count: number;
  deployment_ids: string[];
  rollout_states: string[];
  task_arns: string[];
  tasks: WorkerIdentityTask[];
  identity_sha256: string;
}

export const BETA_ACCOUNT_ID: string;
export const BETA_REGION: string;
export const BETA_CLUSTER: string;
export const BETA_WORKER_SERVICE: string;
export const ENVIRONMENT_SCHEMA_VERSION: number;
export const ENVIRONMENT_IDENTITY_PATHS: Readonly<Record<'before' | 'after', string>>;
export const ENVIRONMENT_VERDICT_PATH: string;
export const SIZING_WORKLOAD_PATH: string;
export const SIZING_TASK_RECOVERY_FLOOR_MS: Readonly<Record<'vto' | 'tagging', number>>;
export const SIZING_TASK_RECOVERY_BASIS: Record<string, unknown>;
export const SIZING_VTO_TERMINAL_WAIT_MS: number;
export const SIZING_TAGGING_TERMINAL_WAIT_MS: number;
export function assertTerminalWaitCoversRecoveryFloor(kind: string, waitMs: number): number;
export function terminalWaitMs(kind: 'vto' | 'tagging'): number;
export function workerIdentitySha256(identity: Partial<WorkerIdentity>): string;
export function workerIdentitySnapshot(
  aws: (args: string[]) => Record<string, unknown>,
  options?: { phase?: 'before' | 'after'; cluster?: string; service?: string },
): WorkerIdentity;
export function validateWorkerIdentity(record: unknown, options?: { phase?: 'before' | 'after' }): WorkerIdentity;
