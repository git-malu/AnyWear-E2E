import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildQualificationRecord } from './qualification-record.mjs';
import { ENVIRONMENT_VERDICT_PATH, readOptionalEnvironmentJson } from './qualification-environment.mjs';
import { parseStrictJson } from './evidence-contract.mjs';
import { QUALIFICATION_REPORT_ENV, QUALIFICATION_REPORT_PATH, repositoryRoot } from './test-selection.mjs';

// #180/#193: the v4 record is assembled from what this run observed, never from a committed
// compatibility file. The three inputs are the two live observations the collect step
// wrote (before and after the suite), the immutable Service release identity the
// credential-free check verified before the suite (`.qualification-inputs/service-release.json`:
// repository, release id, tag, tag target commit and the four released assets with their
// published size and digest), and the live identity (Client version and Service floor) read
// by the same check. The dispatch expectation is passed in explicitly so the record can
// state whether the run was triggered with an expected Service commit (`source: trigger`)
// or took the live value at run start (`source: live`). No release asset is read here.
const inputsDirectory = resolve(process.env.QUALIFICATION_INPUTS_DIR ?? '.qualification-inputs');
const after = parseStrictJson(await readFile(resolve(process.env.QUALIFICATION_EVIDENCE_PATH ?? 'deployment-evidence.json')));
const before = parseStrictJson(await readFile(resolve(process.env.QUALIFICATION_BASELINE_PATH ?? 'deployment-evidence-before.json')));
const serviceArtifacts = parseStrictJson(await readFile(resolve(inputsDirectory, 'service-release.json')));
const live = parseStrictJson(await readFile(resolve(inputsDirectory, 'live-identity.json')));
// The environment gate the record path requires: the workflow's qualification-gate step
// refuses first, and this read is what makes the record path refuse even if that step
// were skipped. A missing or malformed verdict refuses here rather than qualifying.
const environment = await readOptionalEnvironmentJson(resolve(process.env.ENVIRONMENT_VERDICT_PATH ?? ENVIRONMENT_VERDICT_PATH));
// The record states which scenarios ran and how many of each spec's collected tests were
// skipped, and the run's own Playwright JSON report is the only source of that. The path
// is the workflow's job-level declaration, resolved from this repository rather than from
// the process's working directory so the reporter that writes the file and the producer
// that reads it cannot drift apart.
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
  // `full`, so the shared `qualify` entry cannot issue a record from smoke or reconcile.
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
  // Which trigger dispatched this run, and the run that dispatched it when a release
  // action (or the deployment smoke hook) did so. A manual run states neither beyond
  // `manual`.
  trigger: process.env.QUALIFICATION_TRIGGER,
  dispatchedBy: process.env.QUALIFICATION_DISPATCHED_BY || null,
}, {
  service_commit: process.env.EXPECTED_SERVICE_COMMIT || null,
  client_commit: process.env.EXPECTED_CLIENT_COMMIT || null,
  source: process.env.EXPECTED_SOURCE,
}, {
  before,
  after,
  service_artifacts: serviceArtifacts,
  live,
}, undefined, environment, reportBytes);

const outputPath = resolve(process.env.QUALIFICATION_OUTPUT_PATH ?? 'qualification-record.json');
await writeFile(outputPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
console.log(`Created qualification record ${record.qualification_id} from the live tuple (expected source ${record.expected.source}, trigger ${record.workflow.trigger})`);
