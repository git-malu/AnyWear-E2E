import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { validateBetaAdmissionPolicy, verifyBetaAdmissionEligibility } from './beta-admission-eligibility.mjs';

const sourceSha = 'a'.repeat(40);
const workers = ['e2e-beta-worker-0-chromium@anywear.local', 'e2e-beta-worker-1-chromium@anywear.local'];

function environment(patch = {}) {
  return {
    GITHUB_REPOSITORY: 'git-malu/AnyWear-E2E', GITHUB_REPOSITORY_ID: '1317091305',
    GITHUB_REPOSITORY_OWNER: 'git-malu', GITHUB_REPOSITORY_OWNER_ID: '11473072',
    GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_SHA: sourceSha, GITHUB_WORKFLOW_SHA: sourceSha,
    GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-E2E/.github/workflows/beta-qualification.yml@refs/heads/main',
    GITHUB_RUN_ID: '123456789', GITHUB_RUN_ATTEMPT: '1',
    E2E_STAGE: 'beta', ENABLE_INFRA_E2E: 'true', E2E_WORKERS: '2',
    E2E_CLEANUP_SERVICE_SHA: 'b'.repeat(40),
    AWS_ACCOUNT_ID: '650880818323', AWS_REGION: 'ap-east-1', E2E_AWS_ACCOUNT: '650880818323',
    E2E_AWS_PRINCIPAL_ARN: 'arn:aws:sts::650880818323:assumed-role/beta-e2e-qualification-role/fixture',
    ...patch,
  };
}

function response(patch = {}) {
  const values = { admission_suspended: 'false', intake_open: 'false', tester_allowlist: JSON.stringify([...workers, 'human@example.com']), ...patch };
  return { Parameters: Object.entries(values).map(([name, Value]) => ({
    Name: `/anywear/beta/${name}`, Type: 'String', Value, Version: 7,
  })), InvalidParameters: [] };
}

function reader(payload = JSON.stringify(response())) {
  const calls = [];
  return {
    calls,
    execute(command, args, options) {
      calls.push({ command, args, options });
      if (payload instanceof Error) throw payload;
      return payload;
    },
  };
}

test('eligible private admission reads only the exact three parameters under the dedicated guarded executor', () => {
  const input = environment();
  const io = reader();
  assert.deepEqual(verifyBetaAdmissionEligibility(input, { execute: io.execute, sourceSha }), {
    workerCount: 2, versions: { admission_suspended: 7, intake_open: 7, tester_allowlist: 7 },
  });
  assert.deepEqual(io.calls, [{ command: 'aws', args: [
    'ssm', 'get-parameters', '--names', '/anywear/beta/admission_suspended',
    '/anywear/beta/intake_open', '/anywear/beta/tester_allowlist',
    '--region', 'ap-east-1', '--output', 'json', '--no-cli-pager',
  ], options: { encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'], env: input } }]);
});

test('missing or foreign dedicated identity and untrusted dispatch fail before any cloud access', () => {
  for (const patch of [
    { E2E_AWS_ACCOUNT: undefined }, { E2E_AWS_ACCOUNT: '111111111111' },
    { E2E_AWS_PRINCIPAL_ARN: undefined },
    { E2E_AWS_PRINCIPAL_ARN: 'arn:aws:sts::650880818323:assumed-role/beta-infra-deployment-role/fixture' },
    { E2E_AWS_PRINCIPAL_ARN: 'arn:aws:iam::650880818323:user/local-admin' },
    { GITHUB_REPOSITORY: 'foreign/AnyWear-E2E' }, { GITHUB_REPOSITORY_ID: '1' },
    { GITHUB_REPOSITORY_OWNER: 'foreign' }, { GITHUB_REPOSITORY_OWNER_ID: '1' },
    { GITHUB_REF: 'refs/heads/candidate' }, { GITHUB_EVENT_NAME: 'pull_request' },
    { GITHUB_WORKFLOW_SHA: 'c'.repeat(40) },
    { GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-E2E/.github/workflows/integration.yml@refs/heads/main' },
    { E2E_STAGE: 'dev' }, { ENABLE_INFRA_E2E: 'false' },
    { AWS_ACCOUNT_ID: '111111111111' }, { AWS_REGION: 'us-east-1' },
    { E2E_CLEANUP_SERVICE_SHA: undefined }, { GITHUB_RUN_ID: undefined },
  ]) {
    const io = reader();
    assert.throws(() => verifyBetaAdmissionEligibility(environment(patch), { execute: io.execute, sourceSha }));
    assert.deepEqual(io.calls, [], JSON.stringify(patch));
  }
  const io = reader();
  assert.throws(() => verifyBetaAdmissionEligibility(environment(), { execute: io.execute, sourceSha: 'c'.repeat(40) }), /checkout/);
  assert.deepEqual(io.calls, []);
});

test('the qualification requires explicitly configured two workers before any SSM read', () => {
  for (const E2E_WORKERS of [undefined, '', '1', '3', '02', '2.0']) {
    const io = reader();
    assert.throws(() => verifyBetaAdmissionEligibility(environment({ E2E_WORKERS }), { execute: io.execute, sourceSha }), /two stable Chromium workers/);
    assert.deepEqual(io.calls, []);
  }
});

test('allocated worker offset checks selected memberships and invalid offsets refuse cloud access', () => {
  const io = reader(JSON.stringify(response({ tester_allowlist: JSON.stringify(['e2e-beta-worker-2-chromium@anywear.local', 'e2e-beta-worker-3-chromium@anywear.local']) })));
  assert.equal(verifyBetaAdmissionEligibility(environment({ E2E_WORKER_SLOT_OFFSET: '2' }), { execute: io.execute, sourceSha }).workerCount, 2);
  assert.throws(() => verifyBetaAdmissionEligibility(environment({ E2E_WORKER_SLOT_OFFSET: '2' }), { execute: reader().execute, sourceSha }), /configured stable/);
  for (const E2E_WORKER_SLOT_OFFSET of ['', '-1', '7', '2.5', '02', '1e0']) {
    const rejected = reader();
    assert.throws(() => verifyBetaAdmissionEligibility(environment({ E2E_WORKER_SLOT_OFFSET }), { execute: rejected.execute, sourceSha }), /SLOT_OFFSET/);
    assert.equal(rejected.calls.length, 0);
  }
});

test('suspended admission and open public intake refuse qualification without any policy mutation', () => {
  for (const [patch, message] of [
    [{ admission_suspended: 'true' }, /admission is suspended/],
    [{ intake_open: 'true' }, /public intake closed/],
  ]) {
    const io = reader(JSON.stringify(response(patch)));
    assert.throws(() => verifyBetaAdmissionEligibility(environment(), { execute: io.execute, sourceSha }), message);
    assert.equal(io.calls.length, 1);
    assert.deepEqual(io.calls[0].args.slice(0, 2), ['ssm', 'get-parameters']);
  }
});

test('both stable Chromium worker emails must be members; another slot or browser does not qualify', () => {
  for (const testers of [[], workers.slice(0, 1), workers.slice(1),
    [workers[0], 'e2e-beta-worker-2-chromium@anywear.local'],
    [workers[0], 'e2e-beta-worker-1-firefox@anywear.local']]) {
    assert.throws(() => validateBetaAdmissionPolicy(response({ tester_allowlist: JSON.stringify(testers) })), /both configured stable Chromium/);
  }
  assert.doesNotThrow(() => validateBetaAdmissionPolicy(response({ tester_allowlist: JSON.stringify(workers.map(email => ` ${email.toUpperCase()} `)) })));
  assert.doesNotThrow(() => validateBetaAdmissionPolicy(response({
    tester_allowlist: JSON.stringify([...workers, "human!#$%&'+/=?^_`{|}~-@example.com"]),
  })));
});

test('the retained stable allowlist rows stay required and scoped attempt addresses cannot replace them', () => {
  // Issue #129: the per-attempt worker addresses are now run/attempt-scoped, but
  // the Infra tester producer is exact-membership and rejects wildcards, so the
  // two stable rows stay in the allowlist and stay required. A scoped address is
  // a valid tester email, yet it never satisfies that membership.
  const scoped = [
    'e2e-beta-123456789-1-0123456789abcdef-0-a1b2c3d4@anywear.local',
    'e2e-beta-123456789-1-0123456789abcdef-1-b1c2d3e4@anywear.local',
  ];
  assert.throws(() => validateBetaAdmissionPolicy(response({ tester_allowlist: JSON.stringify(scoped) })),
    /both configured stable Chromium/);
  assert.throws(() => validateBetaAdmissionPolicy(response({ tester_allowlist: JSON.stringify([workers[0], scoped[0]]) })),
    /both configured stable Chromium/);
  assert.throws(() => validateBetaAdmissionPolicy(response({ tester_allowlist: JSON.stringify([scoped[0], workers[1]]) })),
    /both configured stable Chromium/);
  assert.doesNotThrow(() => validateBetaAdmissionPolicy(response({ tester_allowlist: JSON.stringify(workers) })));
  // The rows are literal membership, never a pattern: a near-miss row refuses.
  assert.throws(() => validateBetaAdmissionPolicy(response({
    tester_allowlist: JSON.stringify(['e2e-beta-worker-0-chromium@anywear.local', 'e2e-beta-worker-1-chromium@anywear.local.evil.example']),
  })), /both configured stable Chromium/);
});

test('incomplete, duplicate, unexpected or malformed parameter entries never supply a permissive default', () => {
  const valid = response();
  for (const invalid of [null, {}, { Parameters: null }, { Parameters: [] },
    { Parameters: valid.Parameters.slice(0, 2) },
    { Parameters: [...valid.Parameters, valid.Parameters[0]] },
    { Parameters: [valid.Parameters[0], valid.Parameters[0], valid.Parameters[2]] },
    { ...valid, InvalidParameters: ['/anywear/beta/intake_open'] },
    { ...valid, InvalidParameters: null }]) {
    assert.throws(() => validateBetaAdmissionPolicy(invalid));
  }
  for (const patch of [
    { Name: '/anywear/prod/admission_suspended' }, { Name: undefined },
    { Type: 'SecureString' }, { Value: undefined }, { Value: false }, { Value: 'x'.repeat(4097) },
    { Version: undefined }, { Version: 0 }, { Version: 1.5 }, { Version: '7' },
  ]) {
    const invalid = response();
    Object.assign(invalid.Parameters[0], patch);
    assert.throws(() => validateBetaAdmissionPolicy(invalid), /malformed or duplicate/);
  }
  const invalid = response(); invalid.Parameters[0] = null;
  assert.throws(() => validateBetaAdmissionPolicy(invalid));
});

test('Boolean strings, tester JSON, email validity and normalized membership uniqueness fail closed', () => {
  for (const name of ['admission_suspended', 'intake_open']) {
    for (const value of ['', 'False', ' false', '0', 'null']) {
      assert.throws(() => validateBetaAdmissionPolicy(response({ [name]: value })), /malformed/);
    }
  }
  for (const value of ['not json', '[', '{"x":1,"x":2}', 'null', '{}', '"email"',
    JSON.stringify([...workers, null]), JSON.stringify([...workers, '']),
    JSON.stringify([...workers, 'not-an-email']), JSON.stringify([...workers, 'human*@example.com']),
    JSON.stringify([...workers, 'human@example-.com']),
    JSON.stringify([...workers, `${'a'.repeat(250)}@example.com`]),
    JSON.stringify([...workers, workers[0]]), JSON.stringify([...workers, ` ${workers[1].toUpperCase()} `]),
    JSON.stringify([...workers, ...Array.from({ length: 49 }, (_, i) => `human${i}@example.com`)])]) {
    assert.throws(() => validateBetaAdmissionPolicy(response({ tester_allowlist: value })));
  }
});

test('unavailable or malformed CLI JSON produces a bounded diagnostic without raw output or secrets', () => {
  const sensitive = 'fixture-secret-that-must-not-appear';
  const duplicate = JSON.stringify(response()).replace('"InvalidParameters":[]', '"InvalidParameters":[],"InvalidParameters":[]');
  for (const payload of [new Error(sensitive), sensitive, '', '{} trailing', duplicate,
    Buffer.from([0xc0, 0xaf]), JSON.stringify({ Parameters: [], InvalidParameters: [] })]) {
    const io = reader(payload);
    let failure;
    try { verifyBetaAdmissionEligibility(environment(), { execute: io.execute, sourceSha }); }
    catch (error) { failure = error; }
    assert.ok(failure);
    assert.match(failure.message, /Beta admission eligibility/);
    assert.doesNotMatch(failure.message, new RegExp(sensitive));
    assert.equal(failure.cause, undefined);
    assert.equal(io.calls.length, 1);
  }
});

test('workflow runs mandatory eligibility after dedicated principal verification and before account setup or suite', async () => {
  const workflow = await readFile(new URL('../.github/workflows/beta-qualification.yml', import.meta.url), 'utf8');
  const steps = workflow.split(/\r?\n {6}- name: /).slice(1);
  const eligibility = steps.findIndex(step => step.startsWith('Require Beta admission eligibility\n')
    || step.startsWith('Require Beta admission eligibility\r\n'));
  assert.ok(eligibility > steps.findIndex(step => step.startsWith('Verify dedicated E2E principal')));
  assert.match(steps[eligibility], /run: node scripts\/beta-admission-eligibility\.mjs\s*$/);
  assert.doesNotMatch(steps[eligibility], /\bif:|continue-on-error:/);
  for (const name of ['Observe authenticated deployed tuple before suite',
    'Load Beta test identity configuration', 'Run the release-gating business regression suite']) {
    assert.ok(steps.findIndex(step => step.startsWith(name)) > eligibility, name);
  }
  assert.match(workflow, /E2E_WORKERS: 2\r?\n/);
  assert.doesNotMatch(workflow, /continue-on-error:/);
  const suite = steps.find(step => step.startsWith('Run the release-gating business regression suite'));
  // The gate runs the release selection, not a discovery run: `pnpm test` selects
  // `@regression`, so a measurement scenario cannot enter or leave this step.
  assert.match(suite, /node scripts\/execution-guard\.mjs\r?\n\s+pnpm test\s*$/m);
  assert.doesNotMatch(suite, /if:\s*.*(?:always|failure)/);
  assert.equal(steps.filter(step => /\bpnpm test\s*$/.test(step)).length, 1);
  // The measurement is a separate workflow, not a second job: a release consumer accepts
  // a qualification record only from a completed-success qualification run, so a
  // measurement sharing that run's conclusion could withhold a record the gate produced.
  assert.doesNotMatch(workflow, /instrumentation/);
  assert.doesNotMatch(workflow, /BETA_SIZING_STAGE/);
  const instrumentationWorkflow = await readFile(new URL('../.github/workflows/beta-instrumentation.yml', import.meta.url), 'utf8');
  assert.match(instrumentationWorkflow, /^on:\s*$/m);
  assert.match(instrumentationWorkflow, /^ {6}sizing_stage:\s*$/m);
  assert.match(instrumentationWorkflow, /^ {4}if: github\.ref == 'refs\/heads\/main'\s*$/m);
  assert.match(instrumentationWorkflow, /^ {4}environment: beta\s*$/m);
  assert.match(instrumentationWorkflow, /^ {6}- name: Run the instrumentation workload\s*$/m);
  assert.match(instrumentationWorkflow, /\bpnpm test:instrumentation\s*$/m);
  assert.equal([...instrumentationWorkflow.matchAll(/\bpnpm test:instrumentation\s*$/gm)].length, 1);
  assert.doesNotMatch(instrumentationWorkflow, /continue-on-error:/);
  // A measurement cannot produce the qualified tuple: no record step and no environment
  // refusal, which stay in the qualification workflow.
  assert.doesNotMatch(instrumentationWorkflow, /qualification:(generate|verify)/);
  assert.doesNotMatch(instrumentationWorkflow, /beta-sizing-environment\.mjs qualification-gate/);
  // The worker fixture reserves/provisions only after Playwright starts in that later step.
  const fixture = await readFile(new URL('../tests/support/fixtures.ts', import.meta.url), 'utf8');
  assert.ok(fixture.indexOf('await reserveTestAccount(') < fixture.indexOf('await provisionConfirmedTestAccount('));
});

test('the real CLI exits nonzero for unsafe or unavailable admission without external commands or success output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'anywear-admission-eligibility-'));
  const callsFile = join(directory, 'calls.jsonl');
  const transport = join(directory, 'transport.mjs');
  const preload = join(directory, 'preload.mjs');
  const execute = promisify(execFile);
  try {
    await writeFile(transport, `
import { appendFileSync } from 'node:fs';
export function execFileSync(command, args) {
  appendFileSync(process.env.TEST_ADMISSION_CALLS, JSON.stringify([command, ...args]) + '\\n');
  if (command === 'git' && args.at(-1) === 'HEAD') return process.env.GITHUB_SHA;
  if (command !== 'aws' || args[0] !== 'ssm' || args[1] !== 'get-parameters') throw new Error('External commands blocked');
  if (process.env.TEST_ADMISSION_UNAVAILABLE === 'true') throw new Error('fixture-secret');
  return process.env.TEST_ADMISSION_RESPONSE;
}
`);
    await writeFile(preload, `
import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'node:child_process') return { url: ${JSON.stringify(pathToFileURL(transport).href)}, shortCircuit: true };
  return nextResolve(specifier, context);
} });
globalThis.fetch = async () => { throw new Error('Network blocked'); };
`);
    const isolated = { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, TEMP: directory, TMP: directory,
      NODE_OPTIONS: '', AWS_EC2_METADATA_DISABLED: 'true', ...environment(),
      TEST_ADMISSION_CALLS: callsFile, TEST_ADMISSION_RESPONSE: JSON.stringify(response()) };
    for (const [patch, message] of [
      [{ TEST_ADMISSION_RESPONSE: JSON.stringify(response({ admission_suspended: 'true' })) }, /admission is suspended/],
      [{ TEST_ADMISSION_RESPONSE: JSON.stringify(response({ intake_open: 'true' })) }, /public intake closed/],
      [{ TEST_ADMISSION_RESPONSE: JSON.stringify(response({ tester_allowlist: JSON.stringify(workers.slice(0, 1)) })) }, /both configured stable Chromium/],
      [{ TEST_ADMISSION_UNAVAILABLE: 'true' }, /could not read valid SSM policy/],
      [{ TEST_ADMISSION_RESPONSE: 'not json' }, /could not read valid SSM policy/],
      [{ E2E_AWS_PRINCIPAL_ARN: 'arn:aws:iam::650880818323:user/local-admin' }, /dedicated E2E principal/],
    ]) {
      await writeFile(callsFile, '');
      let failure;
      try {
        await execute(process.execPath, ['--import', pathToFileURL(preload).href,
          fileURLToPath(new URL('./beta-admission-eligibility.mjs', import.meta.url))], {
          env: { ...isolated, ...patch }, timeout: 10_000, maxBuffer: 64 * 1024,
        });
      } catch (error) { failure = error; }
      assert.ok(failure, 'Unsafe admission must fail the mandatory workflow step');
      assert.equal(failure.code, 1);
      assert.match(failure.stderr, message);
      assert.doesNotMatch(failure.stderr, /fixture-secret|human@example\.com/);
      assert.equal(failure.stdout, '', 'The CLI must not claim eligibility on failure');
      const calls = (await readFile(callsFile, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      assert.ok(calls.every(call => call[0] === 'git' || (call[0] === 'aws' && call[1] === 'ssm' && call[2] === 'get-parameters')));
      assert.equal(calls.filter(call => call[0] === 'aws').length, patch.E2E_AWS_PRINCIPAL_ARN ? 0 : 1);
    }
    const success = await execute(process.execPath, ['--import', pathToFileURL(preload).href,
      fileURLToPath(new URL('./beta-admission-eligibility.mjs', import.meta.url))], {
      env: isolated, timeout: 10_000, maxBuffer: 64 * 1024,
    });
    assert.match(success.stdout, /Verified unsuspended private Beta admission/);
    assert.doesNotMatch(success.stdout, /human@example\.com/);
    assert.equal(success.stderr, '');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
