import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertEqual, parseStrictJson, repositories, validateCompatibility } from './evidence-contract.mjs';
import { assertDeploymentBinding, repositoryReadEnvironment } from './trusted-deployment-inputs.mjs';
import { assertE2EWriterWindow } from './writer-window.mjs';
import { reviewedInfraSource } from './infra-source.mjs';

export async function pinnedInfraObserver(compatibility, record, environment = process.env) {
  validateCompatibility(compatibility);
  assertDeploymentBinding(record, compatibility);
  assertE2EWriterWindow(environment);
  const serviceEnvironment = repositoryReadEnvironment(repositories.service, environment);
  const directory = reviewedInfraSource(compatibility, environment);
  const inputsDirectory = resolve(environment.QUALIFICATION_INPUTS_DIR ?? '.qualification-inputs');
  const output = resolve(inputsDirectory, 'aws-observation.json');
  execFileSync(process.execPath, [resolve(directory, 'scripts/observe-deployment.mjs'),
    '--expected', resolve(inputsDirectory, 'deployment-record.json'), '--output', output,
    '--selection', record.selection.file, '--selection-sha256', record.selection.sha256,
    '--trusted-infra-root', directory, '--infra-sha', compatibility.infra.sha,
  ], {
    env: serviceEnvironment,
    timeout: 15 * 60_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'],
  });
  const snapshot = parseStrictJson(await readFile(output));
  const helper = await import(pathToFileURL(resolve(directory, 'scripts/observe-deployment.mjs')).href);
  helper.validateDeploymentRecord(record);
  helper.assertObservedMatchesDeployment(record, snapshot);
  const verification = snapshot.schema?.verification;
  if (!verification) throw new Error('Authenticated schema verification is missing');
  assertEqual(verification.executor, {
    repository: repositories.e2e, sha: environment.GITHUB_SHA,
    workflow_path: environment.GITHUB_WORKFLOW_REF?.split('/AnyWear-E2E/')[1]?.split('@')[0],
    run_id: Number(environment.GITHUB_RUN_ID), run_attempt: Number(environment.GITHUB_RUN_ATTEMPT),
  }, 'Schema observation executor');
  if (verification.source_repository !== repositories.infra || verification.source_sha !== compatibility.infra.sha) throw new Error('Schema observation command source mismatch');
  if (verification.image_digest !== record.observed.image_digest || verification.service_sha !== compatibility.service.sha) throw new Error('Schema observation selected image mismatch');
  return snapshot;
}
