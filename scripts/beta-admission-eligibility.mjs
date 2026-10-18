import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ADMISSION_MODE_PARAMETER, TESTER_ALLOWLIST_PARAMETER, effectiveAdmissionMode, parseAdmissionMode } from './beta-admission-mode.mjs';
import { parseStrictJson } from './evidence-contract.mjs';
import { assertE2EExecution } from './execution-guard.mjs';

const parameters = { admission_mode: ADMISSION_MODE_PARAMETER, tester_allowlist: TESTER_ALLOWLIST_PARAMETER };
const policyNames = Object.keys(parameters);
const parameterNames = Object.values(parameters);
const qualificationWorkflow = 'git-malu/AnyWear-E2E/.github/workflows/beta-qualification.yml@refs/heads/main';
// Match the Infra tester producer's accepted email syntax and normalization.
const emailPattern = /^[a-z0-9.!#$%&'+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

export function validateBetaAdmissionPolicy(response) {
  if (!response || !Array.isArray(response.Parameters) || response.Parameters.length !== parameterNames.length
    || (response.InvalidParameters !== undefined
      && (!Array.isArray(response.InvalidParameters) || response.InvalidParameters.length !== 0))) {
    throw new Error('Beta admission eligibility requires both exact SSM parameters');
  }
  const read = new Map();
  for (const parameter of response.Parameters) {
    if (!parameter || !parameterNames.includes(parameter.Name) || read.has(parameter.Name)
      || parameter.Type !== 'String' || typeof parameter.Value !== 'string'
      || Buffer.byteLength(parameter.Value, 'utf8') > 4096
      || !Number.isSafeInteger(parameter.Version) || parameter.Version < 1) {
      throw new Error('Beta admission eligibility received malformed or duplicate SSM parameters');
    }
    read.set(parameter.Name, parameter);
  }
  const policy = Object.fromEntries(policyNames.map(name => [name, read.get(parameters[name])]));
  // The mode record states its own condition, so the pre-flight names one requirement
  // instead of remembering two booleans: admission is `testers`. The record is windowless,
  // so a closed decision stays closed until an operator opens it explicitly; nothing
  // expires, and no bound can make an open record refuse.
  const declared = parseAdmissionMode(policy.admission_mode.Value);
  if (!declared) throw new Error('Beta admission eligibility received a malformed admission mode record');
  if (effectiveAdmissionMode(policy.admission_mode.Value).mode !== 'testers') {
    throw new Error('Beta admission is closed; it must be explicitly opened (open-admission / lifecycle resume) before qualification');
  }
  let testers;
  try { testers = parseStrictJson(policy.tester_allowlist.Value); }
  catch { throw new Error('Beta admission eligibility received malformed tester allowlist JSON'); }
  if (!Array.isArray(testers) || testers.length > 50 || testers.some(email => typeof email !== 'string')) {
    throw new Error('Beta admission eligibility requires a valid tester email list');
  }
  const normalized = testers.map(email => email.trim().toLowerCase());
  if (normalized.some(email => email.length > 254 || !emailPattern.test(email))
    || new Set(normalized).size !== normalized.length) {
    throw new Error('Beta admission eligibility requires valid unique tester emails');
  }
  // The list's shape is validated, never its membership: a run-scoped harness
  // address is admitted through the anchored namespace, so no run needs a row.
  // Return only non-sensitive policy versions; never log the tester membership.
  return { versions: Object.fromEntries(policyNames.map(name => [name, policy[name].Version])) };
}

export function verifyBetaAdmissionEligibility(environment = process.env, { execute = execFileSync, sourceSha } = {}) {
  assertE2EExecution(environment, { sourceSha });
  // #163: full and smoke qualify with two workers, measure runs the single-slot workload,
  // and all three read the admission mode from the one qualify entry. The worker count is
  // part of the operation's shape, so the exact entry is no longer enough on its own.
  const expectedWorkers = environment.E2E_OPERATION === 'measure' ? '1' : '2';
  if (environment.GITHUB_WORKFLOW_REF !== qualificationWorkflow || environment.E2E_WORKERS !== expectedWorkers) {
    throw new Error(`Beta admission eligibility requires the exact qualification workflow with exactly ${expectedWorkers} worker${expectedWorkers === '1' ? '' : 's'} for operation ${environment.E2E_OPERATION}`);
  }
  let response;
  try {
    response = parseStrictJson(execute('aws', ['ssm', 'get-parameters', '--names', ...parameterNames,
      '--region', environment.AWS_REGION, '--output', 'json', '--no-cli-pager'], {
      encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'], env: environment,
    }));
  } catch {
    // CLI failures may include raw values or credentials; keep the diagnostic bounded.
    throw new Error('Beta admission eligibility could not read valid SSM policy; qualification refused');
  }
  return validateBetaAdmissionPolicy(response);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 2) throw new Error('Unknown Beta admission eligibility option');
  verifyBetaAdmissionEligibility();
  console.log('Verified explicitly open Beta admission for the qualification run.');
}
