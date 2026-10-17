import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { byteHash } from './evidence-contract.mjs';
import { qualificationFixture } from './fixtures/infra-qualification.mjs';
import { assertCompatibilityPin, validatorArguments } from './validate-compatibility-pin.mjs';

const execute = promisify(execFile);
const validatorPath = fileURLToPath(new URL('./validate-compatibility-pin.mjs', import.meta.url));

// The coherent pair: the fixture serialises its deployment record once as two
// space indented JSON plus a trailing newline, and that exact byte sequence is
// what its `compatibility.deployment.record_sha256` hashes.
async function prepare() {
  const directory = await mkdtemp(join(tmpdir(), 'anywear-compatibility-pin-'));
  const fixture = qualificationFixture();
  const input = {
    fixture,
    recordBytes: `${JSON.stringify(fixture.deployment, null, 2)}\n`,
    pin: structuredClone(fixture.compatibility),
    previous: structuredClone(fixture.compatibility),
    paths: {
      deploymentRecord: join(directory, 'deployment-record.json'),
      previous: join(directory, 'previous-compatibility.json'),
      compatibility: join(directory, 'compatibility.json'),
    },
  };
  // A previous pin is the same reviewed tuple one run earlier: still a valid v2
  // pin, and behind the run the new pin names.
  input.previous.deployment.run_id = input.pin.deployment.run_id - 1;
  input.write = async ({ record } = {}) => {
    await writeFile(input.paths.deploymentRecord, record ?? input.recordBytes);
    await writeFile(input.paths.compatibility, `${JSON.stringify(input.pin, null, 2)}\n`);
    await writeFile(input.paths.previous, `${JSON.stringify(input.previous, null, 2)}\n`);
    return input.paths;
  };
  input.close = () => rm(directory, { recursive: true, force: true });
  return input;
}

test('the coherent pair passes and reports the record hash and moved members', async (t) => {
  const input = await prepare();
  t.after(input.close);
  const summary = await assertCompatibilityPin(await input.write());
  assert.equal(summary.deployment.record_sha256, byteHash(input.recordBytes));
  assert.equal(summary.deployment.run_id, input.fixture.deployment.infra.run_id);
  assert.equal(summary.deployment.run_attempt, input.fixture.deployment.infra.run_attempt);
  assert.equal(summary.deployment.artifact_id, input.pin.deployment.artifact_id);
  assert.deepEqual(summary.previous, { run_id: input.previous.deployment.run_id, run_attempt: input.previous.deployment.run_attempt });
  assert.deepEqual(summary.moved_members, ['deployment']);
});

test('each single-member pin mutation fails against the downloaded record', async () => {
  const cases = [
    ['client.sha', (pin) => { pin.client.sha = 'f'.repeat(40); }, /Deployment application sources/],
    ['service.sha', (pin) => { pin.service.sha = 'f'.repeat(40); }, /Deployment application sources/],
    ['service_artifacts.release_id', (pin) => { pin.service_artifacts.release_id += 1; }, /Selected Service release mismatch/],
    ['service_artifacts.manifest_asset_id', (pin) => { pin.service_artifacts.manifest_asset_id += 1; }, /Selected Service release mismatch/],
    ['service_artifacts.manifest_sha256', (pin) => { pin.service_artifacts.manifest_sha256 = 'b'.repeat(64); }, /Selected Service release mismatch/],
    ['infra.sha', (pin) => { pin.infra.sha = 'f'.repeat(40); }, /Infra deployment sha binding mismatch/],
    ['deployment.run_id', (pin) => { pin.deployment.run_id += 1; }, /Infra deployment run_id binding mismatch/],
    ['deployment.run_attempt', (pin) => { pin.deployment.run_attempt += 1; }, /Infra deployment run_attempt binding mismatch/],
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
  for (const record of [JSON.stringify(fixture.deployment), `${JSON.stringify(fixture.deployment, null, 4)}\n`]) {
    const input = await prepare();
    try {
      // The pin is untouched and the payload is identical: only the bytes moved.
      await input.write({ record });
      await assert.rejects(assertCompatibilityPin(input.paths), /deployment\.record_sha256/);
    } finally {
      await input.close();
    }
  }
});

test('a pin that does not move forward, or does not move at all, is refused', async () => {
  const backwards = await prepare();
  try {
    backwards.previous.deployment.run_id = backwards.pin.deployment.run_id + 1;
    await assert.rejects(assertCompatibilityPin(await backwards.write()), /deployment\.run_id/,
      'a previous pin ahead of the new pin must be refused');
  } finally {
    await backwards.close();
  }
  const sameRun = await prepare();
  try {
    // One identity member differs, so the identity-set check passes, but the
    // observation run and attempt are the ones already pinned: no forward move.
    sameRun.previous.client.sha = 'c'.repeat(40);
    sameRun.previous.deployment.run_id = sameRun.pin.deployment.run_id;
    await assert.rejects(assertCompatibilityPin(await sameRun.write()), /deployment\.run_id/,
      'an unchanged run and attempt must be refused');
  } finally {
    await sameRun.close();
  }
  const unchanged = await prepare();
  try {
    unchanged.previous = structuredClone(unchanged.pin);
    await assert.rejects(assertCompatibilityPin(await unchanged.write()), /identity members are unchanged/,
      'a no-op re-pin must be refused');
  } finally {
    await unchanged.close();
  }
});

test('deployment.artifact_id moved alone passes: the record does not carry it', async (t) => {
  const input = await prepare();
  t.after(input.close);
  // This is the documented offline hole, asserted rather than left untested.
  // `deployment.artifact_id` appears nowhere in `deployment-record.json`, so no
  // offline input constrains it; only the live binding at qualification time can
  // read the artifact from the observation run page and check it.
  input.pin.deployment.artifact_id += 1;
  const summary = await assertCompatibilityPin(await input.write());
  assert.equal(summary.deployment.artifact_id, input.pin.deployment.artifact_id);
  assert.equal(summary.deployment.record_sha256, input.pin.deployment.record_sha256);
});

test('the CLI exits 0 for a coherent pin and 1 naming the member for an unbound one', async () => {
  const passing = await prepare();
  const failing = await prepare();
  try {
    const args = (paths) => ['--deployment-record', paths.deploymentRecord,
      '--previous', paths.previous, '--compatibility', paths.compatibility];
    const ok = await execute(process.execPath, [validatorPath, ...args(await passing.write())]);
    assert.match(ok.stdout, /Compatibility pin is coherent/);
    failing.pin.infra.sha = 'f'.repeat(40);
    const failure = await execute(process.execPath, [validatorPath, ...args(await failing.write())])
      .then(() => null, (error) => error);
    assert.ok(failure, 'the CLI must fail for a pin the record does not bind');
    assert.equal(failure.code, 1);
    assert.match(failure.stderr, /Infra deployment sha binding mismatch/);
  } finally {
    await passing.close();
    await failing.close();
  }
});

test('the CLI rejects unknown, duplicated and valueless options', () => {
  assert.deepEqual(Object.keys(validatorArguments(['--deployment-record', 'record.json', '--previous', 'previous.json'])).sort(),
    ['compatibility', 'deploymentRecord', 'previous']);
  assert.equal(validatorArguments(['--deployment-record', 'record.json', '--previous', 'previous.json']).deploymentRecord, resolve('record.json'));
  assert.throws(() => validatorArguments([]), /--deployment-record is required/);
  assert.throws(() => validatorArguments(['--deployment-record', 'record.json']), /--previous is required/);
  assert.throws(() => validatorArguments(['--deployment-record', 'record.json', '--previous', 'previous.json', '--output', 'out.json']), /Unsupported argument --output/);
  assert.throws(() => validatorArguments(['--deployment-record', 'record.json', '--deployment-record', 'other.json', '--previous', 'previous.json']), /only once/);
  assert.throws(() => validatorArguments(['--deployment-record', '--previous', 'previous.json']), /--deployment-record requires a path/);
});
