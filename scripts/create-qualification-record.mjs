import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildQualificationRecord } from './qualification-record.mjs';
import { ENVIRONMENT_VERDICT_PATH, readOptionalEnvironmentJson } from './beta-sizing-environment.mjs';
import { parseStrictJson } from './evidence-contract.mjs';
import { QUALIFICATION_REPORT_ENV, QUALIFICATION_REPORT_PATH, repositoryRoot } from './test-selection.mjs';

const compatibility = parseStrictJson(await readFile(new URL('../compatibility.json', import.meta.url)));
const evidencePath = resolve(process.env.QUALIFICATION_EVIDENCE_PATH ?? 'deployment-evidence.json');
const after = parseStrictJson(await readFile(evidencePath));
const before = parseStrictJson(await readFile(resolve(process.env.QUALIFICATION_BASELINE_PATH ?? 'deployment-evidence-before.json')));
// The environment gate the record path now requires: the workflow's qualification-gate
// step refuses first, and this read is what makes the record path refuse even if that
// step were skipped. A missing or malformed verdict refuses here rather than qualifying.
const environment = await readOptionalEnvironmentJson(resolve(process.env.ENVIRONMENT_VERDICT_PATH ?? ENVIRONMENT_VERDICT_PATH));
// The record states which scenarios ran and how many of each spec's collected tests were
// skipped, and the run's own Playwright JSON report is the only source of that. The path is
// the workflow's job-level declaration, resolved from this repository rather than from the
// process's working directory so the reporter that writes the file and the producer that
// reads it cannot drift apart.
const reportPath = resolve(repositoryRoot, process.env[QUALIFICATION_REPORT_ENV] ?? QUALIFICATION_REPORT_PATH);
let reportBytes;
try {
  reportBytes = await readFile(reportPath);
} catch (error) {
  throw new Error(`The qualification record requires the Playwright JSON report at ${reportPath}; ${QUALIFICATION_REPORT_ENV} names it (default ${QUALIFICATION_REPORT_PATH}) and the release-gating suite step writes it (${error.code ?? error.message})`, { cause: error });
}
const record = buildQualificationRecord({
  result: process.env.QUALIFICATION_RESULT,
  // The dispatched operation, not a workflow file: the record path refuses anything but
  // `full`, so the shared `qualify` entry cannot issue a record from smoke, measure or
  // recover (#163).
  operation: process.env.E2E_OPERATION,
  e2eSha: process.env.GITHUB_SHA,
  repository: process.env.GITHUB_REPOSITORY,
  runId: process.env.GITHUB_RUN_ID,
  runAttempt: process.env.GITHUB_RUN_ATTEMPT,
  serverUrl: process.env.GITHUB_SERVER_URL,
  awsAccountId: process.env.AWS_ACCOUNT_ID,
  awsRegion: process.env.AWS_REGION,
  workflowPath: '.github/workflows/beta-qualification.yml',
  workflowRef: process.env.GITHUB_WORKFLOW_REF,
}, compatibility, { before, after }, undefined, environment, reportBytes);

const outputPath = resolve(process.env.QUALIFICATION_OUTPUT_PATH ?? 'qualification-record.json');
await writeFile(outputPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
console.log(`Created qualification record ${record.qualification_id}`);
