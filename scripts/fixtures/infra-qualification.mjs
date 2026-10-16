import { byteHash, payloadDigest } from '../evidence-contract.mjs';
import { environmentVerdict } from '../beta-sizing-environment.mjs';

export function qualificationFixture({ forwardSchema = false, imageAhead = false } = {}) {
  const sha = (letter) => letter.repeat(40);
  const hash = (letter) => letter.repeat(64);
  const image = `sha256:${hash('c')}`;
  const components = {
    image: { repository_uri: '650880818323.dkr.ecr.ap-east-1.amazonaws.com/beta-anywear-service', digest: image, service_sha: sha('b') },
    lambdas: Object.fromEntries(['pre_sign_up', 'post_confirmation'].map((name, index) => [name, {
      asset_id: index + 20, service_sha: sha('b'), file: `${name}.zip`, sha256: hash(index ? 'e' : 'f'),
      code_sha256: Buffer.from(hash(index ? 'e' : 'f'), 'hex').toString('base64'),
      handler: 'index.handler', runtime: 'nodejs24.x', source_lock_sha256: hash('a'), bundler_version: 'esbuild@0.28.0',
      build_options: { bundle: true, platform: 'node', target: 'node24', format: 'cjs', minify: true, sourcemap: 'external', packages: 'bundle', external: [] },
    }])),
    runtime_policy: { asset_id: 22, service_sha: sha('b'), file: 'runtime-policy.json', sha256: hash('d'), content_sha256: hash('e') },
    schema: { asset_id: 23, service_sha: sha('b'), file: 'service-schema.json', sha256: hash('a'), journal_sha256: hash('f'), current_version: imageAhead ? 17 : 16, minimum_version: 16 },
  };
  const release = { repository: 'git-malu/AnyWear-Service', id: 10, manifest_asset_id: 11, manifest_sha256: hash('a') };
  const selector = { schema_version: 2, record_type: 'anywear_infra_selection', release, ...components };
  const selected = Array.from({ length: imageAhead ? 18 : 17 }, (_, index) => ({ id: index.toString(16).padStart(64, '0'), created_at: 1000 + index }));
  const applied = structuredClone(selected.slice(0, 17));
  if (forwardSchema) applied.push(selected[17] ?? { id: '17'.padStart(64, '0'), created_at: 1017 });
  const verification = {
    command_sha256: hash('a'), source_repository: 'git-malu/AnyWear-Infra', source_sha: sha('e'),
    image_digest: image, service_sha: sha('b'),
    executor: { repository: 'git-malu/AnyWear-Infra', sha: sha('e'), workflow_path: '.github/workflows/runtime.yml', run_id: 30, run_attempt: 2 },
    task_arn: `arn:aws:ecs:ap-east-1:650880818323:task/beta-anywear/${'a'.repeat(32)}`,
    task_definition_arn: 'arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-artifact-verify:1',
  };
  const deployment = {
    schema_version: 2, record_type: 'anywear_infra_deployment',
    infra: { repository: 'git-malu/AnyWear-Infra', sha: sha('e'), workflow_path: '.github/workflows/runtime.yml', workflow_ref: 'git-malu/AnyWear-Infra/.github/workflows/runtime.yml@refs/heads/main', run_id: 30, run_attempt: 2 },
    selection: { file: 'selections/beta-baseline.json', sha256: payloadDigest(selector), release, components },
    stacks: ['AnyWearFoundationStack', 'AnyWearPlatformStack-beta', 'AnyWearWorkloadStack-beta', 'AnyWearBillingStack-beta'].map((stack_name) => ({
      stack_name, region: stack_name.includes('Billing') ? 'us-east-1' : 'ap-east-1',
      source_repository: stack_name.includes('Foundation') || stack_name.includes('Billing') ? 'git-malu/AnyWear-Service' : 'git-malu/AnyWear-Infra',
      source_sha: stack_name.includes('Foundation') || stack_name.includes('Billing') ? sha('b') : sha('e'), template_sha256: hash('d'),
    })),
    observed: { service_sha: sha('b'), image_digest: image,
      ecs: Object.fromEntries(['api', 'worker'].map((purpose) => [purpose, {
        service_arn: `arn:aws:ecs:ap-east-1:650880818323:service/beta-anywear/beta-anywear-${purpose}`,
        task_definition_arn: `arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-${purpose}:1`, image_digest: image,
      }])),
      lambdas: { 'pre-sign-up': { code_sha256: components.lambdas.pre_sign_up.code_sha256, configuration_sha256: hash('f') },
        'post-confirmation': { code_sha256: components.lambdas.post_confirmation.code_sha256, configuration_sha256: hash('f') } },
      policy_content_sha256: components.runtime_policy.content_sha256, queue_config_sha256: hash('e'), client_sha: sha('a'),
      endpoints: { api: 'https://api123.cloudfront.net', client: 'https://client123.cloudfront.net' },
    },
    schema: { selected_journal_sha256: components.schema.journal_sha256, observed_applied_journal_sha256: payloadDigest(applied),
      selected_migration_ids: selected, applied_migration_ids: applied, selected_current_version: imageAhead ? 17 : 16, minimum_schema_version: 16, minimum_migration_count: 17,
      applied_schema_version: forwardSchema ? 17 : 16, compatibility_result: 'compatible', verification },
  };
  const compatibility = {
    version: 2, client: { repository: 'git-malu/AnyWear-Client', sha: sha('a') }, service: { repository: 'git-malu/AnyWear-Service', sha: sha('b') },
    infra: { repository: 'git-malu/AnyWear-Infra', sha: sha('e') },
    service_artifacts: { repository: release.repository, release_id: release.id, manifest_asset_id: release.manifest_asset_id, manifest_sha256: release.manifest_sha256 },
    deployment: { repository: 'git-malu/AnyWear-Infra', workflow_path: '.github/workflows/runtime.yml', run_id: 30, run_attempt: 2, artifact_id: 40, record_sha256: byteHash(`${JSON.stringify(deployment, null, 2)}\n`) },
  };
  const input = {
    result: 'passed', e2eSha: sha('d'), repository: 'git-malu/AnyWear-E2E', runId: '123', runAttempt: '1', serverUrl: 'https://github.com',
    awsAccountId: '650880818323', awsRegion: 'ap-east-1', workflowPath: '.github/workflows/beta-qualification.yml',
    workflowRef: 'git-malu/AnyWear-E2E/.github/workflows/beta-qualification.yml@refs/heads/main',
  };
  const snapshot = structuredClone({ stacks: deployment.stacks, observed: deployment.observed, schema: deployment.schema });
  snapshot.schema.verification.executor = { repository: input.repository, sha: input.e2eSha, workflow_path: input.workflowPath, run_id: 123, run_attempt: 1 };
  snapshot.schema.verification.task_arn = `arn:aws:ecs:ap-east-1:650880818323:task/beta-anywear/${'b'.repeat(32)}`;
  const before = {
    schema_version: 2, collected_at: '2026-10-08T00:00:00.000Z',
    client: { url: deployment.observed.endpoints.client, source_commit: compatibility.client.sha, built_at: '2026-10-07T00:00:00.000Z' },
    service: { url: deployment.observed.endpoints.api, source_commit: compatibility.service.sha, image_digest: image },
    compatibility, deployment, service_artifacts: compatibility.service_artifacts, authenticated: snapshot,
  };
  const after = structuredClone(before);
  after.collected_at = '2026-10-08T00:10:00.000Z';
  after.authenticated.schema.verification.task_arn = `arn:aws:ecs:ap-east-1:650880818323:task/beta-anywear/${'c'.repeat(32)}`;
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
  return { compatibility, deployment, input, evidence: { before, after }, environment };
}
