import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildQualificationRecord } from './qualification-record.mjs';
import { ENVIRONMENT_VERDICT_PATH, readOptionalEnvironmentJson } from './beta-sizing-environment.mjs';
import { parseStrictJson } from './evidence-contract.mjs';

const compatibility = parseStrictJson(await readFile(new URL('../compatibility.json', import.meta.url)));
const evidencePath = resolve(process.env.QUALIFICATION_EVIDENCE_PATH ?? 'deployment-evidence.json');
const after = parseStrictJson(await readFile(evidencePath));
const before = parseStrictJson(await readFile(resolve(process.env.QUALIFICATION_BASELINE_PATH ?? 'deployment-evidence-before.json')));
// The environment gate the record path now requires: the workflow's qualification-gate
// step refuses first, and this read is what makes the record path refuse even if that
// step were skipped. A missing or malformed verdict refuses here rather than qualifying.
const environment = await readOptionalEnvironmentJson(resolve(process.env.ENVIRONMENT_VERDICT_PATH ?? ENVIRONMENT_VERDICT_PATH));
const record = buildQualificationRecord({
  result: process.env.QUALIFICATION_RESULT,
  e2eSha: process.env.GITHUB_SHA,
  repository: process.env.GITHUB_REPOSITORY,
  runId: process.env.GITHUB_RUN_ID,
  runAttempt: process.env.GITHUB_RUN_ATTEMPT,
  serverUrl: process.env.GITHUB_SERVER_URL,
  awsAccountId: process.env.AWS_ACCOUNT_ID,
  awsRegion: process.env.AWS_REGION,
  workflowPath: '.github/workflows/beta-qualification.yml',
  workflowRef: process.env.GITHUB_WORKFLOW_REF,
}, compatibility, { before, after }, undefined, environment);

const outputPath = resolve(process.env.QUALIFICATION_OUTPUT_PATH ?? 'qualification-record.json');
await writeFile(outputPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
console.log(`Created qualification record ${record.qualification_id}`);
