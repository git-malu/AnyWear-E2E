import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { effectiveAdmissionMode, parseAdmissionMode } from './beta-admission-mode.mjs';
import { validateBetaAdmissionPolicy, verifyBetaAdmissionEligibility } from './beta-admission-eligibility.mjs';

const sourceSha = 'a'.repeat(40);
const workers = ['e2e-beta-worker-0-chromium@anywear.local', 'e2e-beta-worker-1-chromium@anywear.local'];

function testersRecord(patch = {}) {
  return JSON.stringify({ mode: 'testers', ...patch });
}

function environment(patch = {}) {
  return {
    GITHUB_REPOSITORY: 'git-malu/AnyWear-E2E', GITHUB_REPOSITORY_ID: '1317091305',
    GITHUB_REPOSITORY_OWNER: 'git-malu', GITHUB_REPOSITORY_OWNER_ID: '11473072',
    GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_SHA: sourceSha, GITHUB_WORKFLOW_SHA: sourceSha,
    GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-E2E/.github/workflows/beta-qualification.yml@refs/heads/main',
    GITHUB_RUN_ID: '123456789', GITHUB_RUN_ATTEMPT: '1',
    E2E_STAGE: 'beta', ENABLE_BETA_MUTATION: 'true', E2E_WORKERS: '2', E2E_OPERATION: 'full',
    E2E_CLEANUP_SERVICE_SHA: 'b'.repeat(40),
    AWS_ACCOUNT_ID: '650880818323', AWS_REGION: 'ap-east-1', E2E_AWS_ACCOUNT: '650880818323',
    E2E_AWS_PRINCIPAL_ARN: 'arn:aws:sts::650880818323:assumed-role/beta-e2e-qualification-role/fixture',
    ...patch,
  };
}

function response(patch = {}) {
  const values = { admission_mode: testersRecord(), tester_allowlist: JSON.stringify([...workers, 'human@example.com']), ...patch };
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

test('an effectively testers record reads only the exact two admission parameters under the dedicated guarded executor', () => {
  const input = environment();
  const io = reader();
  assert.deepEqual(verifyBetaAdmissionEligibility(input, { execute: io.execute, sourceSha }), {
    versions: { admission_mode: 7, tester_allowlist: 7 },
  });
  assert.deepEqual(io.calls, [{ command: 'aws', args: [
    'ssm', 'get-parameters', '--names', '/anywear/beta/admission_mode',
    '/anywear/beta/tester_allowlist',
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
    { E2E_STAGE: 'dev' }, { ENABLE_BETA_MUTATION: 'false' },
    { E2E_OPERATION: undefined }, { E2E_OPERATION: 'observe' },
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

test('the qualification requires the operation\'s explicit worker count before any SSM read', () => {
  for (const E2E_WORKERS of [undefined, '', '3', '02', '2.0']) {
    const io = reader();
    assert.throws(() => verifyBetaAdmissionEligibility(environment({ E2E_WORKERS }), { execute: io.execute, sourceSha }), /exactly 2 workers/);
    assert.deepEqual(io.calls, []);
  }
  // Measure runs the single-worker-slot workload; its count is one, not two.
  const single = reader();
  assert.doesNotThrow(() => verifyBetaAdmissionEligibility(environment({ E2E_OPERATION: 'measure', E2E_WORKERS: '1' }), { execute: single.execute, sourceSha }));
  for (const E2E_WORKERS of [undefined, '', '2', '3']) {
    const io = reader();
    assert.throws(() => verifyBetaAdmissionEligibility(environment({ E2E_OPERATION: 'measure', E2E_WORKERS }), { execute: io.execute, sourceSha }), /exactly 1 worker/);
    assert.deepEqual(io.calls, []);
  }
});

test('a closed or non-canonical admission record refuses qualification without any policy mutation', () => {
  for (const [patch, message] of [
    [{ admission_mode: JSON.stringify({ mode: 'closed' }) }, /admission is closed/],
    // The legacy two-key record is not a reader-valid record any more: admission is
    // windowless, so a record carrying a bound is malformed rather than partly usable.
    [{ admission_mode: JSON.stringify({ mode: 'testers', expires_at: new Date(Date.now() + 60 * 60_000).toISOString() }) }, /malformed admission mode record/],
    [{ admission_mode: JSON.stringify({ mode: 'testers', window_minutes: 60 }) }, /malformed admission mode record/],
  ]) {
    const io = reader(JSON.stringify(response(patch)));
    assert.throws(() => verifyBetaAdmissionEligibility(environment(), { execute: io.execute, sourceSha }), message);
    assert.equal(io.calls.length, 1);
    assert.deepEqual(io.calls[0].args.slice(0, 2), ['ssm', 'get-parameters']);
  }
});

test('admission mode conformance table: only the writer-canonical mode record is read', () => {
  // The writer emits `JSON.stringify({mode})`, so the accepted column is exactly that form.
  // Every other row is fail-closed, and the distinction the table proves is *which*
  // refusal: a well-formed `closed` record is an explicit close, while anything a reader
  // cannot parse — including the legacy record that carried a bound — is malformed.
  const read = (value) => {
    try { validateBetaAdmissionPolicy(response({ admission_mode: value })); return 'open'; }
    catch (error) { return error.message; }
  };
  for (const [value, expected] of [
    [JSON.stringify({ mode: 'testers' }), 'open'],
    [JSON.stringify({ mode: 'closed' }), /admission is closed/],
    // Syntax and shape.
    ['', /malformed admission mode record/],
    ['not json', /malformed admission mode record/],
    // A JSON array carries no `mode` string, so the mode-membership check refuses it even
    // though `typeof [] === 'object'`.
    ['[1]', /malformed admission mode record/],
    ['[]', /malformed admission mode record/],
    ['[{"mode":"testers"}]', /malformed admission mode record/],
    ['null', /malformed admission mode record/],
    ['"testers"', /malformed admission mode record/],
    ['{}', /malformed admission mode record/],
    // A hand-edited duplicate key must never read open: the strict parser refuses it
    // instead of taking the last value the way `JSON.parse` would.
    ['{"mode":"closed","mode":"testers"}', /malformed admission mode record/],
    ['{"mode":"closed","mode":"closed"}', /malformed admission mode record/],
    // Unknown mode, wrong case, and the extra keys the reader refuses. The legacy record
    // that carried `expires_at` belongs here: a window-shaped record is not this record.
    [JSON.stringify({ mode: 'open' }), /malformed admission mode record/],
    [JSON.stringify({ mode: 'Testers' }), /malformed admission mode record/],
    [JSON.stringify({ mode: 'testers', expires_at: '2026-10-17T08:30:00.000Z' }), /malformed admission mode record/],
    [JSON.stringify({ mode: 'testers', expires: '2026-10-17T08:30:00.000Z' }), /malformed admission mode record/],
    [JSON.stringify({ mode: 'closed', extra: true }), /malformed admission mode record/],
    [JSON.stringify({ mode: 'closed', expires_at: null }), /malformed admission mode record/],
    // A mode that is not one of the two strings. The array and object rows are the ones a
    // property-key lookup would have coerced into `testers` (or crashed on); the reader
    // matches by value, so they are refused.
    [JSON.stringify({ mode: ['testers'] }), /malformed admission mode record/],
    ['{"mode":{"toString":0}}', /malformed admission mode record/],
    [JSON.stringify({ mode: 1 }), /malformed admission mode record/],
    [JSON.stringify({ mode: null }), /malformed admission mode record/],
    [JSON.stringify({ mode: true }), /malformed admission mode record/],
    [JSON.stringify({ mode: { mode: 'testers' } }), /malformed admission mode record/],
    // The canonical-bytes rule. Each of these parses to the same object but is not the
    // serialization the writer emits, and the Service reader refuses it too.
    ['{"mode": "testers"}', /malformed admission mode record/],
    ['{"mode": "closed"}', /malformed admission mode record/],
    [`${JSON.stringify({ mode: 'testers' })}\n`, /malformed admission mode record/],
    [` ${JSON.stringify({ mode: 'testers' })}`, /malformed admission mode record/],
    ['{"mode":"test\\u0065rs"}', /malformed admission mode record/],
    ['{"mod\\u0065":"testers"}', /malformed admission mode record/],
  ]) {
    const outcome = read(value);
    if (expected === 'open') assert.equal(outcome, 'open', value);
    else assert.match(outcome, expected, value);
  }
});

test('the reader refuses every non-string or unwritable shape instead of throwing', () => {
  // Callers normally pass `Parameter.Value`, so these rows drive the reader's own input
  // guard directly rather than through the pre-flight.
  for (const value of [undefined, null, 0, 5, true, {}, [], ['testers'], Buffer.from('{"mode":"closed"}'), () => 'closed']) {
    assert.equal(parseAdmissionMode(value), null, String(value));
    assert.deepEqual(effectiveAdmissionMode(value), { mode: 'closed' }, String(value));
  }
  // Shapes whose `mode` cannot be used as a key or coerced into one are refused, not
  // thrown: a TypeError out of the pre-flight reads as a crashed check, not a closed Beta.
  for (const value of ['{"mode":{"toString":0}}', '{"mode":{"valueOf":0}}',
    '{"mode":["testers"]}', '[']) {
    assert.equal(parseAdmissionMode(value), null, value);
  }
});

test('no tester allowlist row is required: empty, partial, foreign-browser and near-miss lists pass', () => {
  for (const testers of [[], workers.slice(0, 1), workers.slice(1),
    [workers[0], 'e2e-beta-worker-2-chromium@anywear.local'],
    [workers[0], 'e2e-beta-worker-1-firefox@anywear.local'],
    ['e2e-beta-worker-1-chromium@anywear.local.evil.example'],
    [workers[0], "human!#$%&'+/=?^_`{|}~-@example.com"]]) {
    assert.doesNotThrow(() => validateBetaAdmissionPolicy(response({ tester_allowlist: JSON.stringify(testers) })),
      JSON.stringify(testers));
  }
  assert.doesNotThrow(() => validateBetaAdmissionPolicy(response({ tester_allowlist: JSON.stringify(workers.map(email => ` ${email.toUpperCase()} `)) })));
});

test('run-scoped harness addresses pass the policy check, with or without stable rows beside them', () => {
  // Issue #129 owns the run/attempt-scoped address family and the anchored
  // namespace on the Service side admits it, so the pre-flight asserts no
  // membership at all. These lists are only validated for shape.
  const scoped = [
    'e2e-beta-123456789-1-0123456789abcdef-0-a1b2c3d4@anywear.local',
    'e2e-beta-123456789-1-0123456789abcdef-1-b1c2d3e4@anywear.local',
  ];
  for (const testers of [scoped, [workers[0], scoped[0]], [scoped[0], workers[1]], [...scoped, workers[0]]]) {
    assert.doesNotThrow(() => validateBetaAdmissionPolicy(response({ tester_allowlist: JSON.stringify(testers) })),
      JSON.stringify(testers));
  }
});

test('an empty tester allowlist passes the whole pre-flight, not only the policy check', () => {
  const io = reader(JSON.stringify(response({ tester_allowlist: '[]' })));
  assert.deepEqual(verifyBetaAdmissionEligibility(environment(), { execute: io.execute, sourceSha }), {
    versions: { admission_mode: 7, tester_allowlist: 7 },
  });
  assert.equal(io.calls.length, 1);
});

test('incomplete, duplicate, unexpected or malformed parameter entries never supply a permissive default', () => {
  const valid = response();
  for (const invalid of [null, {}, { Parameters: null }, { Parameters: [] },
    { Parameters: valid.Parameters.slice(0, 1) },
    { Parameters: [...valid.Parameters, valid.Parameters[0]] },
    { Parameters: [valid.Parameters[0], valid.Parameters[0], valid.Parameters[1]] },
    { ...valid, InvalidParameters: ['/anywear/beta/admission_mode'] },
    { ...valid, InvalidParameters: null }]) {
    assert.throws(() => validateBetaAdmissionPolicy(invalid));
  }
  for (const patch of [
    { Name: '/anywear/prod/admission_mode' }, { Name: undefined },
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

test('tester JSON, email validity and normalized membership uniqueness fail closed', () => {
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
  // #163: one qualify entry carries four operations. full keeps the release-gating suite and
  // the only record production; smoke is the diagnostic; measure is the single-slot workload
  // and the only operation with a sizing stage. Separation lives in the signed operation, so
  // none of them can decide another operation's conclusion.
  const full = workflow.slice(workflow.indexOf('\n  full:\n'), workflow.indexOf('\n  smoke:\n'));
  const smoke = workflow.slice(workflow.indexOf('\n  smoke:\n'), workflow.indexOf('\n  measure:\n'));
  const measure = workflow.slice(workflow.indexOf('\n  measure:\n'), workflow.indexOf('\n  recover:\n'));
  const record = workflow.slice(workflow.indexOf('\n  record:\n'));
  for (const [name, job, stepName, command] of [
    ['full', full, 'Run the release-gating business regression suite', 'pnpm test'],
    ['smoke', smoke, 'Run deployed Beta smoke tests', 'pnpm test:smoke'],
    ['measure', measure, 'Run the instrumentation workload', 'pnpm test:instrumentation'],
  ]) {
    const suite = job.split(/\r?\n {6}- name: /).slice(1).find(step => step.startsWith(stepName));
    assert.ok(suite, `${name} must carry its own suite step`);
    assert.match(suite, new RegExp(`node scripts/execution-guard\\.mjs\\r?\\n\\s+${command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm'));
    assert.doesNotMatch(suite, /continue-on-error:/);
  }
  assert.doesNotMatch(workflow, /continue-on-error:/);
  assert.match(full, /E2E_WORKERS: 2\r?\n/);
  assert.match(measure, /E2E_WORKERS: 1\r?\n/);
  // The record is produced only by full, bound to its dispatched operation, and the record
  // job only validates and attaches it. Neither smoke, measure nor recover can write one.
  assert.ok(record.length > 0, 'the qualify entry must declare a record job');
  assert.match(record, /needs: \[preflight, full\]/);
  assert.doesNotMatch(record, /environment:|id-token|configure-aws-credentials/);
  assert.match(full, /qualification:generate/);
  for (const [name, job] of [['smoke', smoke], ['measure', measure], ['recover', workflow.slice(workflow.indexOf('\n  recover:\n'), workflow.indexOf('\n  record:\n'))], ['record', record]]) {
    assert.doesNotMatch(job, /qualification:(generate|verify)/, `${name} must not produce a qualification record`);
  }
  assert.doesNotMatch(smoke, /BETA_SIZING_STAGE/);
  assert.match(measure, /BETA_SIZING_STAGE: \$\{\{ inputs\.sizing_stage \}\}/);
  assert.doesNotMatch(full, /BETA_SIZING_STAGE/);
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
      [{ TEST_ADMISSION_RESPONSE: JSON.stringify(response({ admission_mode: JSON.stringify({ mode: 'closed' }) })) }, /admission is closed/],
      [{ TEST_ADMISSION_RESPONSE: JSON.stringify(response({ admission_mode: JSON.stringify({ mode: 'testers', expires_at: new Date(Date.now() + 60 * 60_000).toISOString() }) })) }, /malformed admission mode record/],
      [{ TEST_ADMISSION_RESPONSE: JSON.stringify(response({ admission_mode: 'not json' })) }, /malformed admission mode record/],
      [{ TEST_ADMISSION_RESPONSE: JSON.stringify(response({ tester_allowlist: 'not json' })) }, /malformed tester allowlist JSON/],
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
    assert.match(success.stdout, /^Verified explicitly open Beta admission for the qualification run\.$/m);
    assert.doesNotMatch(success.stdout, /human@example\.com/);
    assert.equal(success.stderr, '');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
