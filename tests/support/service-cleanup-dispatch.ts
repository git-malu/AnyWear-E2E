import type { ServiceCleanupInputs } from './worker-cleanup.js';

export function serviceCleanupDispatchArgs(inputs: ServiceCleanupInputs): string[] {
  return [
    'workflow', 'run', 'beta-testers.yml',
    '--repo', 'git-malu/AnyWear-Service',
    '--ref', 'main',
    '--raw-field', `action=${inputs.action}`,
    '--raw-field', `emails=${inputs.emails}`,
    '--raw-field', `cleanup_json=${inputs.cleanup_json}`,
  ];
}

export interface ServiceWorkflowRun {
  databaseId: number;
  createdAt: string;
  event: string;
  headBranch: string;
  workflowName: string;
  displayTitle: string;
}

export function findServiceCleanupRunId(runs: ServiceWorkflowRun[], dispatchedAt: string): string | undefined {
  const boundary = Date.parse(dispatchedAt);
  if (!Number.isFinite(boundary)) throw new Error('Service cleanup dispatch timestamp is invalid');
  const candidates = runs.filter((run) => run.workflowName === 'Manage Beta Tester Allowlist'
    && run.event === 'workflow_dispatch' && run.headBranch === 'main'
    && /^Beta tester allowlist: cleanup · @.+$/.test(run.displayTitle)
    && Number.isInteger(run.databaseId) && Date.parse(run.createdAt) >= boundary);
  if (candidates.length > 1) {
    throw new Error('Multiple Service workflow runs match cleanup dispatch; Cognito identities were retained');
  }
  return candidates.length === 1 ? String(candidates[0].databaseId) : undefined;
}

export interface ServiceCleanupRunMetadata {
  id: number;
  run_attempt: number;
  repository: { full_name: string };
  path: string;
  head_sha: string;
  head_branch: string;
  event: string;
  status: string;
  conclusion: string | null;
}

export function assertServiceCleanupRunSource(run: ServiceCleanupRunMetadata, expectedSha: string, expectedAttempt?: number): number {
  if (!/^[a-f0-9]{40}$/.test(expectedSha) || run.repository?.full_name !== 'git-malu/AnyWear-Service'
    || run.path !== '.github/workflows/beta-testers.yml' || run.head_sha !== expectedSha
    || run.head_branch !== 'main' || run.event !== 'workflow_dispatch'
    || !Number.isSafeInteger(run.id) || run.id < 1 || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1
    || expectedAttempt !== undefined && run.run_attempt !== expectedAttempt) {
    throw new Error('Service cleanup operator source/run/attempt does not match the reviewed data window');
  }
  return run.run_attempt;
}
