import { byteHash } from '../evidence-contract.mjs';
import { environmentVerdict } from '../beta-sizing-environment.mjs';
import { SCENARIO_DIRECTORY, qualificationSelection, selectedScenarios } from '../test-selection.mjs';
import {
  DEPLOYMENT_GATE_COMPARISONS, DEPLOYMENT_GATE_THRESHOLDS, deploymentAlarmName, deploymentBakeName,
  stageContractSchemaHash,
} from '../vendor/deployment-contract.mjs';

// Every fixture record is issued from a run's own Playwright JSON report, so the fixture
// holds one. It is built from the real declared membership rather than a hand-written list:
// one spec and one test per member of the release-gating selection, with
// `status: 'skipped'` only where the spec declares a runtime skip. A fixture can therefore
// neither claim a scenario this repository does not select nor record a skip no spec admits.
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

// The recorded system tuple is four stacks: three always-present Infra stacks
// (Foundation, the persistent Beta Base stack and Billing) plus the Service-owned
// Runtime release slice. `AnyWearEgressStack-beta` is operation-owned and is
// deliberately absent here: it is never part of a deployment record or the
// authenticated observation manifest.
const STACK_REGIONS = Object.freeze({
  AnyWearFoundationStack: 'ap-east-1',
  'AnyWearPlatformStack-beta': 'ap-east-1',
  'AnyWearBillingStack-beta': 'us-east-1',
  'AnyWearRuntimeStack-beta': 'ap-east-1',
});

const stageInputs = (hash, count, prefix = 'stage_param') => Array.from({ length: count }, (_, index) => ({
  parameter: `/anywear/beta/${prefix}_${String(index).padStart(2, '0')}`,
  version: String(index + 1),
  value_sha256: hash(((index % 10) + 0).toString(16)),
})).sort((a, b) => a.parameter.localeCompare(b.parameter));

// One healthy 600-second bake for the Beta stage. It is written with the shared
// contract's own thresholds, comparisons, alarm names and bake name so the fixture
// states the exact shape a real v4 Service record must carry; the negative tests
// mutate it. Nothing here reads AWS, the filesystem or a clock.
export function deploymentGate({ serviceSha, imageDigest }) {
  const stage = 'beta';
  const alarms = (name) => deploymentAlarmName(stage, name).map((alarmName) => ({ name: alarmName, state: 'OK' }));
  const signal = (name, value, reads, exceptions = []) => ({
    name,
    state: 'not-breaching',
    value,
    threshold: { ...DEPLOYMENT_GATE_THRESHOLDS[name] },
    comparison: DEPLOYMENT_GATE_COMPARISONS[name],
    alarms: alarms(name),
    reads,
    exceptions,
  });
  const loadBalancer = `app/${stage}-anywear-api/0123456789abcdef`;
  const cloudWatch = (metricName, statistic, periodSeconds, datapoints) => ({
    source: 'cloudwatch', namespace: 'AWS/ApplicationELB', metric_name: metricName,
    dimensions: { LoadBalancer: loadBalancer }, statistic, period_seconds: periodSeconds, datapoints,
  });
  return {
    name: deploymentBakeName(stage),
    result: 'passed',
    started_at: '2026-10-07T00:00:00.000Z',
    ended_at: '2026-10-07T00:10:00.000Z',
    duration_seconds: 600,
    service_sha: serviceSha,
    image_digest: imageDigest,
    probe: { interval_seconds: 15, probes_sent: 40, request_floor: 30 },
    signals: [
      signal('alb_5xx_rate', { target_5xx: 0, elb_5xx: 0, request_count: 40 }, [
        cloudWatch('HTTPCode_Target_5XX_Count', 'Sum', 60, 10),
        cloudWatch('HTTPCode_ELB_5XX_Count', 'Sum', 60, 10),
        cloudWatch('RequestCount', 'Sum', 60, 10),
      ]),
      signal('alb_p95_latency', { p95_milliseconds: 120 }, [
        cloudWatch('TargetResponseTime', 'p95', 600, 1),
      ]),
      signal('ecs_running_not_desired', {
        longest_gap_seconds: 0,
        max_sample_gap_seconds: 30,
        samples: 20,
        services: {
          api: { running_count: 1, desired_count: 1, deployment_count: 1, rollout_state: 'COMPLETED' },
          worker: { running_count: 1, desired_count: 1, deployment_count: 1, rollout_state: 'COMPLETED' },
        },
      }, [{ source: 'ecs', cluster: `${stage}-anywear`,
        services: [`${stage}-anywear-api`, `${stage}-anywear-worker`], samples: 20 }]),
      signal('sqs_oldest_message_age', { vto_seconds: 0, auto_tagging_seconds: 0 }, [
        { source: 'cloudwatch', namespace: 'AWS/SQS', metric_name: 'ApproximateAgeOfOldestMessage',
          dimensions: { QueueName: `${stage}-anywear-vto` }, statistic: 'Maximum', period_seconds: 600, datapoints: 1 },
        { source: 'cloudwatch', namespace: 'AWS/SQS', metric_name: 'ApproximateAgeOfOldestMessage',
          dimensions: { QueueName: `${stage}-anywear-auto-tagging` }, statistic: 'Maximum', period_seconds: 600, datapoints: 1 },
        { source: 'sqs', queue_name: `${stage}-anywear-vto`,
          attributes: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible',
            'ApproximateNumberOfMessagesDelayed'], samples: 20 },
        { source: 'sqs', queue_name: `${stage}-anywear-auto-tagging`,
          attributes: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible',
            'ApproximateNumberOfMessagesDelayed'], samples: 20 },
      ]),
      signal('sqs_dlq_depth', { vto_depth: 0, auto_tagging_depth: 0 }, [
        { source: 'sqs', queue_name: `${stage}-anywear-vto-dlq`, attribute: 'ApproximateNumberOfMessages', samples: 20 },
        { source: 'sqs', queue_name: `${stage}-anywear-auto-tagging-dlq`, attribute: 'ApproximateNumberOfMessages', samples: 20 },
      ]),
      signal('outbox_oldest_age', { oldest_age_milliseconds: 0, backlog: 0, lines_observed: 10 }, [{
        source: 'logs', log_group: `/anywear/${stage}/worker`, filter_pattern: '"Durable task outbox metrics"', samples: 10,
      }]),
    ],
  };
}

function records({ sha, hash, platformProducerSha, workloadProducerSha }) {
  const image = `sha256:${hash('c')}`;
  const platformInputs = stageInputs(hash, 4, 'platform');
  const workloadInputs = stageInputs(hash, 29);
  const stack = (name, producerRepository, producerSha) => ({
    name, region: STACK_REGIONS[name], producer_repository: producerRepository,
    producer_sha: producerSha, template_sha256: hash('d'),
  });
  const lambdas = {
    'pre-sign-up': { code_sha256: Buffer.from(hash('e'), 'hex').toString('base64'), configuration_sha256: hash('f') },
    'post-confirmation': { code_sha256: Buffer.from(hash('f'), 'hex').toString('base64'), configuration_sha256: hash('f') },
  };
  const platformRecord = {
    schema_version: 3,
    record_type: 'anywear_infra_deployment',
    producer: {
      repository: 'git-malu/AnyWear-Infra',
      sha: platformProducerSha,
      workflow_path: '.github/workflows/runtime.yml',
      workflow_ref: 'git-malu/AnyWear-Infra/.github/workflows/runtime.yml@refs/heads/main',
      run_id: 30,
      run_attempt: 2,
    },
    stacks: [
      stack('AnyWearFoundationStack', 'git-malu/AnyWear-Infra', platformProducerSha),
      stack('AnyWearPlatformStack-beta', 'git-malu/AnyWear-Infra', platformProducerSha),
      stack('AnyWearBillingStack-beta', 'git-malu/AnyWear-Infra', platformProducerSha),
    ],
    inputs: platformInputs,
    observed: {
      lambdas: structuredClone(lambdas),
      queue_config_sha256: hash('e'),
      client_sha: sha('a'),
      endpoints: { client: 'https://client123.cloudfront.net' },
    },
    schema: { content_sha256: stageContractSchemaHash(platformInputs) },
  };
  const workloadRecord = {
    schema_version: 4,
    record_type: 'anywear_service_deployment',
    producer: {
      repository: 'git-malu/AnyWear-Service',
      sha: workloadProducerSha,
      workflow_path: '.github/workflows/service-artifacts.yml',
      workflow_ref: 'git-malu/AnyWear-Service/.github/workflows/service-artifacts.yml@refs/heads/main',
      run_id: 50,
      run_attempt: 1,
    },
    stacks: [stack('AnyWearRuntimeStack-beta', 'git-malu/AnyWear-Service', workloadProducerSha)],
    inputs: workloadInputs,
    observed: {
      service_sha: sha('b'),
      image_digest: image,
      minimum_client_version: 0,
      ecs: Object.fromEntries(['api', 'worker'].map((purpose) => [purpose, {
        service_arn: `arn:aws:ecs:ap-east-1:650880818323:service/beta-anywear/beta-anywear-${purpose}`,
        task_definition_arn: `arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-${purpose}:1`,
        task_definition_sha256: hash(purpose === 'api' ? 'd' : 'e'),
        image_digest: image,
      }])),
      endpoints: { api: 'https://api123.cloudfront.net' },
    },
    schema: { content_sha256: stageContractSchemaHash(workloadInputs) },
    gate: deploymentGate({ serviceSha: sha('b'), imageDigest: image }),
  };
  return { platformRecord, workloadRecord };
}

export function qualificationFixture({ deferred = false } = {}) {
  const sha = (letter) => letter.repeat(40);
  const hash = (letter) => letter.repeat(64);
  const image = `sha256:${hash('c')}`;
  const platformProducerSha = sha('e');
  const workloadProducerSha = sha('b');
  const { platformRecord, workloadRecord } = records({ sha, hash, platformProducerSha, workloadProducerSha });
  const platformBytes = Buffer.from(`${JSON.stringify(platformRecord, null, 2)}\n`);
  const workloadBytes = Buffer.from(`${JSON.stringify(workloadRecord, null, 2)}\n`);
  const identity = ({ producer, workflow_path, run_id, run_attempt, artifact_id, record_sha256 }) => deferred
    ? { producer, workflow_path, status: 'deferred', reason: `no ${producer} record exists yet; pin the first authorized run` }
    : { producer, workflow_path, status: 'recorded', run_id, run_attempt, artifact_id, record_sha256 };
  const compatibility = {
    version: 3,
    client: { repository: 'git-malu/AnyWear-Client', sha: sha('a') },
    minimum_supported_client: { version: 0, sha: sha('c') },
    service: { repository: 'git-malu/AnyWear-Service', sha: sha('b') },
    infra: { repository: 'git-malu/AnyWear-Infra', sha: sha('e') },
    platform: {
      producer: 'git-malu/AnyWear-Infra',
      producer_sha: platformProducerSha,
      record: identity({ producer: 'git-malu/AnyWear-Infra', workflow_path: '.github/workflows/runtime.yml',
        run_id: 30, run_attempt: 2, artifact_id: 40, record_sha256: byteHash(platformBytes) }),
    },
    workload: { producer: 'git-malu/AnyWear-Service', producer_sha: workloadProducerSha },
    deployment: identity({ producer: 'git-malu/AnyWear-Service', workflow_path: '.github/workflows/service-artifacts.yml',
      run_id: 50, run_attempt: 1, artifact_id: 60, record_sha256: byteHash(workloadBytes) }),
    service_artifacts: { repository: 'git-malu/AnyWear-Service', release_id: 10, manifest_asset_id: 11, manifest_sha256: hash('a') },
  };
  const input = {
    result: 'passed', operation: 'full', e2eSha: sha('d'), repository: 'git-malu/AnyWear-E2E', runId: '123', runAttempt: '1', serverUrl: 'https://github.com',
    awsAccountId: '650880818323', awsRegion: 'ap-east-1', workflowPath: '.github/workflows/beta-qualification.yml',
    workflowRef: 'git-malu/AnyWear-E2E/.github/workflows/beta-qualification.yml@refs/heads/main',
  };
  const before = {
    schema_version: 3,
    collected_at: '2026-10-08T00:00:00.000Z',
    client: { url: platformRecord.observed.endpoints.client, source_commit: compatibility.client.sha, built_at: '2026-10-07T00:00:00.000Z' },
    service: { url: workloadRecord.observed.endpoints.api, source_commit: compatibility.service.sha, image_digest: image },
    compatibility,
    platform: { identity: compatibility.platform.record, record: platformRecord },
    workload: { identity: compatibility.deployment, record: workloadRecord },
    service_artifacts: compatibility.service_artifacts,
    authenticated: structuredClone({ stacks: platformRecord.stacks, inputs: platformRecord.inputs,
      observed: platformRecord.observed, schema: platformRecord.schema }),
  };
  const after = structuredClone(before);
  after.collected_at = '2026-10-08T00:10:00.000Z';
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
  const bytes = { platform: platformBytes, workload: workloadBytes };
  return { compatibility, platformRecord, workloadRecord, bytes, input, evidence: { before, after }, environment, report: qualificationReport() };
}
