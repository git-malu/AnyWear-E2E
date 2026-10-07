import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assertStableDeploymentEvidence, collectDeploymentEvidence, validateInfraEvidence } from './qualification-record.mjs';
import { byteHash, parseStrictJson, validateCompatibility } from './evidence-contract.mjs';
import { pinnedInfraObserver } from './infra-observation.mjs';
import { assertE2EWriterWindow } from './writer-window.mjs';

const compatibility = validateCompatibility(parseStrictJson(await readFile(new URL('../compatibility.json', import.meta.url))));
assertE2EWriterWindow();
const inputsDirectory = resolve(process.env.QUALIFICATION_INPUTS_DIR ?? '.qualification-inputs');
const deploymentBytes = await readFile(resolve(inputsDirectory, 'deployment-record.json'));
if (byteHash(deploymentBytes) !== compatibility.deployment.record_sha256) throw new Error('Trusted deployment record bytes changed');
const deployment = parseStrictJson(deploymentBytes);
const http = await collectDeploymentEvidence({
  clientUrl: process.env.E2E_CLIENT_URL,
  serviceUrl: process.env.E2E_SERVICE_URL,
  runId: process.env.GITHUB_RUN_ID,
}, compatibility);
const authenticated = await pinnedInfraObserver(compatibility, deployment);
const evidence = validateInfraEvidence({ ...http, schema_version: 2, compatibility, deployment,
  service_artifacts: compatibility.service_artifacts, authenticated,
}, compatibility);
if (process.env.QUALIFICATION_BASELINE_PATH) {
  const baselinePath = resolve(process.env.QUALIFICATION_BASELINE_PATH);
  const baseline = parseStrictJson(await readFile(baselinePath));
  assertStableDeploymentEvidence(baseline, evidence);
}
const outputPath = resolve(process.env.QUALIFICATION_EVIDENCE_PATH ?? 'deployment-evidence.json');
await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
console.log(`Verified deployed Client ${evidence.client.source_commit.slice(0, 7)} and Service ${evidence.service.source_commit.slice(0, 7)}`);
