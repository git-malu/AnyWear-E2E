import { readFile } from 'node:fs/promises';
import { parseStrictJson, validateCompatibility } from './evidence-contract.mjs';

const path = process.argv.find((argument) => argument.startsWith('--file='))?.slice(7)
  ?? new URL('../compatibility.json', import.meta.url);
const manifest = validateCompatibility(parseStrictJson(await readFile(path)), {
  // A historical v1/v2 pin may still pass the offline source check. Every live
  // qualification entry requires v3 before collecting any deployment evidence.
  allowLegacy: !process.argv.includes('--require-infra'),
});
const short = (sha) => String(sha).slice(0, 7);
console.log(`Compatibility v${manifest.version}: Client ${short(manifest.client.sha)}, Service ${short(manifest.service.sha)}${manifest.infra ? `, Infra ${short(manifest.infra.sha)}` : ''}`);
if (manifest.version === 3) {
  const record = (identity) => identity.status === 'deferred'
    ? `deferred (${identity.producer} ${identity.workflow_path})`
    : `recorded (${identity.producer} ${identity.workflow_path} run ${identity.run_id}-${identity.run_attempt})`;
  console.log(`Platform producer ${manifest.platform.producer}@${short(manifest.platform.producer_sha)}; record ${record(manifest.platform.record)}`);
  console.log(`Workload producer ${manifest.workload.producer}@${short(manifest.workload.producer_sha)}; deployment ${record(manifest.deployment)}`);
}
