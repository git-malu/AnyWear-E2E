import { byteHash, repositories } from '../evidence-contract.mjs';
import { ACCEPTANCE_WORKFLOW, BUDGET, acceptanceRequests } from '../cleanup-acceptance-contract.mjs';

export function cleanupAcceptanceFixture() {
  const source = 'a'.repeat(40), run = 42, attempt = 1;
  const producer = { repository: repositories.e2e, workflow_path: ACCEPTANCE_WORKFLOW, source_sha: source, run_id: run, run_attempt: attempt };
  const frozen = { service_source_sha: 'b'.repeat(40), service_image_digest: `sha256:${'c'.repeat(64)}`,
    state_machine_version_arn: 'arn:aws:states:ap-east-1:650880818323:stateMachine:beta-anywear-tester-cleanup:7', fixture_source_sha: 'd'.repeat(40),
    fixture_task_definition_arn: 'arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-cleanup-acceptance:7',
    selection_sha256: 'e'.repeat(64), stack_sources_sha256: 'f'.repeat(64) };
  const runScope = '42-1-1234567890abcdef';
  const identities = [2, 3].map(slot => ({ slot, email: `e2e-beta-worker-${slot}-chromium@anywear.local`,
    sub: `10000000-0000-4000-8000-00000000000${slot}`, username: `20000000-0000-4000-8000-00000000000${slot}`,
    lease_generation: `30000000-0000-4000-8000-00000000000${slot}`, create_started_at: '2026-10-10T00:00:40.000Z', captured_at: '2026-10-10T00:00:50.000Z' }));
  const intent = { schema_version: 1, record_type: 'anywear_e2e_cleanup_acceptance_creation_intent', issue: 86, producer,
    run_scope: runScope, account_budget_config: BUDGET, identities: identities.map(({ slot, email, lease_generation }) => ({ slot, email, lease_generation, preflight_absent: true })),
    created_at: '2026-10-10T00:00:20.000Z', frozen_tuple: frozen };
  const intentOrigin = { ...producer, artifact_id: 100, artifact_sha256: byteHash('intent-zip'), manifest_sha256: byteHash(JSON.stringify(intent)) };
  const bootstrap = { schema_version: 1, record_type: 'anywear_e2e_cleanup_acceptance_bootstrap', issue: 86, phase: 'bootstrap', result: 'captured-identities-retained',
    producer, run_scope: runScope, account_budget_config: BUDGET, intent_origin: intentOrigin, identities, ...acceptanceRequests(runScope, identities), frozen_tuple: frozen };
  const origin = { ...producer, artifact_id: 200, artifact_sha256: byteHash('bootstrap-zip'), manifest_sha256: byteHash(JSON.stringify(bootstrap)) };
  const intentBudget = { version: 1, runScope, config: BUDGET, accounts: identities.map((identity, index) => ({ email: identity.email, mode: 'worker', status: 'provisioning',
    leaseId: `40000000-0000-4000-8000-00000000000${index}`, leaseGeneration: identity.lease_generation,
    createdAt: '2026-10-10T00:00:10.000Z', updatedAt: '2026-10-10T00:00:10.000Z' })) };
  const budget = structuredClone(intentBudget);
  budget.accounts.forEach((row, index) => { row.subject = identities[index].sub; row.status = 'cleanup_pending'; });
  const repository = { full_name: repositories.e2e, id: 1317091305, owner: { id: 11473072, login: 'git-malu' } };
  const metadataRun = { id: run, run_attempt: attempt, repository, head_repository: repository, path: ACCEPTANCE_WORKFLOW,
    head_sha: source, head_branch: 'main', event: 'workflow_dispatch', status: 'completed', conclusion: 'success',
    created_at: '2026-10-10T00:00:00.000Z', run_started_at: '2026-10-10T00:00:00.000Z', updated_at: '2026-10-10T00:02:00.000Z' };
  const metadataArtifact = { id: 200, name: 'beta-cleanup-acceptance-bootstrap-42-1', digest: `sha256:${origin.artifact_sha256}`,
    expired: false, size_in_bytes: 1000, expires_at: '2027-01-01T00:00:00Z', created_at: '2026-10-10T00:01:00.000Z',
    workflow_run: { id: run, head_sha: source, head_branch: 'main', repository_id: 1317091305, head_repository_id: 1317091305 } };
  return { origin, intentOrigin, intent, bootstrap, intentBudget, budget, metadataRun, metadataArtifact };
}
