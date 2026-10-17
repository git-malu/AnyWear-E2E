import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseStrictJson, validateCompatibility } from './evidence-contract.mjs';
import { assertDeploymentBinding } from './trusted-deployment-inputs.mjs';
import { assertE2EExecution } from './execution-guard.mjs';
import { reviewedInfraSource } from './infra-source.mjs';

// The independent observation of the stage base. E2E never trusts the records
// alone: it checks out the reviewed Infra source at `compatibility.infra.sha` and
// runs that repository's observer against the pinned Infra record. The observer
// reads the three Infra stacks, their deployed Original template content hashes,
// the stage SSM inputs and the Platform runtime identity. The Service record is
// validated by the shared contract; its Workload identity is bound by the HTTP
// evidence in `collect-deployment-evidence.mjs`, because that record belongs to
// the release chain and not to Infra's observation.
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
  const output = resolve(inputsDirectory, 'aws-observation.json');
  execFileSync(process.execPath, [resolve(directory, 'scripts/observe-deployment.mjs'),
    '--expected', resolve(inputsDirectory, 'platform-deployment-record.json'),
    '--output', output,
    '--trusted-infra-root', directory, '--infra-sha', compatibility.infra.sha,
  ], {
    env: environment,
    timeout: 15 * 60_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'],
  });
  const snapshot = parseStrictJson(await readFile(output));
  const helper = await import(pathToFileURL(resolve(directory, 'scripts/observe-deployment.mjs')).href);
  helper.validateDeploymentRecord(records.platform);
  helper.validateDeploymentRecord(records.workload);
  helper.assertObservedMatchesDeployment(records.platform, snapshot);
  return snapshot;
}
