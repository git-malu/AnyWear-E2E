import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildQualificationRecord } from './qualification-record.mjs';

const compatibility = JSON.parse(await readFile(new URL('../compatibility.json', import.meta.url), 'utf8'));
const evidencePath = resolve(process.env.QUALIFICATION_EVIDENCE_PATH ?? 'deployment-evidence.json');
const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
const record = buildQualificationRecord({
  result: process.env.QUALIFICATION_RESULT,
  e2eSha: process.env.GITHUB_SHA,
  repository: process.env.GITHUB_REPOSITORY,
  runId: process.env.GITHUB_RUN_ID,
  runAttempt: process.env.GITHUB_RUN_ATTEMPT,
  serverUrl: process.env.GITHUB_SERVER_URL,
  awsAccountId: process.env.AWS_ACCOUNT_ID,
  awsRegion: process.env.AWS_REGION,
}, compatibility, evidence);

const outputPath = resolve(process.env.QUALIFICATION_OUTPUT_PATH ?? 'qualification-record.json');
await writeFile(outputPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
console.log(`Created qualification record ${record.qualification_id}`);
