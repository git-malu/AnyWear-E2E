import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { collectDeploymentEvidence } from './qualification-record.mjs';

const compatibility = JSON.parse(await readFile(new URL('../compatibility.json', import.meta.url), 'utf8'));
const evidence = await collectDeploymentEvidence({
  clientUrl: process.env.E2E_CLIENT_URL,
  serviceUrl: process.env.E2E_SERVICE_URL,
  runId: process.env.GITHUB_RUN_ID,
}, compatibility);
const outputPath = resolve(process.env.QUALIFICATION_EVIDENCE_PATH ?? 'deployment-evidence.json');
await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
console.log(`Verified deployed Client ${evidence.client.source_commit.slice(0, 7)} and Service ${evidence.service.source_commit.slice(0, 7)}`);
