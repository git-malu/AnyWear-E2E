import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertEqual, parseStrictJson, repositories, validateCompatibility } from './evidence-contract.mjs';
import { assertDeploymentBinding } from './trusted-deployment-inputs.mjs';
import { assertE2EWriterWindow } from './writer-window.mjs';
import { reviewedInfraSource } from './infra-source.mjs';

export async function pinnedInfraObserver(compatibility, record, environment = process.env) {
  validateCompatibility(compatibility);
  assertDeploymentBinding(record, compatibility);
  assertE2EWriterWindow(environment);
  const directory = reviewedInfraSource(compatibility, environment);
  const inputsDirectory = resolve(environment.QUALIFICATION_INPUTS_DIR ?? '.qualification-inputs');
  const output = resolve(inputsDirectory, 'aws-observation.json');
  execFileSync(process.execPath, [resolve(directory, 'scripts/observe-deployment.mjs'),
    '--expected', resolve(inputsDirectory, 'deployment-record.json'), '--output', output,
    '--trusted-infra-root', directory, '--infra-sha', compatibility.infra.sha,
  ], {
    env: { ...environment,
      OBSERVATION_WRITER_WINDOW: environment.E2E_EXPECTED_WRITER_WINDOW_TOKEN,
      OBSERVATION_WINDOW_SHA: environment.E2E_WRITER_SHA,
      OBSERVATION_WINDOW_EXPIRES_AT: environment.E2E_WRITER_EXPIRES_AT,
      OBSERVATION_WINDOW_RECORD_URL: environment.E2E_WRITER_RECORD_URL,
    },
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
