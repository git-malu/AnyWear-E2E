import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { byteHash, parseStrictJson, validateCompatibility } from './evidence-contract.mjs';
import { qualificationFixture } from './fixtures/infra-qualification.mjs';
import { assertCompatibilityPin, validatorArguments } from './validate-compatibility-pin.mjs';

const execute = promisify(execFile);
const validatorPath = fileURLToPath(new URL('./validate-compatibility-pin.mjs', import.meta.url));

// The coherent pair: the fixture serialises each deployment record once as two
// space indented JSON plus a trailing newline, and those exact byte sequences are
// what the pin's `record_sha256` members hash.
async function prepare() {
  const directory = await mkdtemp(join(tmpdir(), 'anywear-compatibility-pin-'));
  const fixture = qualificationFixture();
  const input = {
    fixture,
    platformBytes: `${JSON.stringify(fixture.platformRecord, null, 2)}\n`,
    workloadBytes: `${JSON.stringify(fixture.workloadRecord, null, 2)}\n`,
    pin: structuredClone(fixture.compatibility),
    previous: structuredClone(fixture.compatibility),
    paths: {
      platformRecord: join(directory, 'platform-deployment-record.json'),
      deploymentRecord: join(directory, 'deployment-record.json'),
      previous: join(directory, 'previous-compatibility.json'),
      compatibility: join(directory, 'compatibility.json'),
    },
  };
  // A previous pin is the same reviewed tuple one run earlier: still a valid v3
  // pin, and behind each run the new pin names.
  input.previous.platform.record.run_id = input.pin.platform.record.run_id - 1;
  input.previous.deployment.run_id = input.pin.deployment.run_id - 1;
  input.write = async ({ platform, deployment } = {}) => {
    await writeFile(input.paths.platformRecord, platform ?? input.platformBytes);
    await writeFile(input.paths.deploymentRecord, deployment ?? input.workloadBytes);
    await writeFile(input.paths.compatibility, `${JSON.stringify(input.pin, null, 2)}\n`);
    await writeFile(input.paths.previous, `${JSON.stringify(input.previous, null, 2)}\n`);
    return input.paths;
  };
  input.close = () => rm(directory, { recursive: true, force: true });
  return input;
}

// The committed pin is the reviewed tuple, not a fixture: it must stay v3, keep
// the recorded Workload deployment identity the move pinned, and state why the
// Platform record is still deferred. A later move updates this expectation with
// the pin.
test('the committed pin records the workload deployment identity and keeps the platform record deferred', async () => {
  const pin = validateCompatibility(parseStrictJson(await readFile(new URL('../compatibility.json', import.meta.url))));
  assert.equal(pin.version, 3);
  assert.equal(pin.deployment.status, 'recorded');
  assert.equal(pin.deployment.producer, pin.workload.producer);
  assert.equal(pin.deployment.workflow_path, '.github/workflows/service-artifacts.yml');
  for (const field of ['run_id', 'run_attempt', 'artifact_id']) {
    assert.ok(Number.isSafeInteger(pin.deployment[field]) && pin.deployment[field] >= 1, `deployment.${field} must be a positive integer`);
  }
  assert.match(pin.deployment.record_sha256, /^[0-9a-f]{64}$/);
  assert.equal(pin.platform.record.status, 'deferred');
  assert.match(pin.platform.record.reason, /platform record/);
  assert.match(pin.platform.record.reason, /change set/);
});

test('the coherent pair passes and reports both producer records and moved members', async (t) => {
  const input = await prepare();
  t.after(input.close);
  const summary = await assertCompatibilityPin(await input.write());
  assert.equal(summary.deployment.platform.record_sha256, byteHash(input.platformBytes));
  assert.equal(summary.deployment.workload.record_sha256, byteHash(input.workloadBytes));
  assert.equal(summary.deployment.platform.run_id, input.fixture.compatibility.platform.record.run_id);
  assert.equal(summary.deployment.workload.run_id, input.fixture.compatibility.deployment.run_id);
  assert.equal(summary.deployment.platform.artifact_id, input.pin.platform.record.artifact_id);
  assert.equal(summary.deployment.workload.artifact_id, input.pin.deployment.artifact_id);
  assert.deepEqual(summary.moved_members, ['platform', 'deployment']);
});

test('each record-bound member mutation fails against the downloaded records', async () => {
  const cases = [
    ['client.sha', (pin) => { pin.client.sha = 'f'.repeat(40); }, /observed Client/],
    ['service.sha', (pin) => { pin.service.sha = 'f'.repeat(40); }, /observed Service/],
    ['platform.producer_sha', (pin) => { pin.platform.producer_sha = 'f'.repeat(40); }, /Deployment record producer/],
    ['workload.producer_sha', (pin) => { pin.workload.producer_sha = 'f'.repeat(40); }, /Deployment record producer/],
    ['platform.record.record_sha256', (pin) => { pin.platform.record.record_sha256 = 'b'.repeat(64); }, /platform\.record\.record_sha256/],
    ['deployment.record_sha256', (pin) => { pin.deployment.record_sha256 = 'b'.repeat(64); }, /deployment\.record_sha256/],
  ];
  for (const [member, mutate, expected] of cases) {
    const input = await prepare();
    try {
      mutate(input.pin);
      await assert.rejects(assertCompatibilityPin(await input.write()), expected, `${member} must not pass the offline check`);
    } finally {
      await input.close();
    }
  }
});

test('a re-serialised record fails on its byte hash, never on parsing', async () => {
  const fixture = qualificationFixture();
  for (const [platform, deployment] of [
    [JSON.stringify(fixture.platformRecord), JSON.stringify(fixture.workloadRecord)],
    [`${JSON.stringify(fixture.platformRecord, null, 4)}\n`, `${JSON.stringify(fixture.workloadRecord, null, 4)}\n`],
  ]) {
    const input = await prepare();
    try {
      // The pin is untouched and the payloads are identical: only the bytes moved.
      await input.write({ platform, deployment });
      await assert.rejects(assertCompatibilityPin(input.paths), /record_sha256/);
    } finally {
      await input.close();
    }
  }
});

test('a deferred identity, a non-forward run or a no-op re-pin is refused', async () => {
  const deferred = await prepare();
  try {
    deferred.pin.deployment = {
      producer: deferred.pin.deployment.producer,
      workflow_path: deferred.pin.deployment.workflow_path,
      status: 'deferred',
      reason: 'no Service record yet',
    };
    await assert.rejects(assertCompatibilityPin(await deferred.write()), /Deployment evidence deferred/);
  } finally {
    await deferred.close();
  }
  const backwards = await prepare();
  try {
    backwards.previous.platform.record.run_id = backwards.pin.platform.record.run_id + 1;
    await assert.rejects(assertCompatibilityPin(await backwards.write()), /platform\.record\.run_id/);
  } finally {
    await backwards.close();
  }
  const unchanged = await prepare();
  try {
    unchanged.previous = structuredClone(unchanged.pin);
    await assert.rejects(assertCompatibilityPin(await unchanged.write()), /identity members are unchanged/);
  } finally {
    await unchanged.close();
  }
});

test('artifact ids and service_artifacts are unconstrained offline and stay live-binding checks', async (t) => {
  const input = await prepare();
  t.after(input.close);
  // These members appear nowhere in either deployment record, so no offline input
  // constrains them; only the live binding at qualification time can read the
  // artifact pages and the sealed release.
  input.pin.platform.record.artifact_id += 1;
  input.pin.deployment.artifact_id += 1;
  input.pin.service_artifacts.manifest_asset_id += 1;
  const summary = await assertCompatibilityPin(await input.write());
  assert.equal(summary.deployment.platform.artifact_id, input.pin.platform.record.artifact_id);
  assert.equal(summary.deployment.workload.artifact_id, input.pin.deployment.artifact_id);
});

test('a historical v2 previous pin is accepted as the strict migration input', async (t) => {
  const input = await prepare();
  t.after(input.close);
  input.previous = {
    version: 2,
    client: structuredClone(input.pin.client),
    service: structuredClone(input.pin.service),
    infra: structuredClone(input.pin.infra),
    service_artifacts: structuredClone(input.pin.service_artifacts),
    deployment: { repository: 'git-malu/AnyWear-Infra', workflow_path: '.github/workflows/runtime.yml',
      run_id: 10, run_attempt: 1, artifact_id: 20, record_sha256: 'a'.repeat(64) },
  };
  const summary = await assertCompatibilityPin(await input.write());
  assert.deepEqual(summary.previous, { version: 2 });
});

test('the CLI exits 0 for a coherent pin and 1 naming the member for an unbound one', async () => {
  const passing = await prepare();
  const failing = await prepare();
  try {
    const args = (paths) => ['--platform-record', paths.platformRecord, '--deployment-record', paths.deploymentRecord,
      '--previous', paths.previous, '--compatibility', paths.compatibility];
    const ok = await execute(process.execPath, [validatorPath, ...args(await passing.write())]);
    assert.match(ok.stdout, /Compatibility pin is coherent/);
    failing.pin.platform.producer_sha = 'f'.repeat(40);
    const failure = await execute(process.execPath, [validatorPath, ...args(await failing.write())])
      .then(() => null, (error) => error);
    assert.ok(failure, 'the CLI must fail for a pin the records do not bind');
    assert.equal(failure.code, 1);
    assert.match(failure.stderr, /Deployment record producer/);
  } finally {
    await passing.close();
    await failing.close();
  }
});

test('the CLI rejects unknown, duplicated and valueless options', () => {
  assert.deepEqual(Object.keys(validatorArguments(['--platform-record', 'platform.json', '--deployment-record', 'record.json', '--previous', 'previous.json'])).sort(),
    ['compatibility', 'deploymentRecord', 'platformRecord', 'previous']);
  assert.equal(validatorArguments(['--platform-record', 'platform.json', '--deployment-record', 'record.json', '--previous', 'previous.json']).deploymentRecord, resolve('record.json'));
  assert.throws(() => validatorArguments([]), /--platform-record is required/);
  assert.throws(() => validatorArguments(['--platform-record', 'platform.json', '--deployment-record', 'record.json']), /--previous is required/);
  assert.throws(() => validatorArguments(['--platform-record', 'platform.json', '--deployment-record', 'record.json', '--previous', 'previous.json', '--output', 'out.json']), /Unsupported argument --output/);
  assert.throws(() => validatorArguments(['--platform-record', 'platform.json', '--platform-record', 'other.json', '--deployment-record', 'record.json', '--previous', 'previous.json']), /only once/);
  assert.throws(() => validatorArguments(['--platform-record', '--deployment-record', 'record.json', '--previous', 'previous.json']), /--platform-record requires a path/);
});
