import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assertStableDeploymentEvidence, collectDeploymentEvidence, validateInfraEvidence } from './qualification-record.mjs';
import { byteHash, parseStrictJson, validateCompatibility } from './evidence-contract.mjs';
import { pinnedInfraObserver } from './infra-observation.mjs';
import { assertE2EExecution } from './execution-guard.mjs';

const compatibility = validateCompatibility(parseStrictJson(await readFile(new URL('../compatibility.json', import.meta.url))));
for (const [label, identity] of [['platform', compatibility.platform.record], ['workload', compatibility.deployment]]) {
  if (identity.status === 'deferred') throw new Error(`Deployment evidence deferred for ${label}: ${identity.reason}`);
}
assertE2EExecution();
const inputsDirectory = resolve(process.env.QUALIFICATION_INPUTS_DIR ?? '.qualification-inputs');
const platformBytes = await readFile(resolve(inputsDirectory, 'platform-deployment-record.json'));
const workloadBytes = await readFile(resolve(inputsDirectory, 'deployment-record.json'));
if (byteHash(platformBytes) !== compatibility.platform.record.record_sha256) throw new Error('Trusted platform deployment record bytes changed');
if (byteHash(workloadBytes) !== compatibility.deployment.record_sha256) throw new Error('Trusted workload deployment record bytes changed');
const platform = parseStrictJson(platformBytes);
const workload = parseStrictJson(workloadBytes);
const http = await collectDeploymentEvidence({
  clientUrl: process.env.E2E_CLIENT_URL,
  serviceUrl: process.env.E2E_SERVICE_URL,
  runId: process.env.GITHUB_RUN_ID,
}, compatibility);
const authenticated = await pinnedInfraObserver(compatibility, { platform, workload });
const evidence = validateInfraEvidence({ ...http, schema_version: 3, compatibility,
  platform: { identity: compatibility.platform.record, record: platform },
  workload: { identity: compatibility.deployment, record: workload },
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
