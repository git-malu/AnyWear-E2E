import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parseStrictJson } from './evidence-contract.mjs';
import { assertE2EExecution } from './execution-guard.mjs';
import { workerSlotOffset } from './worker-slots.mjs';

const policyNames = ['admission_suspended', 'intake_open', 'tester_allowlist'];
const parameterNames = policyNames.map(name => `/anywear/beta/${name}`);
const qualificationWorkflow = 'git-malu/AnyWear-E2E/.github/workflows/beta-qualification.yml@refs/heads/main';
// Match the Infra tester producer's accepted email syntax and normalization.
const emailPattern = /^[a-z0-9.!#$%&'+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

export function validateBetaAdmissionPolicy(response, slotOffset = 0) {
  const offset = workerSlotOffset({ E2E_WORKER_SLOT_OFFSET: String(slotOffset) }, 2);
  const workerEmails = [offset, offset + 1].map(slot => `e2e-beta-worker-${slot}-chromium@anywear.local`);
  if (!response || !Array.isArray(response.Parameters) || response.Parameters.length !== parameterNames.length
    || (response.InvalidParameters !== undefined
      && (!Array.isArray(response.InvalidParameters) || response.InvalidParameters.length !== 0))) {
    throw new Error('Beta admission eligibility requires all three exact SSM parameters');
  }
  const parameters = new Map();
  for (const parameter of response.Parameters) {
    if (!parameter || !parameterNames.includes(parameter.Name) || parameters.has(parameter.Name)
      || parameter.Type !== 'String' || typeof parameter.Value !== 'string'
      || Buffer.byteLength(parameter.Value, 'utf8') > 4096
      || !Number.isSafeInteger(parameter.Version) || parameter.Version < 1) {
      throw new Error('Beta admission eligibility received malformed or duplicate SSM parameters');
    }
    parameters.set(parameter.Name, parameter);
  }
  const policy = Object.fromEntries(policyNames.map(name => [name, parameters.get(`/anywear/beta/${name}`)]));
  for (const name of ['admission_suspended', 'intake_open']) {
    if (!['true', 'false'].includes(policy[name].Value)) {
      throw new Error(`Beta admission eligibility received malformed ${name}`);
    }
  }
  if (policy.admission_suspended.Value !== 'false') {
    throw new Error('Beta admission is suspended; an authorized admission window is required before qualification');
  }
  if (policy.intake_open.Value !== 'false') {
    throw new Error('Beta qualification requires public intake closed');
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
  if (workerEmails.some(email => !normalized.includes(email))) {
    throw new Error('Beta admission eligibility requires both configured stable Chromium worker identities');
  }
  // Return only non-sensitive policy versions; never log the tester membership.
  return { workerCount: workerEmails.length, versions: Object.fromEntries(policyNames.map(name => [name, policy[name].Version])) };
}

export function verifyBetaAdmissionEligibility(environment = process.env, { execute = execFileSync, sourceSha } = {}) {
  assertE2EExecution(environment, { sourceSha });
  if (environment.GITHUB_WORKFLOW_REF !== qualificationWorkflow || environment.E2E_WORKERS !== '2') {
    throw new Error('Beta admission eligibility requires the exact qualification workflow with two stable Chromium workers');
  }
  const offset = workerSlotOffset(environment, 2);
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
  return validateBetaAdmissionPolicy(response, offset);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 2) throw new Error('Unknown Beta admission eligibility option');
  verifyBetaAdmissionEligibility();
  console.log('Verified unsuspended private Beta admission for both stable Chromium workers.');
}
