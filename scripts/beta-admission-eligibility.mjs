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

export function validateBetaAdmissionPolicy(response, { now = Date.now() } = {}) {
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
  // instead of remembering two booleans: admission is effectively `testers` right now.
  const declared = parseAdmissionMode(policy.admission_mode.Value);
  if (!declared) throw new Error('Beta admission eligibility received a malformed admission mode record');
  if (declared.mode === 'closed') {
    throw new Error('Beta admission is suspended; an authorized admission window is required before qualification');
  }
  // A `testers` record whose bound has passed (or is beyond the read's window) is closed
  // to every reader, so the pre-flight refuses it at the moment it runs.
  if (effectiveAdmissionMode(policy.admission_mode.Value, now).mode !== 'testers') {
    throw new Error('Beta admission window is not open; an authorized admission window is required before qualification');
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
  if (environment.GITHUB_WORKFLOW_REF !== qualificationWorkflow || environment.E2E_WORKERS !== '2') {
    throw new Error('Beta admission eligibility requires the exact qualification workflow with exactly two workers');
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
  console.log('Verified an open Beta admission window for the qualification run.');
}
