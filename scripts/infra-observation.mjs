import { execFileSync } from 'node:child_process';
import { assertEqual, byteHash, contentHash, parseStrictJson } from './evidence-contract.mjs';
import { stableLambdaConfiguration } from './lambda-configuration.mjs';
import {
  account, CREDENTIAL_REGION, OBSERVATION_REGIONS, PAGINATION_PAGE_BOUND,
  QUEUE_NAME_PREFIX, STACK_NAME_PREFIX, STAGE_PATH, TERMINAL_STACK_STATUSES,
} from './platform-entrypoints.mjs';

// #180/#228: AnyWear-E2E performs the authenticated platform observation itself, and since
// #228 it does so as a black-box consumer: the deployed surface is discovered through AWS
// public list/describe APIs bounded by the reviewed entry points in
// `platform-entrypoints.mjs` (the stage path, the two name prefixes, the account carried by
// the qualification credential and the two observation regions). No producer source and no
// committed name list enters the read; hashing uses only the repository's own RFC 8785
// canonical JSON and sha256. What this observation proves is the deployed *content*:
//
//   stacks[]            {name, region, template_sha256} over every discovered `AnyWear*`
//                       stack in a terminal success status in both observation regions,
//                       sorted by name; region parsed from the live stack ARN
//   inputs[]            {parameter, version, value_sha256} over the whole published
//                       `/anywear/beta/` prefix, sorted and unique
//   schema_sha256       sha256 of the RFC 8785 canonical JSON of the [{parameter, version}]
//                       rows — a content identity of the discovered input surface
//   lambdas[]           {name, code_sha256, configuration_sha256} over every discovered
//                       `beta-anywear-*` function, sorted by name
//   queues[]            {name, queueVisibilitySeconds, maxReceives} over every discovered
//                       `beta-anywear-*` queue including the DLQs (maxReceives null for a
//                       queue with no redrive policy), sorted by name
//   client_domain       the domain of the CloudFront distribution serving the live Client
//                       URL host (exactly one match, deployed and enabled)
//
// The observation ends by running the whole discovery a second time inside the same
// observation: the derived platform body must be identical and every stack's
// StackId/status/update time must be unchanged, so a deployment that crosses the
// observation window fails here instead of being recorded as one state.
export const OBSERVATION_TIMEOUT_MS = 600_000;

// The live seam. `aws` is the CLI this job already holds a credential for; every
// read is a bounded subprocess with a fixed timeout and buffer, and a failure keeps
// the stderr line that identifies the denied call. `execute` is injectable so the
// observation logic is unit-tested without AWS.
export function liveObservationIo({ execute = execFileSync, environment = process.env } = {}) {
  return {
    aws(args, awsRegion = CREDENTIAL_REGION) {
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

// One bounded read over a paginated AWS list. Every page's token must be new and more
// than PAGINATION_PAGE_BOUND pages is a refusal — a looping or misbehaving list can never
// become an unbounded read. Per-name uniqueness is the default refusal: the four
// unique-surface readers (SSM parameters, Lambda functions, SQS queues, CloudFront
// distributions) keep it, because a repeated name there is a pagination anomaly.
// `list-stacks` legitimately returns one row per stack occurrence (a stack's
// stop/start history), so the stack reader passes `allowRepeatedNames` and moves the
// name-uniqueness check after its own status filter (`discoverStacks`).
async function readPages(io, baseArgs, {
  region, tokenFlag, pageKey, tokenKey, nameOf, label,
  readPage = (response) => response, truncatedKey, allowRepeatedNames = false,
}) {
  const seenTokens = new Set();
  const seenNames = new Set();
  const items = [];
  let token;
  let pages = 0;
  for (;;) {
    pages += 1;
    if (pages > PAGINATION_PAGE_BOUND) {
      throw new Error(`${label} exceeded the ${PAGINATION_PAGE_BOUND}-page pagination bound`);
    }
    const response = await io.aws(token ? [...baseArgs, tokenFlag, token] : [...baseArgs], region);
    const page = readPage(response);
    if (!page || (page[pageKey] !== undefined && !Array.isArray(page[pageKey]))) {
      throw new Error(`${label} response is malformed`);
    }
    // An empty page (some list APIs omit the items key entirely) is legitimate only when
    // the list is exhausted; the per-service empty-set refusals judge the collected set.
    for (const item of page[pageKey] ?? []) {
      const name = nameOf(item);
      if (typeof name !== 'string' || name.length === 0) throw new Error(`${label} lists an unnamed entry`);
      if (!allowRepeatedNames && seenNames.has(name)) throw new Error(`${label} lists ${name} more than once`);
      seenNames.add(name);
      items.push(item);
    }
    const next = page[tokenKey];
    if (!next) {
      if (truncatedKey && page[truncatedKey] === true) {
        throw new Error(`${label} is truncated without a next token`);
      }
      break;
    }
    if (seenTokens.has(next)) throw new Error(`${label} pagination token repeated`);
    seenTokens.add(next);
    token = next;
  }
  return items;
}

// `get-template` is a regional CloudFormation read, so it must run in the stack's own
// region, parsed from the live stack ARN: Billing is configured in us-east-1 while the
// other persistent stacks are in ap-east-1. Every row's ARN must belong to the reviewed
// account, and a listed `AnyWear*` stack that is not in a terminal success status is a
// deployment crossing the observation window. `DELETE_COMPLETE` is the one ignored
// status — the disposable stacks' normal stop history. Because `list-stacks` returns one
// row per stack occurrence, any number of `DELETE_COMPLETE` rows per stack name is
// dropped by the filter below (never described, never recorded, never reaching the
// closing re-read); the reviewed set — the non-`DELETE_COMPLETE` `AnyWear*` rows — must
// still contain at most one row per stack name, and a duplicated live row for one name,
// on one page or across pages, is refused naming the stack.
async function discoverStacks(io, reviewedAccount) {
  const rows = [];
  const brackets = new Map();
  for (const region of OBSERVATION_REGIONS) {
    const summaries = await readPages(io, ['cloudformation', 'list-stacks'], {
      region, tokenFlag: '--next-token', pageKey: 'StackSummaries', tokenKey: 'NextToken',
      nameOf: (stack) => stack.StackName, label: `CloudFormation list-stacks in ${region}`,
      allowRepeatedNames: true,
    });
    const reviewed = summaries.filter((stack) => stack.StackName?.startsWith(STACK_NAME_PREFIX)
      && stack.StackStatus !== 'DELETE_COMPLETE');
    const seenNames = new Set();
    for (const stack of reviewed) {
      const name = stack.StackName;
      if (seenNames.has(name)) {
        throw new Error(`CloudFormation list-stacks in ${region} lists ${name} more than once`);
      }
      seenNames.add(name);
      if (!TERMINAL_STACK_STATUSES.includes(stack.StackStatus)) {
        throw new Error(`CloudFormation stack ${name} is not in a terminal state (observed ${stack.StackStatus})`);
      }
    }
    if (reviewed.length === 0) {
      throw new Error(`CloudFormation discovery found no ${STACK_NAME_PREFIX}* stacks in ${region}`);
    }
    for (const summary of reviewed) {
      const name = summary.StackName;
      const response = await io.aws(['cloudformation', 'describe-stacks', '--stack-name', name], region);
      const actual = response.Stacks?.[0];
      if (response.Stacks?.length !== 1 || actual.StackName !== name || typeof actual.StackId !== 'string') {
        throw new Error(`CloudFormation stack ${name} could not be described in ${region}`);
      }
      const arn = /^arn:aws:cloudformation:([a-z0-9-]+):(\d{12}):stack\//.exec(actual.StackId);
      if (!arn) throw new Error(`CloudFormation stack ${name} has no readable stack ARN`);
      const [, arnRegion, arnAccount] = arn;
      if (arnAccount !== reviewedAccount) {
        throw new Error(`CloudFormation stack ${name} belongs to foreign account ${arnAccount}`);
      }
      if (arnRegion !== region) {
        throw new Error(`CloudFormation stack ${name} ARN region ${arnRegion} differs from its list region ${region}`);
      }
      const template = (await io.aws([
        'cloudformation', 'get-template', '--stack-name', actual.StackId, '--template-stage', 'Original',
      ], arnRegion)).TemplateBody;
      if (!template) throw new Error(`Original deployed template missing for ${name}`);
      const body = typeof template === 'string' ? parseStrictJson(template) : template;
      rows.push({ name, region: arnRegion, template_sha256: contentHash(body) });
      brackets.set(name, {
        StackId: actual.StackId,
        StackStatus: actual.StackStatus,
        updatedAt: actual.LastUpdatedTime ?? actual.CreationTime,
      });
    }
  }
  rows.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return { rows, brackets };
}

// The whole published `/anywear/beta/` prefix, read without decryption. The value itself
// is never recorded: each row carries the parameter name, the SSM version and the sha256
// of the value. A SecureString is refused — hashing a masked value would seal a
// non-identity, and the reader never decrypts.
async function discoverStageInputs(io) {
  const parameters = await readPages(io, [
    'ssm', 'get-parameters-by-path', '--path', STAGE_PATH, '--recursive',
  ], {
    region: CREDENTIAL_REGION, tokenFlag: '--next-token', pageKey: 'Parameters', tokenKey: 'NextToken',
    nameOf: (parameter) => parameter.Name, label: `SSM get-parameters-by-path ${STAGE_PATH}`,
  });
  if (parameters.length === 0) throw new Error(`SSM discovery found no parameters under ${STAGE_PATH}`);
  return parameters.map((parameter) => {
    const name = parameter?.Name;
    if (typeof name !== 'string' || !name.startsWith(STAGE_PATH)) {
      throw new Error(`SSM parameter ${JSON.stringify(name)} is outside ${STAGE_PATH}`);
    }
    if (parameter.Type === 'SecureString') {
      throw new Error(`SSM parameter ${name} is a SecureString; the observation never decrypts a published value`);
    }
    if (typeof parameter.Value !== 'string') throw new Error(`SSM parameter ${name} has no readable value`);
    if (!Number.isSafeInteger(Number(parameter.Version)) || Number(parameter.Version) < 1) {
      throw new Error(`SSM parameter ${name} has no readable version`);
    }
    return { parameter: name, version: String(parameter.Version), value_sha256: byteHash(parameter.Value) };
  }).sort((left, right) => (left.parameter < right.parameter ? -1 : left.parameter > right.parameter ? 1 : 0));
}

// Every discovered `beta-anywear-*` function, with the exact-ARN/account/region,
// `State === 'Active'` and `LastUpdateStatus === 'Successful'` guards on the live
// configuration. The configuration identity is the E2E-owned stable projection.
async function discoverLambdas(io, reviewedAccount) {
  const functions = await readPages(io, ['lambda', 'list-functions'], {
    region: CREDENTIAL_REGION, tokenFlag: '--marker', pageKey: 'Functions', tokenKey: 'NextMarker',
    nameOf: (summary) => summary.FunctionName, label: 'Lambda list-functions',
  });
  const reviewed = functions.filter((summary) => summary.FunctionName?.startsWith(QUEUE_NAME_PREFIX));
  if (reviewed.length === 0) {
    throw new Error(`Lambda discovery found no ${QUEUE_NAME_PREFIX}* functions in ${CREDENTIAL_REGION}`);
  }
  const rows = [];
  for (const summary of reviewed) {
    const name = summary.FunctionName;
    const config = (await io.aws(['lambda', 'get-function', '--function-name', name])).Configuration;
    if (config?.FunctionArn !== `arn:aws:lambda:${CREDENTIAL_REGION}:${reviewedAccount}:function:${name}`
      || config.State !== 'Active' || config.LastUpdateStatus !== 'Successful') {
      throw new Error(`Actual Lambda identity/update state unproven for ${name}`);
    }
    rows.push({
      name,
      code_sha256: config.CodeSha256,
      configuration_sha256: contentHash(stableLambdaConfiguration(config)),
    });
  }
  return rows.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

const queueNameOf = (url) => (typeof url === 'string' ? url.split('/').filter(Boolean).pop() : undefined);

// Every discovered `beta-anywear-*` queue, including the DLQs. The URL and the QueueArn
// must both be in the reviewed account/region/prefix. A queue with no redrive policy —
// the DLQs legitimately carry none — records `maxReceives: null`.
async function discoverQueues(io, reviewedAccount) {
  const urls = await readPages(io, [
    'sqs', 'list-queues', '--queue-name-prefix', QUEUE_NAME_PREFIX.replace(/-$/, ''),
  ], {
    region: CREDENTIAL_REGION, tokenFlag: '--next-token', pageKey: 'QueueUrls', tokenKey: 'NextToken',
    nameOf: (url) => url, label: `SQS list-queues for ${QUEUE_NAME_PREFIX}*`,
  });
  const reviewed = urls.filter((url) => queueNameOf(url)?.startsWith(QUEUE_NAME_PREFIX));
  if (reviewed.length === 0) {
    throw new Error(`SQS discovery found no ${QUEUE_NAME_PREFIX}* queues in ${CREDENTIAL_REGION}`);
  }
  const rows = [];
  for (const url of reviewed) {
    const name = queueNameOf(url);
    const urlMatch = /^https:\/\/sqs\.([a-z0-9-]+)\.amazonaws\.com\/(\d{12})\/([a-z0-9-]+)$/.exec(url);
    if (!urlMatch || urlMatch[1] !== CREDENTIAL_REGION || urlMatch[2] !== reviewedAccount
      || urlMatch[3] !== name || !name.startsWith(QUEUE_NAME_PREFIX)) {
      throw new Error(`Foreign queue URL observation for ${name}`);
    }
    const attributes = (await io.aws([
      'sqs', 'get-queue-attributes', '--queue-url', url,
      '--attribute-names', 'QueueArn', 'VisibilityTimeout', 'RedrivePolicy',
    ])).Attributes;
    const arnMatch = typeof attributes?.QueueArn === 'string'
      ? /^arn:aws:sqs:([a-z0-9-]+):(\d{12}):([a-z0-9-]+)$/.exec(attributes.QueueArn) : null;
    if (!arnMatch || arnMatch[1] !== CREDENTIAL_REGION || arnMatch[2] !== reviewedAccount
      || arnMatch[3] !== name || !arnMatch[3].startsWith(QUEUE_NAME_PREFIX)) {
      throw new Error(`Foreign queue observation for ${name}`);
    }
    const visibility = Number(attributes.VisibilityTimeout);
    if (!Number.isSafeInteger(visibility)) throw new Error(`Deployed ${name} queue configuration is not numeric`);
    let maxReceives = null;
    if (attributes.RedrivePolicy) {
      let redrive;
      try {
        redrive = parseStrictJson(attributes.RedrivePolicy);
      } catch (error) {
        throw new Error(`Deployed ${name} queue redrive policy is unreadable (${error.message})`, { cause: error });
      }
      const receives = Number(redrive.maxReceiveCount);
      if (!Number.isSafeInteger(receives)) throw new Error(`Deployed ${name} queue configuration is not numeric`);
      maxReceives = receives;
    }
    rows.push({ name, queueVisibilitySeconds: visibility, maxReceives });
  }
  return rows.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

// The CloudFront distribution whose `DomainName` or `Aliases` contains the host of the
// live Client URL (the committed endpoint constant). Exactly one match may exist, and it
// must be `Deployed` and enabled.
async function discoverClientDomain(io, clientHost) {
  const distributions = await readPages(io, ['cloudfront', 'list-distributions'], {
    region: CREDENTIAL_REGION, tokenFlag: '--marker', pageKey: 'Items', tokenKey: 'NextMarker',
    truncatedKey: 'IsTruncated', nameOf: (distribution) => distribution.Id,
    label: 'CloudFront list-distributions', readPage: (response) => response.DistributionList,
  });
  const matches = distributions.filter((distribution) => {
    const aliases = Array.isArray(distribution.Aliases?.Items) ? distribution.Aliases.Items : [];
    return distribution.DomainName === clientHost || aliases.includes(clientHost);
  });
  if (matches.length !== 1) {
    throw new Error(`Client domain discovery found ${matches.length} CloudFront distributions serving ${clientHost}; exactly one is required`);
  }
  const [distribution] = matches;
  if (distribution.Status !== 'Deployed' || distribution.Enabled !== true) {
    throw new Error(`CloudFront distribution serving ${clientHost} is not deployed and enabled (Status ${distribution.Status}, Enabled ${distribution.Enabled})`);
  }
  if (typeof distribution.DomainName !== 'string' || distribution.DomainName.length === 0) {
    throw new Error(`CloudFront distribution serving ${clientHost} has no domain name`);
  }
  return distribution.DomainName;
}

// One full discovery pass over the deployed surface. It returns the derived platform
// body and the per-stack identity bracket the closing re-read compares.
async function discoverPlatform(io, { reviewedAccount, clientHost }) {
  const { rows: stacks, brackets } = await discoverStacks(io, reviewedAccount);
  const inputs = await discoverStageInputs(io);
  const lambdas = await discoverLambdas(io, reviewedAccount);
  const queues = await discoverQueues(io, reviewedAccount);
  const clientDomain = await discoverClientDomain(io, clientHost);
  const body = {
    stacks,
    inputs,
    schema_sha256: contentHash(inputs.map(({ parameter, version }) => ({ parameter, version }))),
    lambdas,
    queues,
    client_domain: clientDomain,
  };
  return { body, brackets };
}

// The authenticated platform snapshot. `io` defaults to the AWS CLI; unit tests pass
// a fixture reader. The account identity is re-read rather than assumed, so an
// observation taken under another account cannot be recorded as Beta. The closing
// second pass refuses a stack added or removed, or any member changed, mid-observation.
export async function observePlatform({ io = liveObservationIo(), clientHost } = {}) {
  if (typeof clientHost !== 'string' || clientHost.length === 0) {
    throw new Error('Platform observation requires the Client URL host');
  }
  const reviewedAccount = account();
  const caller = await io.aws(['sts', 'get-caller-identity']);
  if (caller?.Account !== reviewedAccount) {
    throw new Error(`Platform observation requires the Beta account ${reviewedAccount} (observed ${caller?.Account})`);
  }
  // A deployment that crosses the observation must not be recorded as one platform
  // state: the whole discovery runs a second time, the derived platform bodies must be
  // identical, and each stack's identity, status and update time bracket the whole read.
  const first = await discoverPlatform(io, { reviewedAccount, clientHost });
  const second = await discoverPlatform(io, { reviewedAccount, clientHost });
  assertEqual(second.body, first.body, 'Platform discovery');
  for (const [name, original] of first.brackets) {
    const after = second.brackets.get(name);
    if (!after) throw new Error(`Discovered stack ${name} disappeared during the observation`);
    if (after.StackId !== original.StackId || after.StackStatus !== original.StackStatus
      || after.updatedAt !== original.updatedAt) {
      throw new Error(`CloudFormation stack ${name} changed during the authenticated observation`);
    }
  }
  return first.body;
}
