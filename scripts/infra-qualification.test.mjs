import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertEqual, byteHash, canonicalJson, parseStrictJson,
} from './evidence-contract.mjs';
import { qualificationFixture } from './fixtures/infra-qualification.mjs';
import { assertE2EExecution } from './execution-guard.mjs';
import { liveObservationIo, observePlatform } from './infra-observation.mjs';
import {
  SERVICE_RELEASE_ASSET_NAMES,
  buildQualificationRecord, validateObservation, verifyQualificationForPromotion,
} from './qualification-record.mjs';
import { assertRecoveryArtifact, prepareAccountRecovery } from './account-recovery-inputs.mjs';
import { configuredStacks } from './vendor/operation-stacks.mjs';
import { stageContractSchemaHash } from './vendor/deployment-contract.mjs';

const now = new Date('2026-10-08T00:20:00.000Z');
const qualify = (f) => buildQualificationRecord(f.input, f.expected, f.evidence, now, f.environment, f.report);
const PLATFORM_STACK = 'AnyWearPlatformStack-beta';
const DEFAULT_OUTPUTS = {
  [PLATFORM_STACK]: {
    VtoQueueUrl: 'https://sqs.ap-east-1.amazonaws.com/650880818323/beta-anywear-vto',
    AutoTaggingQueueUrl: 'https://sqs.ap-east-1.amazonaws.com/650880818323/beta-anywear-auto-tagging',
    ClientDistributionDomainName: 'client123.cloudfront.net',
  },
};

// The AWS CLI double for the authenticated platform observation. Every read the
// observation performs is answered here, and a test can fail or change exactly one
// answer so the observation's own refusals are exercised without AWS. `calls` records
// the exact `{args, region}` of every read, so a test can assert which region each
// regional call actually used.
function observationIo({
  account = '650880818323', stackStatus = 'UPDATE_COMPLETE', secondStatus = stackStatus,
  secondUpdatedTime = '2026-10-07T00:00:00.000Z', outputs = DEFAULT_OUTPUTS, lambdaArnAccount = '650880818323',
  queueArnAccount = '650880818323', templateBodies = {}, distributionDomain = 'client123.cloudfront.net',
  calls = [],
} = {}) {
  const byKey = new Map();
  for (const configured of configuredStacks) {
    const record = {
      StackName: configured.stack_name,
      StackId: `arn:aws:cloudformation:${configured.region}:650880818323:stack/${configured.stack_name}/id`,
      StackStatus: stackStatus,
      LastUpdatedTime: '2026-10-07T00:00:00.000Z',
      Outputs: Object.entries(outputs[configured.stack_name] ?? {}).map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue })),
    };
    byKey.set(configured.stack_name, record);
    byKey.set(record.StackId, record);
  }
  const valueAfter = (args, flag) => args[args.indexOf(flag) + 1];
  return {
    async aws(args, stackRegion) {
      calls.push({ args: [...args], region: stackRegion });
      const [service, action] = args;
      if (service === 'sts') return { Account: account };
      if (service === 'cloudformation' && action === 'describe-stacks') {
        const key = valueAfter(args, '--stack-name');
        const record = byKey.get(key);
        if (!record) throw new Error(`unexpected stack ${key}`);
        const secondRead = key.includes(':stack/');
        return { Stacks: [{ ...record, StackStatus: secondRead ? secondStatus : stackStatus, ...(secondRead ? { LastUpdatedTime: secondUpdatedTime } : {}) }] };
      }
      if (service === 'cloudformation' && action === 'get-template') {
        const key = valueAfter(args, '--stack-name');
        return { TemplateBody: JSON.stringify(templateBodies[key] ?? { Resources: { Shared: { Type: 'AWS::S3::Bucket', Properties: { BucketName: 'beta' } } } }) };
      }
      if (service === 'lambda' && action === 'get-function') {
        const functionName = valueAfter(args, '--function-name');
        return { Configuration: {
          FunctionArn: `arn:aws:lambda:ap-east-1:${lambdaArnAccount}:function:${functionName}`,
          LastUpdateStatus: 'Successful',
          CodeSha256: Buffer.from('e'.repeat(64), 'hex').toString('base64'),
          FunctionName: functionName, Runtime: 'nodejs22.x', Handler: 'index.handler',
          Role: 'arn:aws:iam::650880818323:role/beta-anywear-lambda', MemorySize: 512, Timeout: 30, Architectures: ['arm64'],
        } };
      }
      if (service === 'sqs' && action === 'get-queue-attributes') {
        const queueName = new URL(valueAfter(args, '--queue-url')).pathname.split('/').pop();
        return { Attributes: {
          QueueArn: `arn:aws:sqs:ap-east-1:${queueArnAccount}:${queueName}`,
          VisibilityTimeout: '900',
          RedrivePolicy: JSON.stringify({ maxReceiveCount: 3, deadLetterTargetArn: `arn:aws:sqs:ap-east-1:${queueArnAccount}:${queueName}-dlq` }),
        } };
      }
      if (service === 'ssm' && action === 'get-parameters') {
        const names = args.slice(args.indexOf('--names') + 1);
        return { Parameters: names.map((Name, index) => ({ Name, Value: `value:${Name}`, Type: 'String', Version: index + 1 })) };
      }
      if (service === 'cloudfront' && action === 'get-distribution') return { Distribution: { DomainName: distributionDomain } };
      throw new Error(`unexpected AWS call ${args.join(' ')}`);
    },
  };
}

test('strict JSON rejects escaped duplicate keys, invalid UTF-8/Unicode and non-JSON values', () => {
  for (const source of ['{"a":1,"\\u0061":2}', '{"a":{"x":1,"x":2}}', '1e999', '"\\ud800"', '\u00a0{}', '{"a":1,}', '[1,]']) {
    assert.throws(() => parseStrictJson(source));
  }
  assert.throws(() => parseStrictJson(Buffer.from([0xc0, 0xaf])));
  const proto = parseStrictJson('{"__proto__":{"unexpected":true}}');
  assert.equal(Object.hasOwn(proto, '__proto__'), true);
  assert.equal({}.unexpected, undefined);
  assert.equal(canonicalJson(parseStrictJson('{"z":1,"a":2}')), '{"a":2,"z":1}');
});

// #180: the observation is E2E's own authenticated read of the three configured stacks,
// the stage inputs, the two Lambdas, the two queues and the Client distribution. It is
// producer-free: no Infra commit, no deployment record, no producer fields on a stack row.
test('observes the live platform itself: three stacks, stage inputs, Lambdas, queues and the Client domain', async () => {
  const platform = await observePlatform({ io: observationIo() });
  assert.deepEqual(platform.stacks.map(({ name }) => name),
    ['AnyWearBillingStack-beta', 'AnyWearFoundationStack', 'AnyWearPlatformStack-beta']);
  for (const row of platform.stacks) {
    assert.deepEqual(Object.keys(row).sort(), ['name', 'region', 'template_sha256']);
    assert.equal(row.producer_repository, undefined);
  }
  assert.ok(platform.inputs.length > 0);
  assert.deepEqual(platform.inputs.map(({ parameter }) => parameter), [...platform.inputs.map(({ parameter }) => parameter)].sort());
  for (const input of platform.inputs) assert.match(input.version, /^[1-9][0-9]*$/);
  assert.equal(platform.schema_sha256, stageContractSchemaHash(platform.inputs));
  assert.deepEqual(Object.keys(platform.lambdas).sort(), ['post-confirmation', 'pre-sign-up']);
  assert.match(platform.queue_config_sha256, /^[0-9a-f]{64}$/);
  assert.equal(platform.client_domain, 'client123.cloudfront.net');

  const f = qualificationFixture();
  const observation = {
    collected_at: '2026-10-08T00:00:00.000Z',
    client: { url: `https://${platform.client_domain}`, source_commit: f.clientSha, built_at: '2026-10-07T00:00:00.000Z' },
    service: { url: 'https://api123.cloudfront.net', service_commit: f.serviceSha, image_digest: f.image },
    platform,
    authenticated: true,
  };
  assert.equal(validateObservation(observation, 'observed'), observation);
});

// #177 B1: `cloudformation get-template` is a regional read. The three configured stacks
// do not share a region (Billing is us-east-1, Foundation and the Base stack are
// ap-east-1), so each template read must run in the stack's own region.
test('reads each stack template in the stack\'s own region', async () => {
  const calls = [];
  await observePlatform({ io: observationIo({ calls }) });
  const configuredRegion = (stackName) => configuredStacks.find(({ stack_name: name }) => name === stackName)?.region;
  const templates = calls.filter(({ args }) => args[0] === 'cloudformation' && args[1] === 'get-template');
  assert.equal(templates.length, configuredStacks.length);
  for (const call of templates) {
    const stackArn = call.args[call.args.indexOf('--stack-name') + 1];
    const arnRegion = /^arn:aws:cloudformation:([a-z0-9-]+):/.exec(stackArn)?.[1];
    const stackName = stackArn.split('/')[1];
    assert.equal(call.region, arnRegion, `get-template for ${stackName} must use the region in its stack ARN`);
    assert.equal(call.region, configuredRegion(stackName), `get-template for ${stackName} must use its configured region`);
  }
  const templateFor = (name) => templates.find(({ args }) => args.some((arg) => typeof arg === 'string' && arg.includes(name)));
  assert.equal(templateFor('AnyWearBillingStack-beta')?.region, 'us-east-1');
  assert.equal(templateFor('AnyWearFoundationStack')?.region, 'ap-east-1');
  assert.equal(templateFor('AnyWearPlatformStack-beta')?.region, 'ap-east-1');
  // The describe-stacks reads (the initial identity read and the closing re-read) use the
  // same per-stack regions, so neither can be silently routed to the default region.
  for (const call of calls.filter(({ args }) => args[0] === 'cloudformation' && args[1] === 'describe-stacks')) {
    const key = call.args[call.args.indexOf('--stack-name') + 1];
    const stackName = key.includes(':stack/') ? key.split('/')[1] : key;
    assert.equal(call.region, configuredRegion(stackName), `describe-stacks for ${stackName} must use its configured region`);
  }
});

test('refuses a stack, account, Lambda, queue or template that is not the reviewed deployed one', async () => {
  await assert.rejects(observePlatform({ io: observationIo({ account: '111111111111' }) }),
    /requires the Beta account 650880818323 \(observed 111111111111\)/);
  await assert.rejects(observePlatform({ io: observationIo({ stackStatus: 'UPDATE_IN_PROGRESS' }) }),
    /is not in a terminal state/);
  await assert.rejects(observePlatform({ io: observationIo({ lambdaArnAccount: '111111111111' }) }),
    /Actual Lambda identity\/update state unproven/);
  await assert.rejects(observePlatform({ io: observationIo({ queueArnAccount: '111111111111' }) }),
    /Foreign vto queue observation/);
  await assert.rejects(observePlatform({ io: observationIo({ outputs: { ...DEFAULT_OUTPUTS, [PLATFORM_STACK]: {} } }) }),
    /Deployed vto queue is unavailable/);
  // A deployment that crosses the observation is refused instead of being recorded as one state.
  await assert.rejects(observePlatform({ io: observationIo({ secondUpdatedTime: '2026-10-07T00:01:00.000Z' }) }),
    /changed during the authenticated observation/);
  // Without the distribution-domain output the domain is read from CloudFront itself.
  const viaDistribution = await observePlatform({
    io: observationIo({
      outputs: { [PLATFORM_STACK]: { ...DEFAULT_OUTPUTS[PLATFORM_STACK], ClientDistributionDomainName: undefined, ClientDistributionId: 'E123' } },
    }),
  });
  assert.equal(viaDistribution.client_domain, 'client123.cloudfront.net');
});

test('a changed deployed template is a different content identity', async () => {
  const original = await observePlatform({ io: observationIo() });
  const changed = await observePlatform({ io: observationIo({ templateBodies: {
    'arn:aws:cloudformation:ap-east-1:650880818323:stack/AnyWearFoundationStack/id': { Resources: { Shared: { Type: 'AWS::S3::Bucket', Properties: { BucketName: 'changed' } } } },
  } }) });
  assert.notEqual(changed.stacks.find(({ name }) => name === 'AnyWearFoundationStack').template_sha256,
    original.stacks.find(({ name }) => name === 'AnyWearFoundationStack').template_sha256);
  assert.equal(changed.stacks.find(({ name }) => name === 'AnyWearPlatformStack-beta').template_sha256,
    original.stacks.find(({ name }) => name === 'AnyWearPlatformStack-beta').template_sha256);
});

test('the live AWS seam names the denied read instead of failing silently', async () => {
  const io = liveObservationIo({
    execute: () => { const error = new Error('Command failed'); error.stderr = Buffer.from('An error occurred (AccessDenied) when calling the DescribeStacks operation'); throw error; },
  });
  await assert.rejects(async () => io.aws(['cloudformation', 'describe-stacks', '--stack-name', 'AnyWearFoundationStack']),
    /AWS read failed for cloudformation describe-stacks --stack-name AnyWearFoundationStack: An error occurred \(AccessDenied\)/);
});

test('the record is self-contained: only the v4 members, and the live tuple inside them', () => {
  const record = qualify(qualificationFixture());
  assert.equal(record.schema_version, 4);
  assert.deepEqual(Object.keys(record).sort(), [
    'environment', 'expected', 'integrity', 'observations', 'operation', 'qualification_id', 'qualified_at',
    'record_type', 'result', 'revisions', 'schema_version', 'service_artifacts', 'test', 'workflow',
  ]);
  // #193: the release identity is the tag's target commit plus exactly the four released
  // assets; the manifest members v3 carried are gone.
  assert.deepEqual(Object.keys(record.service_artifacts).sort(), ['assets', 'release_id', 'repository', 'tag', 'target_commit']);
  assert.deepEqual(Object.keys(record.service_artifacts.assets), [...SERVICE_RELEASE_ASSET_NAMES]);
  assert.equal(record.service_artifacts.target_commit, record.revisions.service.sha);
  assert.deepEqual(Object.keys(record.revisions).sort(), ['client', 'e2e', 'service']);
  assert.deepEqual(Object.keys(record.observations).sort(), ['after', 'before']);
  for (const phase of ['before', 'after']) {
    assert.deepEqual(Object.keys(record.observations[phase]).sort(), ['authenticated', 'client', 'collected_at', 'platform', 'service']);
  }
  // The serialized record is the whole tuple: Client, Service, image, platform content,
  // stage inputs, Lambdas, queues, distribution and the floor.
  const serialized = JSON.stringify(record);
  assert.ok(serialized.includes(record.revisions.client.sha));
  assert.ok(serialized.includes(record.revisions.service.sha));
  assert.ok(serialized.includes(record.revisions.service.image_digest));
  assert.ok(serialized.includes(record.service_artifacts.tag));
  assert.ok(serialized.includes(`"minimum_client_version":${record.revisions.service.minimum_client_version}`));
  assert.ok(serialized.includes(record.observations.after.platform.schema_sha256));
  assert.ok(serialized.includes(record.observations.after.platform.client_domain));
  assert.equal(serialized.includes('"compatibility"'), false);
  assert.equal(serialized.includes('"deployment"'), false);
  assert.equal(serialized.includes('"infra"'), false);
});

test('the stage-contract schema hash is content identity derived from the inputs', () => {
  const f = qualificationFixture();
  const inputs = structuredClone(f.evidence.before.platform.inputs);
  assert.equal(stageContractSchemaHash(inputs), f.evidence.before.platform.schema_sha256);
  const valueChanged = structuredClone(inputs);
  valueChanged[0].value_sha256 = 'a'.repeat(64);
  assert.equal(stageContractSchemaHash(valueChanged), stageContractSchemaHash(inputs));
  const versionChanged = structuredClone(inputs);
  versionChanged[0].version = String(Number(versionChanged[0].version) + 1);
  assert.notEqual(stageContractSchemaHash(versionChanged), stageContractSchemaHash(inputs));
});

test('promotion requires the exact unexpired artifact and completed-success E2E attempt, beyond the self-checksum', () => {
  const record = qualify(qualificationFixture());
  const recordBytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
  const trustedRun = { id: 123, run_attempt: 1, repository: { full_name: 'git-malu/AnyWear-E2E' }, path: '.github/workflows/beta-qualification.yml',
    head_sha: record.revisions.e2e.sha, head_branch: 'main', event: 'workflow_dispatch', status: 'completed', conclusion: 'success',
    run_started_at: '2026-10-07T23:59:00Z', updated_at: '2026-10-08T00:25:00Z' };
  const trustedArtifact = { id: 90, name: 'beta-qualification-123-1', expired: false, expires_at: '2026-10-09T00:00:00Z',
    created_at: '2026-10-08T00:21:00Z', workflow_run: { id: 123, head_sha: trustedRun.head_sha } };
  const expected = { artifact_id: 90, record_sha256: byteHash(recordBytes), e2e_sha: trustedRun.head_sha, run_id: 123, run_attempt: 1 };
  const context = { trustedRun, trustedArtifact, expected, recordBytes, now: now.getTime() };
  assert.equal(verifyQualificationForPromotion(record, context), true);
  // #193: a historical v3 record is refused by the v4 consumer even with otherwise valid
  // run/artifact metadata; the checksum it carries cannot make it current.
  const legacy = { ...structuredClone(record), schema_version: 3 };
  const legacyBytes = Buffer.from(`${JSON.stringify(legacy, null, 2)}\n`);
  assert.throws(() => verifyQualificationForPromotion(legacy, {
    ...context, recordBytes: legacyBytes, expected: { ...expected, record_sha256: byteHash(legacyBytes) },
  }), /Unsupported qualification record schema: observed schema_version 3/);
  assert.throws(() => verifyQualificationForPromotion(record), /authenticated run\/artifact metadata/);
  assert.throws(() => verifyQualificationForPromotion(record, { ...context, trustedArtifact: { ...trustedArtifact, expired: true } }));
  assert.throws(() => verifyQualificationForPromotion(record, { ...context, trustedRun: { ...trustedRun, conclusion: 'failure' } }));
  assert.throws(() => verifyQualificationForPromotion(record, { ...context, expected: { ...expected, record_sha256: 'a'.repeat(64) } }));
  assert.throws(() => verifyQualificationForPromotion(record, { ...context, trustedArtifact: { ...trustedArtifact, name: 'beta-qualification-123-2' } }));
});

test('execution guard binds protected dispatch/source and the captured dedicated principal', () => {
  const sourceSha = 'a'.repeat(40);
  const env = { GITHUB_REPOSITORY: 'git-malu/AnyWear-E2E', GITHUB_REPOSITORY_ID: '1317091305',
    GITHUB_REPOSITORY_OWNER: 'git-malu', GITHUB_REPOSITORY_OWNER_ID: '11473072',
    GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-E2E/.github/workflows/beta-qualification.yml@refs/heads/main',
    GITHUB_WORKFLOW_SHA: sourceSha, GITHUB_SHA: sourceSha, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1',
    E2E_STAGE: 'beta', ENABLE_BETA_MUTATION: 'true', E2E_OPERATION: 'full', AWS_ACCOUNT_ID: '650880818323', AWS_REGION: 'ap-east-1',
    E2E_CLEANUP_SERVICE_SHA: 'b'.repeat(40), E2E_AWS_ACCOUNT: '650880818323',
    E2E_AWS_PRINCIPAL_ARN: 'arn:aws:sts::650880818323:assumed-role/beta-e2e-qualification-role/qualification-123' };
  assert.equal(assertE2EExecution(env, { sourceSha }), true);
  for (const operation of ['full', 'smoke', 'recover']) {
    assert.equal(assertE2EExecution({ ...env, E2E_OPERATION: operation }, { sourceSha }), true);
  }
  for (const patch of [{ ENABLE_BETA_MUTATION: 'false' }, { GITHUB_REPOSITORY: 'other/E2E' }, { GITHUB_REPOSITORY_ID: '1' },
    { GITHUB_REPOSITORY_OWNER: 'other' }, { GITHUB_REPOSITORY_OWNER_ID: '1' }, { GITHUB_REF: 'refs/heads/topic' },
    { GITHUB_EVENT_NAME: 'pull_request' }, { E2E_STAGE: 'dev' }, { GITHUB_WORKFLOW_SHA: 'b'.repeat(40) },
    { GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-E2E/.github/workflows/integration.yml@refs/heads/main' },
    { GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-E2E/.github/workflows/account-recovery.yml@refs/heads/main' },
    { GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-E2E/.github/workflows/runtime-drill.yml@refs/heads/main' },
    { E2E_OPERATION: undefined }, { E2E_OPERATION: '' }, { E2E_OPERATION: 'measure' },
    { E2E_OPERATION: 'instrumentation' },
    { GITHUB_RUN_ID: '0' }, { GITHUB_RUN_ID: '9007199254740992' }, { GITHUB_RUN_ATTEMPT: '0' },
    { AWS_ACCOUNT_ID: '1' }, { AWS_REGION: 'us-east-1' }, { E2E_CLEANUP_SERVICE_SHA: 'main' },
    { E2E_AWS_ACCOUNT: undefined }, { E2E_AWS_ACCOUNT: '1' }, { E2E_AWS_PRINCIPAL_ARN: undefined },
    { E2E_AWS_PRINCIPAL_ARN: 'arn:aws:sts::650880818323:assumed-role/beta-infra-role/123' },
    { E2E_AWS_PRINCIPAL_ARN: 'arn:aws:sts::111111111111:assumed-role/beta-e2e-qualification-role/123' }]) {
    assert.throws(() => assertE2EExecution({ ...env, ...patch }, { sourceSha }));
  }
  assert.throws(() => assertE2EExecution(env, { sourceSha: 'c'.repeat(40) }), /checkout/);
  const beforeCredentials = { ...env, E2E_AWS_ACCOUNT: undefined, E2E_AWS_PRINCIPAL_ARN: undefined };
  assert.equal(assertE2EExecution(beforeCredentials, { sourceSha, sourceOnly: true }), true);
  assert.throws(() => assertE2EExecution(beforeCredentials, { sourceSha }), /dedicated E2E principal/);
});

test('recovery binds the original completed owner and preserves unproven identities', () => {
  const run = { id: 123, run_attempt: 1, head_sha: 'a'.repeat(40), repository: { full_name: 'git-malu/AnyWear-E2E' },
    head_branch: 'main', event: 'workflow_dispatch', path: '.github/workflows/beta-qualification.yml', status: 'completed', conclusion: 'failure' };
  const manifest = { version: 1, runScope: '123-1-0000000000000000', config: { maxActiveAccounts: 2, maxNewAccountsPerRun: 4, maxQuarantinedAccounts: 2 },
    accounts: [{ mode: 'worker', status: 'in_use', subject: '00000000-0000-0000-0000-000000000001', email: 'e2e-beta-worker-0-chromium@anywear.local' },
      { mode: 'worker', status: 'quarantined', subject: '00000000-0000-0000-0000-000000000002', email: 'e2e-beta-worker-1-chromium@anywear.local' },
      { mode: 'worker', status: 'deleted', subject: 'already-gone' },
      { mode: 'worker', status: 'provisioning', subject: 'unknown', email: 'e2e-beta-worker-2-chromium@anywear.local' }] };
  const prepared = prepareAccountRecovery(structuredClone(manifest), run, 123, 1);
  assert.equal(prepared.accounts[0].status, 'cleanup_pending');
  // A quarantined record whose captured subject and address are intact is the
  // same cleanup request; only an unproven identity stays terminal.
  assert.equal(prepared.accounts[1].status, 'cleanup_pending');
  assert.equal(prepared.accounts[2].status, 'deleted');
  assert.equal(prepared.accounts[3].status, 'provisioning');
  for (const patch of [{ status: 'in_progress' }, { run_attempt: 2 }, { path: '.github/workflows/runtime-drill.yml' }, { repository: { full_name: 'other/E2E' } }]) assert.throws(() => prepareAccountRecovery(structuredClone(manifest), { ...run, ...patch }, 123, 1));
  assert.throws(() => prepareAccountRecovery({ ...manifest, runScope: '124-1-0000000000000000' }, run, 123, 1));
  assert.throws(() => prepareAccountRecovery({ ...manifest, config: { ...manifest.config, maxNewAccountsPerRun: 1 } }, run, 123, 1));
  const reordered = prepareAccountRecovery({ ...structuredClone(manifest), config: { maxQuarantinedAccounts: 2, maxNewAccountsPerRun: 4, maxActiveAccounts: 2 } }, run, 123, 1);
  assert.equal(JSON.stringify(reordered.config), JSON.stringify(manifest.config));
});

test('recovery artifact binds unique original source/attempt times and lifetime', () => {
  const run = { id: 123, run_attempt: 2, head_sha: 'a'.repeat(40), run_started_at: '2026-10-08T00:00:00Z', updated_at: '2026-10-08T00:20:00Z' };
  const artifact = { id: 55, name: 'beta-account-lifecycle-123-2', expired: false, digest: `sha256:${'a'.repeat(64)}`,
    created_at: '2026-10-08T00:10:00Z', expires_at: '2099-01-01T00:00:00Z', workflow_run: { id: 123, head_sha: run.head_sha } };
  assert.equal(assertRecoveryArtifact(artifact, run), artifact);
  for (const patch of [{ name: 'beta-account-lifecycle-123-1' }, { expired: true }, { workflow_run: { id: 123, head_sha: 'b'.repeat(40) } },
    { created_at: '2026-10-07T23:59:00Z' }, { created_at: '2026-10-08T00:21:00Z' }, { expires_at: '2000-01-01T00:00:00Z' },
    { digest: undefined }, { digest: null }, { digest: '' }, { digest: 'invalid' }]) {
    assert.throws(() => assertRecoveryArtifact({ ...artifact, ...patch }, run));
  }
});

// AnyWear #138 stays true after v3: identity is content, never an ECS task-definition
// revision. A changed platform template, input or application identity is refused by
// name (the old pin comparison reported the first differing path with both values).
test('#138 a changed deployment content is refused and the error names the differing field', () => {
  assert.throws(() => assertEqual({ platform: { template_sha256: 'a'.repeat(64) } }, { platform: { template_sha256: 'b'.repeat(64) } }, 'Record'),
    /Record mismatch at <root>\.platform\.template_sha256: expected "b{64}", observed "a{64}"/);
  const f = qualificationFixture();
  const changed = structuredClone(f);
  changed.evidence.after.platform.lambdas['post-confirmation'].configuration_sha256 = 'f'.repeat(64);
  assert.throws(() => qualify(changed), /Deployed platform identity mismatch/);
  const digestChanged = structuredClone(f);
  digestChanged.evidence.after.service.image_digest = `sha256:${'f'.repeat(64)}`;
  assert.throws(() => qualify(digestChanged), /Deployed Service identity mismatch/);
});
