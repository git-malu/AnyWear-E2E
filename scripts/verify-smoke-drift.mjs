import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertEqual, exactKeys, parseStrictJson, repositories } from './evidence-contract.mjs';
import { ghApi } from './github-read.mjs';
import { validateObservation } from './qualification-record.mjs';
import { extractArtifactEntry } from './artifact-zip.mjs';

// #228: the consumer-side drift gate. The deployment's smoke run and the release
// qualification observe the same platform; a drift between the two observations is a
// refusal that names the differing member. The gate runs only in the `full` operation,
// immediately after the before-observation and before the suite:
//
// - enumerate the 30 newest completed-success `workflow_dispatch` runs of
//   `beta-qualification.yml` on main through the existing `gh api` seam;
// - in each run's artifacts look for `tested-revisions-<run>-<attempt>` (only the smoke
//   job uploads that name), download the zip through the seam's already-gated binary
//   path, and extract `deployment-evidence.json` with the strict minimal ZIP reader;
// - validate the observation with the record validator, and match the release identity
//   (Service commit + image digest + Client source commit) against the qualification's
//   before-observation; the first (newest) match wins deterministically;
// - compare `{client, service, platform}` with `assertEqual` (a difference refuses and
//   names the differing member; `collected_at` is excluded), and require the smoke
//   observation to predate the qualification observation;
// - no match within the bound — or an expired/malformed artifact — is a loud refusal
//   naming the release identity and instructing the operator to run a smoke.
//
// On success the gate writes `.qualification-inputs/smoke-drift.json`, which joins the
// handoff artifact set but is not a record member. The credential-free `record` job
// re-runs the check in `--verify-recorded` mode against exactly the recorded artifact
// id, so the credential-free half re-proves the gate instead of trusting the `full`
// job's claim.
export const RUNS_BOUND = 30;
export const DRIFT_OUTPUT_KEYS = Object.freeze([
  'checked_at', 'smoke_run_id', 'smoke_run_attempt', 'smoke_run_head_sha', 'smoke_artifact_id',
  'smoke_created_at', 'matched_service_commit', 'matched_image_digest', 'matched_client_commit', 'result',
]);

const runsPattern = (runId) => new RegExp(`^tested-revisions-${runId}-([1-9][0-9]*)$`);
const releaseIdentity = (observation) => ({
  service_commit: observation.service.service_commit,
  image_digest: observation.service.image_digest,
  client_commit: observation.client.source_commit,
});
const identityMatches = (left, right) => left.service_commit === right.service_commit
  && left.image_digest === right.image_digest && left.client_commit === right.client_commit;
const pickCompared = ({ client, service, platform }) => ({ client, service, platform });

function requireMatchRun(run) {
  if (run?.status !== 'completed' || run?.conclusion !== 'success' || run?.event !== 'workflow_dispatch'
    || run?.head_branch !== 'main' || !Number.isSafeInteger(run?.id) || typeof run?.head_sha !== 'string') {
    throw new Error('Deploy-smoke drift candidate run is not a completed-success workflow_dispatch run on main');
  }
  return run;
}

// The newest usable tested-revisions artifact of one run: the artifact list may carry
// several attempts of the same run, and the latest attempt wins. The response's
// workflow_run binding must name this run, so an artifact listed under a foreign run is
// never downloaded.
function newestArtifactForRun(artifacts, run) {
  const pattern = runsPattern(run.id);
  const candidates = (artifacts ?? []).filter((artifact) => pattern.test(artifact?.name ?? '')
    && artifact.workflow_run?.id === run.id);
  if (candidates.length === 0) return null;
  candidates.sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
  const [artifact] = candidates;
  return { artifact, attempt: Number(pattern.exec(artifact.name)[1]) };
}

// Download and validate one candidate artifact's observation. An expired, hostile or
// shape-mismatched artifact is a loud refusal naming the artifact and the release
// identity: it is treated as no evidence, never as a silent skip.
function readCandidateObservation(api, environment, run, artifact, identity, describe) {
  if (artifact.expired === true) {
    throw new Error(`Deploy-smoke drift refused for ${describe()}: the tested-revisions artifact ${artifact.id} of run ${run.id} is expired; run a smoke for this release, then re-run full`);
  }
  const zip = api(`repos/${repositories.e2e}/actions/artifacts/${artifact.id}/zip`, true, environment);
  let observation;
  try {
    observation = parseStrictJson(extractArtifactEntry(zip, 'deployment-evidence.json'));
    validateObservation(observation, 'deploy-smoke observation');
  } catch (error) {
    throw new Error(`Deploy-smoke drift refused for ${describe()}: artifact ${artifact.id} of run ${run.id} is not a valid discovery observation (${error.message}); run a smoke for this release, then re-run full`, { cause: error });
  }
  return observation;
}

// The bounded newest-first enumeration. Runs whose artifacts carry another release's
// identity are skipped; the first (newest) run whose observation matches the
// qualification's release identity wins.
function findMatchingSmoke({ api, environment, identity, describe }) {
  const runsPath = `repos/${repositories.e2e}/actions/workflows/beta-qualification.yml/runs`
    + `?per_page=${RUNS_BOUND}&branch=main&event=workflow_dispatch&status=success`;
  // No silent skip and no retry loop: an API failure propagates with its error line, and
  // re-running the workflow is the retry. The enumeration itself is bounded: at most the
  // RUNS_BOUND newest runs are examined, whatever the response carries.
  const payload = parseStrictJson(api(runsPath, false, environment));
  const runs = (payload.workflow_runs ?? []).slice(0, RUNS_BOUND);
  for (const run of runs) {
    let reviewed;
    try {
      reviewed = requireMatchRun(run);
    } catch (error) {
      throw new Error(`Deploy-smoke drift enumeration returned a non-qualifying run (${error.message})`, { cause: error });
    }
    const artifactsPayload = parseStrictJson(api(`repos/${repositories.e2e}/actions/runs/${reviewed.id}/artifacts?per_page=100`, false, environment));
    const match = newestArtifactForRun(artifactsPayload.artifacts, reviewed);
    if (!match) continue;
    const observation = readCandidateObservation(api, environment, reviewed, match.artifact, identity, describe);
    if (!identityMatches(releaseIdentity(observation), identity)) continue;
    return { run: reviewed, attempt: match.attempt, artifact: match.artifact, observation };
  }
  throw new Error(`No deploy-smoke observation matches ${describe()} within the ${RUNS_BOUND} newest completed-success workflow_dispatch runs; run a smoke for this release, then re-run full`);
}

// `--verify-recorded`: re-run the check against exactly the recorded artifact id. The
// recorded run/attempt/head-sha/created-at bindings are re-proved against the live
// artifact and run metadata before the bytes are downloaded, so the credential-free job
// does not trust the `full` job's claim.
function verifyRecordedMatch({ api, environment, identity, describe, outputPath }) {
  let recorded;
  try {
    recorded = parseStrictJson(readFileSync(outputPath));
  } catch (error) {
    throw new Error(`The recorded smoke drift file is missing at ${outputPath} (${error.code ?? error.message})`, { cause: error });
  }
  exactKeys(recorded, [...DRIFT_OUTPUT_KEYS], 'recorded smoke drift');
  const artifactId = recorded.smoke_artifact_id;
  if (!Number.isSafeInteger(artifactId) || artifactId < 1) {
    throw new Error(`Recorded smoke drift names an invalid artifact id ${JSON.stringify(artifactId)}`);
  }
  const artifact = parseStrictJson(api(`repos/${repositories.e2e}/actions/artifacts/${artifactId}`, false, environment));
  const run = parseStrictJson(api(`repos/${repositories.e2e}/actions/runs/${recorded.smoke_run_id}`, false, environment));
  requireMatchRun(run);
  if (artifact?.id !== artifactId || artifact.expired === true
    || artifact.name !== `tested-revisions-${recorded.smoke_run_id}-${recorded.smoke_run_attempt}`
    || artifact.workflow_run?.id !== recorded.smoke_run_id || artifact.created_at !== recorded.smoke_created_at
    || run.id !== recorded.smoke_run_id || run.run_attempt !== recorded.smoke_run_attempt
    || run.head_sha !== recorded.smoke_run_head_sha) {
    throw new Error(`Recorded smoke drift does not match the artifact ${artifactId} and run ${recorded.smoke_run_id} metadata; re-run full with a fresh smoke`);
  }
  if (recorded.matched_service_commit !== identity.service_commit
    || recorded.matched_image_digest !== identity.image_digest
    || recorded.matched_client_commit !== identity.client_commit) {
    throw new Error('Recorded smoke drift identity does not match the qualification observation');
  }
  const observation = readCandidateObservation(api, environment, run, artifact, identity, describe);
  if (!identityMatches(releaseIdentity(observation), identity)) {
    throw new Error(`Recorded smoke drift artifact ${artifactId} does not match the qualification's release identity`);
  }
  return { run, attempt: Number(recorded.smoke_run_attempt), artifact, observation };
}

export async function verifySmokeDrift({
  baselinePath = process.env.SMOKE_DRIFT_BASELINE ?? 'deployment-evidence-before.json',
  verifyRecorded = false,
  api = ghApi,
  environment = process.env,
  outputPath = resolve('.qualification-inputs/smoke-drift.json'),
  now = () => new Date(),
} = {}) {
  const baseline = parseStrictJson(await readFile(resolve(baselinePath)));
  validateObservation(baseline, 'qualification before-observation');
  const identity = releaseIdentity(baseline);
  const describe = () => `Service ${identity.service_commit} (${identity.image_digest}) with Client ${identity.client_commit}`;
  const match = verifyRecorded
    ? verifyRecordedMatch({ api, environment, identity, describe, outputPath })
    : findMatchingSmoke({ api, environment, identity, describe });
  const smoke = match.observation;
  // The smoke observation must predate the qualification observation: the deployment's
  // own observation is the reference the qualification must agree with.
  if (Date.parse(smoke.collected_at) >= Date.parse(baseline.collected_at)) {
    throw new Error(`Deploy-smoke observation for ${describe()} was collected after the qualification observation (smoke ${smoke.collected_at}, qualification ${baseline.collected_at})`);
  }
  // The comparison excludes `collected_at`: identity is the client/service tuple and the
  // platform body, member by member.
  assertEqual(pickCompared(baseline), pickCompared(smoke), 'Deploy-smoke observation');
  const drift = {
    checked_at: now().toISOString(),
    smoke_run_id: match.run.id,
    smoke_run_attempt: match.attempt,
    smoke_run_head_sha: match.run.head_sha,
    smoke_artifact_id: match.artifact.id,
    smoke_created_at: match.artifact.created_at,
    matched_service_commit: identity.service_commit,
    matched_image_digest: identity.image_digest,
    matched_client_commit: identity.client_commit,
    result: 'matched',
  };
  if (!verifyRecorded) {
    const directory = resolve('.qualification-inputs');
    await mkdir(directory, { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(drift, null, 2)}\n`);
  }
  return drift;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const verifyRecorded = process.argv.includes('--verify-recorded');
  await verifySmokeDrift({ verifyRecorded });
  console.log(verifyRecorded
    ? 'Re-verified the recorded deploy-smoke drift artifact against the qualification observation'
    : 'Deploy-smoke drift verified: the smoke observation agrees with the qualification observation');
}
