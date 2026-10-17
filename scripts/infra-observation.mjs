import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseStrictJson, validateCompatibility } from './evidence-contract.mjs';
import { assertDeploymentBinding, validateProducerRecord } from './trusted-deployment-inputs.mjs';
import { assertObservedMatchesDeployment } from './vendor/deployment-contract.mjs';
import { assertE2EExecution } from './execution-guard.mjs';
import { reviewedInfraSource } from './infra-source.mjs';

// The independent observation of the stage base. E2E never trusts the records
// alone: it checks out the reviewed Infra source at `compatibility.infra.sha` and
// runs that repository's `observeDeployment` module against the pinned Infra
// record. The observer reads the three Infra stacks, their deployed Original
// template content hashes, the stage SSM inputs and the Platform runtime identity.
// The Service record is validated by the shared contract; its Workload identity is
// bound by the HTTP evidence in `collect-deployment-evidence.mjs`, because that
// record belongs to the release chain and not to Infra's observation.
//
// The final C observer is a module, not a CLI. Its protected-executor gate reads
// `GITHUB_SHA` as the observed source, so the observation environment carries the
// reviewed Infra SHA while the surrounding E2E execution guard still binds this
// run's own E2E repository, workflow, run and attempt. The observation body
// carries no executor identity; the qualification record does.
export async function pinnedInfraObserver(compatibility, records, environment = process.env) {
  validateCompatibility(compatibility);
  for (const [label, identity] of [['platform', compatibility.platform.record], ['workload', compatibility.deployment]]) {
    if (identity.status === 'deferred') throw new Error(`Deployment evidence deferred for ${label}: ${identity.reason}`);
  }
  assertDeploymentBinding(records.platform, compatibility);
  assertDeploymentBinding(records.workload, compatibility);
  assertE2EExecution(environment);
  const directory = reviewedInfraSource(compatibility, environment);
  const inputsDirectory = resolve(environment.QUALIFICATION_INPUTS_DIR ?? '.qualification-inputs');
  await mkdir(inputsDirectory, { recursive: true });
  const helper = await import(pathToFileURL(resolve(directory, 'scripts/observe-deployment.mjs')).href);
  const observationEnvironment = { ...environment, GITHUB_SHA: compatibility.infra.sha };
  const body = await helper.observeDeployment({ infraSha: compatibility.infra.sha, env: observationEnvironment });
  validateProducerRecord(records.platform);
  validateProducerRecord(records.workload);
  assertObservedMatchesDeployment(records.platform, body);
  const output = resolve(inputsDirectory, 'aws-observation.json');
  await writeFile(output, `${JSON.stringify(body, null, 2)}\n`);
  return parseStrictJson(await readFile(output));
}
