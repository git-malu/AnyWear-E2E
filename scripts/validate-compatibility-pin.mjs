// Offline coherence check for the reviewed system-test compatibility pin.
//
// Coherence, not provenance. The tool compares inputs it is handed — the two
// per-producer deployment-record byte streams, the committed pin and the pin as
// committed before the change. Agreement between them says the pin is internally
// coherent and moved forward; it says nothing about who produced the records or
// where they came from, and it never establishes provenance.
//
// `deployment.artifact_id` and `platform.record.artifact_id` appear nowhere in the
// records, so no offline input constrains them. They are read by hand from the
// producer run pages, and only the live binding can check them. The runs'
// conclusion, branch, dispatch type and head, the artifacts' names and lifetimes,
// the Service release's immutability and the manifest bytes are live-only
// properties too: they stay with `scripts/trusted-deployment-inputs.mjs`, which
// enforces them against the GitHub API at qualification time. Green here is
// coherence, not authority.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { byteHash, canonicalJson, parseStrictJson, validateCompatibility } from './evidence-contract.mjs';
import { assertDeploymentBinding } from './trusted-deployment-inputs.mjs';

// The reviewed identity members a pin move has to justify as a set. A move that
// leaves all of them equal is a no-op re-pin, not a decision.
export const IDENTITY_MEMBERS = Object.freeze(['client', 'service', 'infra', 'platform', 'workload', 'service_artifacts', 'deployment', 'minimum_supported_client']);
export const OPTIONS = Object.freeze(['--platform-record', '--deployment-record', '--previous', '--compatibility']);

const defaultCompatibility = fileURLToPath(new URL('../compatibility.json', import.meta.url));
const identityOf = (pin) => Object.fromEntries(IDENTITY_MEMBERS.map((member) => [member, pin[member] ?? null]));
const recordIdentities = (pin) => [
  ['platform.record', pin.platform?.record],
  ['deployment', pin.deployment],
];

export function validatorArguments(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    if (!OPTIONS.includes(name)) {
      throw new Error(`Unsupported argument ${name}; the offline validator reads both deployment records, a previous pin and the committed pin`);
    }
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a path`);
    if (options.has(name)) throw new Error(`${name} may be supplied only once`);
    options.set(name, value);
  }
  for (const name of ['--platform-record', '--deployment-record', '--previous']) {
    if (!options.has(name)) throw new Error(`${name} is required`);
  }
  return {
    platformRecord: resolve(options.get('--platform-record')),
    deploymentRecord: resolve(options.get('--deployment-record')),
    previous: resolve(options.get('--previous')),
    // Never resolved from the working directory: the committed pin lives beside
    // this script, so a check run from elsewhere still reads the reviewed file.
    compatibility: options.has('--compatibility') ? resolve(options.get('--compatibility')) : defaultCompatibility,
  };
}

export async function assertCompatibilityPin({ platformRecord, deploymentRecord, previous, compatibility = defaultCompatibility }) {
  if (!platformRecord || !deploymentRecord || !previous) {
    throw new Error('Both deployment record paths and a previous pin path are required');
  }
  const pin = validateCompatibility(parseStrictJson(await readFile(compatibility)));
  // A move after the minimum-client deployment has to pin the supported-Client floor as
  // well. The committed pre-deployment pin is allowed to lack it, but this validator is
  // only used to justify a move, and a moved pin without the member would leave the
  // oldest supported Client unnamed. `assertDeploymentBinding` below then requires the
  // workload record's observed floor to equal the new pin's floor.
  if (pin.minimum_supported_client === undefined) {
    throw new Error('Compatibility pin move must include minimum_supported_client { version, sha } naming the oldest supported Client');
  }
  // A v2 previous pin is the historical input of the strict v2 -> v3 migration.
  const previousPin = validateCompatibility(parseStrictJson(await readFile(previous)), { allowLegacy: true });
  // A deferred record is coherent but has no evidence to validate; the pin cannot
  // move until the producer's exact bytes exist.
  for (const [label, identity] of recordIdentities(pin)) {
    if (identity.status === 'deferred') throw new Error(`Deployment evidence deferred for ${label}: ${identity.reason}`);
  }
  const platformBytes = await readFile(platformRecord);
  const workloadBytes = await readFile(deploymentRecord);
  // The byte hash comes first and reads the file as bytes. Re-serialising,
  // pretty-printing or parse-then-hashing would accept a file the producer never
  // wrote, so each record is parsed only after its exact bytes are bound.
  const platformHash = byteHash(platformBytes);
  const workloadHash = byteHash(workloadBytes);
  if (platformHash !== pin.platform.record.record_sha256) {
    throw new Error(`Platform deployment record byte hash does not match platform.record.record_sha256; the pin is stale or the record was reformatted (${platformHash})`);
  }
  if (workloadHash !== pin.deployment.record_sha256) {
    throw new Error(`Workload deployment record byte hash does not match deployment.record_sha256; the pin is stale or the record was reformatted (${workloadHash})`);
  }
  // The shared binding owns every record and producer rule; this tool never
  // restates one. The records are validated against the pin here; only their
  // hashes and run identities are reported below.
  assertDeploymentBinding(parseStrictJson(platformBytes), pin);
  assertDeploymentBinding(parseStrictJson(workloadBytes), pin);
  if (canonicalJson(identityOf(pin)) === canonicalJson(identityOf(previousPin))) {
    throw new Error(`Compatibility pin identity members are unchanged (${IDENTITY_MEMBERS.join(', ')}); a re-pin must move at least one of them`);
  }
  // A changed record identity must move forward. An unchanged identity is a
  // legitimate re-pin of another member (for example a Client publish the
  // existing record already observed).
  if (previousPin.version === 3) {
    for (const [label, current, prior] of [
      ['platform.record', pin.platform.record, previousPin.platform.record],
      ['deployment', pin.deployment, previousPin.deployment],
    ]) {
      if (prior.status === 'deferred' || canonicalJson(current) === canonicalJson(prior)) continue;
      if (!(current.run_id > prior.run_id || (current.run_id === prior.run_id && current.run_attempt > prior.run_attempt))) {
        throw new Error(`${label}.run_id/run_attempt did not move forward: previous ${prior.run_id}-${prior.run_attempt} is not behind ${current.run_id}-${current.run_attempt}`);
      }
    }
  }
  return {
    compatibility,
    deployment: {
      platform: { run_id: pin.platform.record.run_id, run_attempt: pin.platform.record.run_attempt, artifact_id: pin.platform.record.artifact_id, record_sha256: platformHash },
      workload: { run_id: pin.deployment.run_id, run_attempt: pin.deployment.run_attempt, artifact_id: pin.deployment.artifact_id, record_sha256: workloadHash },
    },
    previous: previousPin.version === 3
      ? { platform: `${previousPin.platform.record.run_id}-${previousPin.platform.record.run_attempt}`, workload: `${previousPin.deployment.run_id}-${previousPin.deployment.run_attempt}` }
      : { version: previousPin.version },
    moved_members: IDENTITY_MEMBERS.filter((member) => canonicalJson(pin[member] ?? null) !== canonicalJson(previousPin[member] ?? null)),
  };
}

async function main() {
  const summary = await assertCompatibilityPin(validatorArguments(process.argv.slice(2)));
  console.log(`Compatibility pin is coherent: platform ${summary.deployment.platform.run_id}-${summary.deployment.platform.run_attempt} (${summary.deployment.platform.record_sha256}), workload ${summary.deployment.workload.run_id}-${summary.deployment.workload.run_attempt} (${summary.deployment.workload.record_sha256}), moved ${summary.moved_members.join(', ')}.`);
  // The artifact ids are printed for the reviewer, not checked: neither record
  // carries them, so nothing offline can compare them.
  console.log(`deployment.artifact_id ${summary.deployment.workload.artifact_id} and platform.record.artifact_id ${summary.deployment.platform.artifact_id} are unconstrained offline and stay live-binding checks.`);
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
