import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { readQualificationTuple, requireQualificationTuplePath } from './qualification-record.mjs';
import { parseRuntimeRecovery } from './runtime-recovery.mjs';
import { validateRecoveryArtifactName, validateRecoverySourceInputs } from './runtime-recovery-snapshots.mjs';

export function validateRecoveryArtifactBinding(metadata, record, environment, tuple) {
  // Keep validating retained artifacts from the retired manual workflows without recreating their dispatch paths.
  validateRecoverySourceInputs(environment);
  const artifactName = validateRecoveryArtifactName(environment.SOURCE_ARTIFACT_NAME);
  const retainedOutcome = artifactName && /^beta-runtime-recovery-outcome-([1-9][0-9]*)-([1-9][0-9]*)$/.exec(artifactName);
  if (String(metadata.id) !== environment.SOURCE_RUN_ID
    || String(metadata.run_attempt) !== environment.SOURCE_RUN_ATTEMPT || metadata.event !== 'workflow_dispatch'
    || metadata.status !== 'completed'
    || metadata.head_branch !== 'main' || metadata.repository?.full_name !== 'git-malu/AnyWear-E2E'
    || !/^[a-f0-9]{40}$/.test(metadata.head_sha ?? '')
    || !['.github/workflows/runtime-drill.yml', '.github/workflows/runtime-recovery.yml'].includes(metadata.path)
    || record.run_scope !== environment.ORIGINAL_RUN_SCOPE || record.deployment.service.source_commit !== tuple.service.sha) {
    throw new Error('Recovery artifact is not bound to the exact protected main workflow/run/qualification tuple');
  }
  if (retainedOutcome && (String(metadata.id) !== retainedOutcome[1]
    || String(metadata.run_attempt) !== retainedOutcome[2]
    || metadata.path !== '.github/workflows/runtime-recovery.yml')) {
    throw new Error('Retained recovery outcome is not bound to its exact recovery workflow/run');
  }
  if (metadata.path.endsWith('/runtime-drill.yml')
    && record.run_scope !== `${metadata.id}-${metadata.run_attempt}-${metadata.head_sha.slice(0, 16)}`) throw new Error('Original drill artifact scope does not match its immutable workflow revision');
  return record;
}

function tupleArgument(argv) {
  const index = argv.indexOf('--tuple');
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error('--tuple requires a qualification-record.json path');
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    // The expected Service identity comes from the qualification record v3, named the same way
    // as the drill CLI: --tuple <path> or RUNTIME_DRILL_TUPLE. There is no committed tuple.
    const tuple = await readQualificationTuple(requireQualificationTuplePath({
      tuple: tupleArgument(process.argv.slice(2)),
      environment: process.env,
      label: 'Runtime recovery artifact binding',
    }));
    const metadata = JSON.parse(await readFile('recovery-source-run.json', 'utf8'));
    const record = parseRuntimeRecovery(await readFile('recovery-source/runtime-drill-recovery.json', 'utf8'));
    validateRecoveryArtifactBinding(metadata, record, process.env, tuple);
    console.log(JSON.stringify({ run_scope: record.run_scope, marker: record.marker, service_sha: record.deployment.service.source_commit, source_completed: true }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
