import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { repositories, requireCommit, requireString } from './evidence-contract.mjs';

const sourceRoot = fileURLToPath(new URL('..', import.meta.url));

// #163: the protected operations all run from the single `qualify` entry. The old
// workflow-file allow-list is replaced by an operation → entry map: an operation must be
// stated explicitly instead of being inferred from whichever file happened to dispatch,
// and every operation names the one entry that may serve it. Adding an operation to a
// different file therefore means changing this map, which is the reviewable point the
// allow-list used to be.
//
// #217: `reconcile` runs as a job of every qualification (before its suite) and as its own
// dispatched operation from the daily schedule. Both go through the same entry, so both
// carry `workflow_dispatch` and the exact protected workflow ref this guard requires. The
// manual `recover` operation was removed with the same change.
export const E2E_OPERATIONS = Object.freeze(['full', 'smoke', 'reconcile']);
const operationEntries = Object.freeze({
  full: 'beta-qualification',
  smoke: 'beta-qualification',
  reconcile: 'beta-qualification',
});

export function assertE2EExecution(environment = process.env, { sourceOnly = false, sourceSha } = {}) {
  if (environment.GITHUB_REPOSITORY !== repositories.e2e
    || environment.GITHUB_REPOSITORY_ID !== '1317091305'
    || environment.GITHUB_REPOSITORY_OWNER !== 'git-malu' || environment.GITHUB_REPOSITORY_OWNER_ID !== '11473072'
    || environment.GITHUB_REF !== 'refs/heads/main' || environment.GITHUB_EVENT_NAME !== 'workflow_dispatch'
    || environment.E2E_STAGE !== 'beta') throw new Error('E2E operations require the protected main Beta repository/owner dispatch');
  if (environment.ENABLE_BETA_MUTATION !== 'true') throw new Error('Beta mutation activation gate is closed');
  const operation = environment.E2E_OPERATION;
  if (!E2E_OPERATIONS.includes(operation)) throw new Error('E2E execution requires an explicit qualification operation');
  const entry = operationEntries[operation];
  const sha = requireCommit(environment.GITHUB_SHA, 'Current E2E revision');
  if (environment.GITHUB_WORKFLOW_SHA !== sha
    || environment.GITHUB_WORKFLOW_REF !== `${repositories.e2e}/.github/workflows/${entry}.yml@refs/heads/main`) {
    throw new Error('E2E execution requires an exact protected workflow/source');
  }
  const actual = sourceSha ?? execFileSync('git', ['--no-replace-objects', '-C', sourceRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (actual !== sha) throw new Error('E2E checkout does not match the dispatched workflow source');
  for (const name of ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT']) {
    if (!/^[1-9]\d*$/.test(requireString(environment[name], name)) || !Number.isSafeInteger(Number(environment[name]))) throw new Error('Invalid E2E run/attempt identity');
  }
  if (environment.AWS_ACCOUNT_ID !== '650880818323' || environment.AWS_REGION !== 'ap-east-1') throw new Error('Unexpected E2E account/region');
  requireCommit(environment.E2E_CLEANUP_SERVICE_SHA, 'Reviewed Service cleanup operator source');
  // Captured from STS immediately after the protected workflow assumes its
  // dedicated role. Source-only checks run before AWS credentials.
  if (!sourceOnly && (environment.E2E_AWS_ACCOUNT !== '650880818323'
    || !/^arn:aws:sts::650880818323:assumed-role\/beta-e2e-qualification-role\/[A-Za-z0-9+=,.@_-]{1,64}$/.test(environment.E2E_AWS_PRINCIPAL_ARN ?? ''))) {
    throw new Error('Authenticated dedicated E2E principal required');
  }
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.slice(2).some(argument => argument !== '--source-only') || process.argv.length > 3) throw new Error('Unknown E2E execution guard option');
  assertE2EExecution(process.env, { sourceOnly: process.argv.includes('--source-only') });
  console.log('Verified protected E2E Beta execution and exact source identity.');
}
