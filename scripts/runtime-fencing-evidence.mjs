import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const FENCING_CASES = [
  'rejects old auto-tagging results after provider completion and preserves the current terminal state',
  'rejects old VTO publication after provider completion before authoritative S3 copy',
];

export function verifyFencingCiEvidence(evidence, serviceCommit) {
  const binding = evidence?.binding;
  const results = evidence?.results;
  if (binding?.schema_version !== 1 || binding.repository !== 'git-malu/AnyWear-Service'
    || binding.service_source_commit !== serviceCommit || binding.checked_out_commit !== serviceCommit
    || binding.ref !== 'refs/heads/main' || !['push', 'workflow_dispatch', 'workflow_call'].includes(binding.event_name)
    || binding.database_integration_enabled !== true || !/^[1-9][0-9]*$/.test(binding.run_id ?? '')
    || !/^[1-9][0-9]*$/.test(binding.run_attempt ?? '') || results?.success !== true
    || results.numFailedTests !== 0 || !Number.isInteger(results.numPassedTests) || results.numPassedTests < 2) {
    throw new Error('Fencing CI evidence must be a passing DB-enabled main run at the exact deployed Service source');
  }
  const assertions = (results.testResults ?? []).filter((entry) => entry.status === 'passed'
    && /(?:^|[/\\])business-result-fencing\.integration\.test\.ts$/.test(entry.name ?? ''))
    .flatMap((entry) => entry.assertionResults ?? []);
  for (const name of FENCING_CASES) {
    const matches = assertions.filter((assertion) => assertion.fullName === name || assertion.fullName?.endsWith(` ${name}`));
    if (matches.length !== 1 || matches[0].status !== 'passed') throw new Error(`Pinned CI post-provider fencing assertion did not pass: ${name}`);
  }
  return evidence;
}

export async function readFencingCiEvidence(environment, serviceCommit) {
  const directory = environment.RUNTIME_DRILL_FENCING_EVIDENCE_DIRECTORY;
  if (!directory) throw new Error('Runtime drill requires pinned CI DB fencing evidence before mutation');
  const evidence = { binding: JSON.parse(await readFile(path.join(directory, 'binding.json'), 'utf8')),
    results: JSON.parse(await readFile(path.join(directory, 'results.json'), 'utf8')) };
  verifyFencingCiEvidence(evidence, serviceCommit);
  if (evidence.binding.run_id !== environment.RUNTIME_DRILL_FENCING_RUN_ID
    || evidence.binding.run_attempt !== environment.RUNTIME_DRILL_FENCING_RUN_ATTEMPT) {
    throw new Error('Fencing artifact run identity differs from the approved workflow inputs');
  }
  return evidence;
}
