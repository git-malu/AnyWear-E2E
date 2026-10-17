// Offline coherence check for the reviewed system-test compatibility pin.
//
// Coherence, not provenance. The tool compares three inputs it is handed — the
// deployed-tuple record bytes, the committed pin and the pin as committed before
// the change. Agreement between them says the pin is internally coherent and
// moved forward; it says nothing about who produced the record or where it came
// from, and it never establishes provenance.
//
// `deployment.artifact_id` appears nowhere in the deployment record, so no
// offline input constrains it. It is read by hand from the observation run page,
// and only the live binding can check it. The run's conclusion, branch, dispatch
// type and head, the artifact's name and lifetime, the Service release's
// immutability and the manifest bytes are live-only properties too: they stay
// with `scripts/trusted-deployment-inputs.mjs`, which enforces them against the
// GitHub API at qualification time. Green here is coherence, not authority.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { byteHash, canonicalJson, parseStrictJson, validateCompatibility } from './evidence-contract.mjs';
import { assertDeploymentBinding } from './trusted-deployment-inputs.mjs';
import { validateDeploymentRecord } from './vendor/deployment-contract.mjs';

// The five reviewed identity members a pin move has to justify as a set. A move
// that leaves all of them equal is a no-op re-pin, not a decision.
export const IDENTITY_MEMBERS = Object.freeze(['client', 'service', 'infra', 'service_artifacts', 'deployment']);
export const OPTIONS = Object.freeze(['--deployment-record', '--previous', '--compatibility']);

const defaultCompatibility = fileURLToPath(new URL('../compatibility.json', import.meta.url));
const identityOf = (pin) => Object.fromEntries(IDENTITY_MEMBERS.map((member) => [member, pin[member]]));

export function validatorArguments(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    if (!OPTIONS.includes(name)) {
      throw new Error(`Unsupported argument ${name}; the offline validator reads only a deployment record, a previous pin and the committed pin`);
    }
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a path`);
    if (options.has(name)) throw new Error(`${name} may be supplied only once`);
    options.set(name, value);
  }
  for (const name of ['--deployment-record', '--previous']) {
    if (!options.has(name)) throw new Error(`${name} is required`);
  }
  return {
    deploymentRecord: resolve(options.get('--deployment-record')),
    previous: resolve(options.get('--previous')),
    // Never resolved from the working directory: the committed pin lives beside
    // this script, so a check run from elsewhere still reads the reviewed file.
    compatibility: options.has('--compatibility') ? resolve(options.get('--compatibility')) : defaultCompatibility,
  };
}

export async function assertCompatibilityPin({ deploymentRecord, previous, compatibility = defaultCompatibility }) {
  if (!deploymentRecord || !previous) throw new Error('A deployment record path and a previous pin path are both required');
  const pin = parseStrictJson(await readFile(compatibility));
  const recordBytes = await readFile(deploymentRecord);
  // The byte hash comes first and reads the file as bytes. Re-serialising,
  // pretty-printing or parse-then-hashing would accept a file the producer never
  // wrote, so the record is parsed only after its exact bytes are bound.
  const recordHash = byteHash(recordBytes);
  if (recordHash !== pin?.deployment?.record_sha256) {
    throw new Error(`Deployment record byte hash does not match deployment.record_sha256; the pin is stale or the record was reformatted (${recordHash})`);
  }
  // The shared binding owns every tuple rule; this tool never restates one.
  const record = assertDeploymentBinding(parseStrictJson(recordBytes), pin);
  validateDeploymentRecord(record);
  const previousPin = validateCompatibility(parseStrictJson(await readFile(previous)));
  if (canonicalJson(identityOf(pin)) === canonicalJson(identityOf(previousPin))) {
    throw new Error(`Compatibility pin identity members are unchanged (${IDENTITY_MEMBERS.join(', ')}); a re-pin must move at least one of them`);
  }
  const { run_id: runId, run_attempt: runAttempt } = pin.deployment;
  const prior = previousPin.deployment;
  if (!(runId > prior.run_id || (runId === prior.run_id && runAttempt > prior.run_attempt))) {
    throw new Error(`deployment.run_id/deployment.run_attempt did not move forward: previous ${prior.run_id}-${prior.run_attempt} is not behind ${runId}-${runAttempt}`);
  }
  return {
    compatibility,
    deployment: { run_id: runId, run_attempt: runAttempt, artifact_id: pin.deployment.artifact_id, record_sha256: recordHash },
    previous: { run_id: prior.run_id, run_attempt: prior.run_attempt },
    moved_members: IDENTITY_MEMBERS.filter((member) => canonicalJson(pin[member]) !== canonicalJson(previousPin[member])),
  };
}

async function main() {
  const summary = await assertCompatibilityPin(validatorArguments(process.argv.slice(2)));
  console.log(`Compatibility pin is coherent: deployment ${summary.deployment.run_id}-${summary.deployment.run_attempt}, record ${summary.deployment.record_sha256}, moved ${summary.moved_members.join(', ')}.`);
  // deployment.artifact_id is printed for the reviewer, not checked: the record
  // does not carry it, so nothing offline can compare it.
  console.log(`deployment.artifact_id ${summary.deployment.artifact_id} is unconstrained offline and stays a live-binding check.`);
  console.log('Coherence only: this is not provenance and not authority.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
