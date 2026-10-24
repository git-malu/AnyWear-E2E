import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assertStableObservation, collectDeploymentEvidence } from './qualification-record.mjs';
import { liveObservationIo, observePlatform } from './infra-observation.mjs';
import { parseStrictJson } from './evidence-contract.mjs';
import { assertE2EExecution } from './execution-guard.mjs';

// #180: one observation of the live deployed system. It reads the two live identities
// (Client `build-metadata.json`, Service `/health`), takes this repository's own
// authenticated platform snapshot, and states `authenticated: true`. It reads no
// compatibility file and no producer deployment record. The workflow runs it once
// before the suite and once after it with `QUALIFICATION_BASELINE_PATH` set to the
// first output, and the two observations must be identical.
assertE2EExecution();
const expected = {
  service_commit: process.env.EXPECTED_SERVICE_COMMIT || null,
  client_commit: process.env.EXPECTED_CLIENT_COMMIT || null,
};
const identity = await collectDeploymentEvidence({
  clientUrl: process.env.E2E_CLIENT_URL,
  serviceUrl: process.env.E2E_SERVICE_URL,
  runId: process.env.GITHUB_RUN_ID,
}, expected);
// The Client-domain discovery matches the CloudFront distribution serving the host of
// the live Client URL, so the host is passed into the observation from the validated
// live identity.
const platform = await observePlatform({ io: liveObservationIo(), clientHost: new URL(identity.client.url).host });
const observation = {
  collected_at: new Date().toISOString(),
  client: identity.client,
  service: identity.service,
  platform,
  authenticated: true,
};

if (process.env.QUALIFICATION_BASELINE_PATH) {
  const baselinePath = resolve(process.env.QUALIFICATION_BASELINE_PATH);
  const baseline = parseStrictJson(await readFile(baselinePath));
  assertStableObservation(baseline, observation);
}

const inputsDirectory = resolve(process.env.QUALIFICATION_INPUTS_DIR ?? '.qualification-inputs');
await mkdir(inputsDirectory, { recursive: true });
// The versions are not part of an observation member: the record states them under
// `revisions`. The latest collect wins, and the after-observation and this file are the
// same read, so the record cannot claim a version its own observation contradicts.
const live = {
  client: { ...identity.client, client_version: identity.client_version },
  service: { ...identity.service, minimum_client_version: identity.minimum_client_version },
};
await writeFile(resolve(inputsDirectory, 'live-identity.json'), `${JSON.stringify(live, null, 2)}\n`);

const outputPath = resolve(process.env.QUALIFICATION_EVIDENCE_PATH ?? 'deployment-evidence.json');
await writeFile(outputPath, `${JSON.stringify(observation, null, 2)}\n`);
const short = (value) => String(value).slice(0, 7);
console.log(`Observed the live tuple: Client ${short(observation.client.source_commit)} (version ${identity.client_version}), `
  + `Service ${short(observation.service.service_commit)} (${observation.service.image_digest.slice(0, 19)}...), `
  + `minimum Client ${identity.minimum_client_version}, platform ${platform.schema_sha256.slice(0, 12)}...`);
