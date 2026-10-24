import { execFileSync } from 'node:child_process';
import { account, region } from './vendor/deployment-contract.mjs';
import { configuredStacks } from './vendor/operation-stacks.mjs';
import { contentHash } from './vendor/json-contract.mjs';
import { readStageInputs } from './vendor/stage-contract-parameters.mjs';
import { stageContractSchemaHash } from './vendor/contracts.mjs';
import { stableLambdaConfiguration } from './lambda-configuration.mjs';
import { parseStrictJson } from './evidence-contract.mjs';

// #180: AnyWear-E2E performs the authenticated platform observation itself. The
// retired observer was a cross-repository checkout of AnyWear-Infra pinned by
// `compatibility.infra.sha`, and it proved the platform record against a producer
// record. Qualification no longer consumes a producer record at all: it reads the
// live CloudFormation / SSM / Lambda / SQS / CloudFront state through the vendored
// contract, and the deployment lineage that used to be checked here is no longer a
// record (#207): it is the Environment deployment `beta`, the CloudFormation stack
// events, the release tag→commit and the ECR digest. What this observation proves is the
// deployed *content*: the three stage-base stacks' Original template hashes, the
// `/anywear/beta/*` stage inputs, the two Service-built Lambdas, the two task
// queues and the Client distribution domain.
//
// The body is deliberately flat and producer-free:
//
//   stacks[]            {name, region, template_sha256} for the three configured stacks
//   inputs[]            {parameter, version, value_sha256}, sorted and unique
//   schema_sha256       stageContractSchemaHash(inputs): a content identity of the
//                       consumed stage-contract surface, not a pin to another release
//   lambdas             {'pre-sign-up','post-confirmation'} each {code_sha256, configuration_sha256}
//   queue_config_sha256 content hash of the two task queues' visibility and redrive
//   client_domain       the bare CloudFront distribution host, consistent with
//                       observations.<phase>.client.url (asserted by the record)
//
// The observation ends by re-reading each stack identity, so a deployment that
// crosses the observation window fails here instead of being recorded as one state.
export const STACK_STATUSES = Object.freeze(['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'IMPORT_COMPLETE']);
export const LAMBDA_FUNCTIONS = Object.freeze([
  Object.freeze(['pre-sign-up', 'beta-anywear-pre-sign-up']),
  Object.freeze(['post-confirmation', 'beta-anywear-post-confirmation-sync']),
]);
export const QUEUE_OUTPUTS = Object.freeze([
  Object.freeze(['vto', 'VtoQueueUrl']),
  Object.freeze(['auto-tagging', 'AutoTaggingQueueUrl']),
]);
export const PLATFORM_STACK = 'AnyWearPlatformStack-beta';
export const OBSERVATION_TIMEOUT_MS = 600_000;

// The live seam. `aws` is the CLI this job already holds a credential for; every
// read is a bounded subprocess with a fixed timeout and buffer, and a failure keeps
// the stderr line that identifies the denied call. `execute` is injectable so the
// observation logic is unit-tested without AWS.
export function liveObservationIo({ execute = execFileSync, environment = process.env } = {}) {
  return {
    aws(args, awsRegion = region) {
      let stdout;
      try {
        stdout = execute('aws', [...args, '--region', awsRegion, '--output', 'json'], {
          encoding: 'utf8', timeout: OBSERVATION_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'pipe'], env: environment,
        });
      } catch (error) {
        const detail = (error.stderr?.toString?.() || error.message || String(error))
          .trim().split('\n').slice(0, 4).join(' ');
        throw new Error(`AWS read failed for ${args.join(' ')}: ${detail}`, { cause: error });
      }
      return stdout.trim() ? parseStrictJson(stdout) : {};
    },
  };
}

const outputsOf = (stack) => Object.fromEntries((stack.Outputs ?? []).map((item) => [item.OutputKey, item.OutputValue]));

// `get-template` is a regional CloudFormation read, so it must run in the stack's own
// region, not in the observation's default region: Billing is configured in us-east-1
// while Foundation and the Base stack are in ap-east-1.
async function readTemplateHash(io, actual, stackRegion) {
  const template = (await io.aws([
    'cloudformation', 'get-template', '--stack-name', actual.StackId, '--template-stage', 'Original',
  ], stackRegion)).TemplateBody;
  if (!template) throw new Error(`Original deployed template missing for ${actual.StackName}`);
  const body = typeof template === 'string' ? parseStrictJson(template) : template;
  return contentHash(body);
}

async function observeClientDomain(io, platform) {
  if (platform.ClientDistributionDomainName) return platform.ClientDistributionDomainName;
  if (platform.ClientBaseUrl) {
    try {
      return new URL(platform.ClientBaseUrl).host;
    } catch {
      throw new Error('Deployed Client endpoint is not a URL');
    }
  }
  if (!platform.ClientDistributionId) throw new Error('Deployed Client distribution is unavailable');
  const distribution = await io.aws(['cloudfront', 'get-distribution', '--id', platform.ClientDistributionId]);
  const domain = distribution?.Distribution?.DomainName;
  if (!domain) throw new Error('Deployed Client distribution domain is unavailable');
  return domain;
}

async function observeLambdas(io) {
  const lambdas = {};
  for (const [key, functionName] of LAMBDA_FUNCTIONS) {
    const config = (await io.aws(['lambda', 'get-function', '--function-name', functionName])).Configuration;
    if (config?.FunctionArn !== `arn:aws:lambda:${region}:${account}:function:${functionName}`
      || config.LastUpdateStatus !== 'Successful') {
      throw new Error(`Actual Lambda identity/update state unproven for ${functionName}`);
    }
    lambdas[key] = {
      code_sha256: config.CodeSha256,
      configuration_sha256: contentHash(stableLambdaConfiguration(config)),
    };
  }
  return lambdas;
}

async function observeQueues(io, platform) {
  const queueConfig = {};
  for (const [key, output] of QUEUE_OUTPUTS) {
    const queueUrl = platform[output];
    if (!queueUrl) throw new Error(`Deployed ${key} queue is unavailable`);
    const attributes = (await io.aws([
      'sqs', 'get-queue-attributes', '--queue-url', queueUrl,
      '--attribute-names', 'QueueArn', 'VisibilityTimeout', 'RedrivePolicy',
    ])).Attributes;
    if (!attributes?.QueueArn?.startsWith(`arn:aws:sqs:${region}:${account}:beta-anywear-`)) {
      throw new Error(`Foreign ${key} queue observation`);
    }
    let redrive;
    try {
      redrive = parseStrictJson(attributes.RedrivePolicy);
    } catch (error) {
      throw new Error(`Deployed ${key} queue redrive policy is unreadable (${error.message})`, { cause: error });
    }
    const visibility = Number(attributes.VisibilityTimeout);
    const maxReceives = Number(redrive.maxReceiveCount);
    if (!Number.isSafeInteger(visibility) || !Number.isSafeInteger(maxReceives)) {
      throw new Error(`Deployed ${key} queue configuration is not numeric`);
    }
    queueConfig[key] = { queueVisibilitySeconds: visibility, maxReceives };
  }
  return queueConfig;
}

// The authenticated platform snapshot. `io` defaults to the AWS CLI; unit tests pass
// a fixture reader. The account identity is re-read rather than assumed, so an
// observation taken under another account cannot be recorded as Beta.
export async function observePlatform({ io = liveObservationIo() } = {}) {
  const caller = await io.aws(['sts', 'get-caller-identity']);
  if (caller?.Account !== account) throw new Error(`Platform observation requires the Beta account ${account} (observed ${caller?.Account})`);
  const stacks = [];
  const actualStacks = new Map();
  for (const configured of configuredStacks) {
    const response = await io.aws(['cloudformation', 'describe-stacks', '--stack-name', configured.stack_name], configured.region);
    const actual = response.Stacks?.[0];
    if (response.Stacks?.length !== 1 || actual.StackName !== configured.stack_name
      || !STACK_STATUSES.includes(actual.StackStatus)) {
      throw new Error(`CloudFormation stack ${configured.stack_name} is not in a terminal state`);
    }
    stacks.push({
      name: configured.stack_name,
      region: configured.region,
      template_sha256: await readTemplateHash(io, actual, configured.region),
    });
    actualStacks.set(configured.stack_name, actual);
  }
  const platform = outputsOf(actualStacks.get(PLATFORM_STACK));
  const lambdas = await observeLambdas(io);
  const queueConfig = await observeQueues(io, platform);
  const clientDomain = await observeClientDomain(io, platform);
  const inputs = await readStageInputs(io);
  // The record's stack rows are sorted by name: identity is the set, and a stable order
  // lets the before/after comparison be a plain content comparison. `configuredStacks`
  // is the reviewable stack table; the sorted rows below are derived from it.
  stacks.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  const body = {
    stacks,
    inputs,
    schema_sha256: stageContractSchemaHash(inputs),
    lambdas,
    queue_config_sha256: contentHash(queueConfig),
    client_domain: clientDomain,
  };
  // A deployment that crosses the observation must not be recorded as one platform
  // state: the stack identity, status and update time bracket the whole read.
  for (const [name, original] of actualStacks) {
    const observed = stacks.find((stack) => stack.name === name);
    if (!observed) throw new Error(`Configured stack ${name} disappeared during the observation`);
    const after = (await io.aws(['cloudformation', 'describe-stacks', '--stack-name', original.StackId], observed.region)).Stacks?.[0];
    if (after?.StackId !== original.StackId || after.StackStatus !== original.StackStatus
      || (after.LastUpdatedTime ?? after.CreationTime) !== (original.LastUpdatedTime ?? original.CreationTime)) {
      throw new Error(`CloudFormation stack ${name} changed during the authenticated observation`);
    }
  }
  return body;
}
