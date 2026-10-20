import { environmentVerdict } from '../beta-sizing-environment.mjs';
import { readMinimumSupportedClient } from '../minimum-supported-client.mjs';
import { SCENARIO_DIRECTORY, qualificationSelection, selectedScenarios } from '../test-selection.mjs';
import { stageContractSchemaHash } from '../vendor/deployment-contract.mjs';
import { configuredStacks } from '../vendor/operation-stacks.mjs';
import { STAGE_CONTRACT_READ_PARAMETERS } from '../vendor/stage-contract-parameters.mjs';

// A v3 qualification fixture. Every member of the record is built from the same
// derivation the live path uses, so the fixture cannot state a shape the producer would
// not write:
//
// - the platform stacks are the vendored `configuredStacks`, sorted by name exactly as
//   the observation records them;
// - the stage inputs are names from the vendored stage contract and the schema hash is
//   `stageContractSchemaHash` over them;
// - the Client version and the Service floor come from the committed
//   `minimum-supported-client.json`, with the deployed Client one version above the
//   floor;
// - the observations bracket the environment verdict the suite would have produced.
//
// Nothing here reads AWS, the filesystem (beyond the committed floor), or a clock.
function qualificationReport() {
  const { tag } = qualificationSelection();
  const suites = selectedScenarios(tag).map(({ file, title, declaresRuntimeSkip }) => ({
    title: file.slice(SCENARIO_DIRECTORY.length),
    file,
    line: 0,
    column: 0,
    specs: [],
    suites: [{
      title,
      file,
      line: 1,
      column: 1,
      specs: [{
        title: `${title} acceptance`,
        ok: true,
        tags: [],
        tests: [{
          timeout: 30_000,
          annotations: declaresRuntimeSkip ? [{ type: 'skip', description: 'declared runtime skip' }] : [],
          expectedStatus: declaresRuntimeSkip ? 'skipped' : 'passed',
          projectId: 'chromium',
          projectName: 'chromium',
          results: [],
          status: declaresRuntimeSkip ? 'skipped' : 'expected',
        }],
        id: `fixture-${file}`,
        file,
        line: 1,
        column: 1,
      }],
    }],
  }));
  return Buffer.from(`${JSON.stringify({ config: { rootDir: SCENARIO_DIRECTORY.slice(0, -1) }, suites, errors: [], stats: {} }, null, 2)}\n`);
}

const sortedStacks = () => [...configuredStacks]
  .map(({ stack_name: name, region }) => ({ name, region }))
  .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));

const parameterRows = (hash) => [...STAGE_CONTRACT_READ_PARAMETERS]
  .sort()
  .slice(0, 3)
  .map((parameter, index) => ({
    parameter,
    version: String(index + 1),
    value_sha256: hash(((index % 10) + 0).toString(16)),
  }));

// One observation: the two live identities, this repository's own platform snapshot, and
// the literal `authenticated: true` assertion that it was taken with the Beta principal.
function observation({ collectedAt, clientSha, serviceSha, image, clientDomain }) {
  const inputs = parameterRows((letter) => letter.repeat(64));
  return {
    collected_at: collectedAt,
    client: { url: `https://${clientDomain}`, source_commit: clientSha, built_at: '2026-10-07T00:00:00.000Z' },
    service: { url: 'https://api123.cloudfront.net', service_commit: serviceSha, image_digest: image },
    platform: {
      stacks: sortedStacks().map(({ name, region }) => ({ name, region, template_sha256: 'd'.repeat(64) })),
      inputs,
      schema_sha256: stageContractSchemaHash(inputs),
      lambdas: {
        'pre-sign-up': { code_sha256: Buffer.from('e'.repeat(64), 'hex').toString('base64'), configuration_sha256: 'f'.repeat(64) },
        'post-confirmation': { code_sha256: Buffer.from('b'.repeat(64), 'hex').toString('base64'), configuration_sha256: 'e'.repeat(64) },
      },
      queue_config_sha256: 'a'.repeat(64),
      client_domain: clientDomain,
    },
    authenticated: true,
  };
}

export function qualificationFixture({
  expectedSource = 'trigger',
  trigger = 'manual',
  dispatchedBy = null,
} = {}) {
  const sha = (letter) => letter.repeat(40);
  const hash = (letter) => letter.repeat(64);
  const floor = readMinimumSupportedClient();
  const clientSha = sha('a');
  const serviceSha = sha('b');
  const image = `sha256:${hash('c')}`;
  const clientDomain = 'client123.cloudfront.net';
  const clientVersion = floor.version + 1;
  const minimumClientVersion = floor.version;
  const before = observation({ collectedAt: '2026-10-08T00:00:00.000Z', clientSha, serviceSha, image, clientDomain });
  const after = observation({ collectedAt: '2026-10-08T00:10:00.000Z', clientSha, serviceSha, image, clientDomain });
  const live = {
    client: { ...before.client, client_version: clientVersion },
    service: { ...before.service, minimum_client_version: minimumClientVersion },
  };
  const serviceArtifacts = {
    repository: 'git-malu/AnyWear-Service',
    release_id: 10,
    tag: `service-artifacts-${serviceSha}`,
    manifest_asset_id: 11,
    manifest_sha256: hash('d'),
  };
  // Retained-inert pin scaffolding. #180 removed the pin from every qualification path,
  // but the sizing measurement (`fixtures/beta-sizing-source.mjs`, #141) still builds a
  // sizing source proof from a pin-shaped object, and its benchmark tests are part of
  // `test:core`. This member exists only for that retained fixture; no qualification
  // module reads it, and it disappears with the sizing apparatus and the pin in Wave 2.
  const compatibility = {
    version: 3,
    client: { repository: 'git-malu/AnyWear-Client', sha: clientSha },
    service: { repository: 'git-malu/AnyWear-Service', sha: serviceSha },
    infra: { repository: 'git-malu/AnyWear-Infra', sha: sha('e') },
    platform: {
      producer: 'git-malu/AnyWear-Infra',
      producer_sha: sha('e'),
      record: {
        producer: 'git-malu/AnyWear-Infra', workflow_path: '.github/workflows/runtime.yml', status: 'recorded',
        run_id: 30, run_attempt: 2, artifact_id: 40, record_sha256: hash('b'),
      },
    },
    workload: { producer: 'git-malu/AnyWear-Service', producer_sha: serviceSha },
    deployment: {
      producer: 'git-malu/AnyWear-Service', workflow_path: '.github/workflows/service-artifacts.yml', status: 'recorded',
      run_id: 50, run_attempt: 1, artifact_id: 60, record_sha256: hash('e'),
    },
    // The historical pin shape has no `tag` member; the v3 record identity above does.
    service_artifacts: {
      repository: serviceArtifacts.repository,
      release_id: serviceArtifacts.release_id,
      manifest_asset_id: serviceArtifacts.manifest_asset_id,
      manifest_sha256: serviceArtifacts.manifest_sha256,
    },
  };
  const input = {
    result: 'passed',
    operation: 'full',
    e2eSha: sha('d'),
    repository: 'git-malu/AnyWear-E2E',
    runId: '123',
    runAttempt: '1',
    serverUrl: 'https://github.com',
    awsAccountId: '650880818323',
    awsRegion: 'ap-east-1',
    workflowPath: '.github/workflows/beta-qualification.yml',
    workflowRef: 'git-malu/AnyWear-E2E/.github/workflows/beta-qualification.yml@refs/heads/main',
    trigger,
    dispatchedBy,
  };
  const expected = expectedSource === 'live'
    ? { service_commit: null, client_commit: null, source: 'live' }
    : { service_commit: serviceSha, client_commit: clientSha, source: 'trigger' };
  // The environment gate every passing record must state. The comparison input is the
  // unchanged window `compareWorkerIdentity` reports when one worker task definition
  // serves both ends of the suite; the record itself is produced by `environmentVerdict`,
  // which owns the verdict key set, so this fixture cannot drift from that shape.
  const environment = {
    record: environmentVerdict({
      comparison: {
        verdict: 'unchanged',
        reason: 'The worker task set and the worker task definition are unchanged across the suite window',
        before_observed_at: before.collected_at,
        after_observed_at: after.collected_at,
        before_identity_sha256: hash('a'),
        after_identity_sha256: hash('a'),
        before_task_arns: [],
        after_task_arns: [],
        added_task_arns: [],
        removed_task_arns: [],
        task_definition_changed: false,
      },
      suiteOutcome: 'success',
    }),
    problem: null,
  };
  return {
    floor,
    clientSha,
    serviceSha,
    image,
    clientDomain,
    clientVersion,
    minimumClientVersion,
    compatibility,
    input,
    expected,
    evidence: { before, after, service_artifacts: serviceArtifacts, live },
    environment,
    report: qualificationReport(),
  };
}
