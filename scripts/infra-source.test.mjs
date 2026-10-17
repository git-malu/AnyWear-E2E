import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reviewedInfraSource } from './infra-source.mjs';
import { byteHash } from './evidence-contract.mjs';
import { qualificationFixture } from './fixtures/infra-qualification.mjs';
import { pinnedInfraObserver } from './infra-observation.mjs';

async function withInfraFixture(action, additionalSources = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'anywear-infra-source-'));
  const git = args => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).trim();
  try {
    git(['init', '--quiet']); git(['config', 'user.email', 'fixture@anywear.local']); git(['config', 'user.name', 'Offline fixture']);
    git(['config', 'core.autocrlf', 'false']);
    git(['remote', 'add', 'origin', 'https://github.com/git-malu/AnyWear-Infra']);
    await mkdir(join(directory, 'scripts'));
    const filename = join(directory, 'scripts', 'observer.mjs');
    const source = 'export const authentic = true;\n';
    await writeFile(filename, source);
    for (const [name, contents] of Object.entries(additionalSources)) await writeFile(join(directory, 'scripts', name), contents);
    git(['add', 'scripts']); git(['commit', '--quiet', '-m', 'Offline fixture']);
    const fixture = qualificationFixture();
    const compatibility = fixture.compatibility;
    // The v3 observer CLI requires the expected record's producer to equal the
    // observer source SHA: E2E checks out the producer revision it observes.
    const commit = git(['rev-parse', 'HEAD']);
    compatibility.infra.sha = commit;
    compatibility.platform.producer_sha = commit;
    fixture.platformRecord.producer.sha = commit;
    for (const row of fixture.platformRecord.stacks) row.producer_sha = commit;
    fixture.bytes.platform = Buffer.from(`${JSON.stringify(fixture.platformRecord, null, 2)}\n`);
    compatibility.platform.record.record_sha256 = byteHash(fixture.bytes.platform);
    await action({ directory, git, filename, source, compatibility, fixture, env: { QUALIFICATION_INFRA_DIR: directory } });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('pinned source guard refuses subdirectories, wrong origins and hidden tracked changes', async () => {
  await withInfraFixture(async ({ directory, git, filename, source, compatibility, env }) => {
    assert.equal(reviewedInfraSource(compatibility, env), directory);
    assert.throws(() => reviewedInfraSource(compatibility, { QUALIFICATION_INFRA_DIR: join(directory, 'scripts') }), /repository root/);
    for (const flag of ['skip-worktree', 'assume-unchanged']) {
      git(['update-index', `--${flag}`, 'scripts/observer.mjs']);
      await writeFile(filename, 'export const authentic = false;\n');
      assert.equal(git(['status', '--porcelain']), '');
      assert.throws(() => reviewedInfraSource(compatibility, env), /index flags/);
      await writeFile(filename, source); git(['update-index', `--no-${flag}`, 'scripts/observer.mjs']);
    }
    git(['remote', 'set-url', 'origin', 'https://github.com/other/AnyWear-Infra']);
    assert.throws(() => reviewedInfraSource(compatibility, env), /repository/);
  });
});

const scopedReaderAssertions = `
import assert from 'node:assert/strict';
const argument = name => process.argv[process.argv.indexOf(name) + 1];
function requireObservationEnvironment(infraSha) {
  assert.equal(process.env.GITHUB_REPOSITORY, 'git-malu/AnyWear-E2E');
  assert.equal(process.env.GITHUB_WORKFLOW_REF, 'git-malu/AnyWear-E2E/.github/workflows/beta-qualification.yml@refs/heads/main');
  assert.ok(process.env.QUALIFICATION_INFRA_DIR);
  assert.equal(argument('--infra-sha'), infraSha);
  assert.equal(argument('--trusted-infra-root'), process.env.QUALIFICATION_INFRA_DIR);
}
`;

function readerEnvironment(directory) {
  return { ...process.env, GH_TOKEN: 'infra-read-fixture', SERVICE_ARTIFACT_READ_TOKEN: 'service-read-fixture',
    CLIENT_CONTENTS_READ_TOKEN: 'client-read-fixture', E2E_EVIDENCE_READ_TOKEN: 'e2e-read-fixture',
    INFRA_EVIDENCE_READ_TOKEN: 'infra-evidence-fixture', GITHUB_TOKEN: 'cleanup-write-fixture',
    GH_ENTERPRISE_TOKEN: 'other-host-fixture', GITHUB_ENTERPRISE_TOKEN: 'other-host-fixture',
    QUALIFICATION_INFRA_DIR: directory };
}

const observerFixture = `${scopedReaderAssertions}
import { readFileSync, writeFileSync } from 'node:fs';
export async function observeDeployment({ infraSha, env }) { return null; }
const platform = JSON.parse(readFileSync(argument('--expected')));
requireObservationEnvironment(platform.producer.sha);
assert.equal(platform.record_type, 'anywear_infra_deployment');
const body = { stacks: platform.stacks, inputs: platform.inputs, observed: platform.observed, schema: platform.schema };
writeFileSync(argument('--output'), JSON.stringify(body));
`;

test('pinned observer receives both producer records and no retired selection input', async () => {
  await withInfraFixture(async ({ directory, compatibility, fixture }) => {
    const output = await mkdtemp(join(tmpdir(), 'anywear-pinned-observation-'));
    const e2eSha = execFileSync('git', ['--no-replace-objects', '-C', fileURLToPath(new URL('..', import.meta.url)), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const environment = { ...readerEnvironment(directory), QUALIFICATION_INPUTS_DIR: output,
      GITHUB_REPOSITORY: 'git-malu/AnyWear-E2E', GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_REPOSITORY_ID: '1317091305', GITHUB_REPOSITORY_OWNER: 'git-malu', GITHUB_REPOSITORY_OWNER_ID: '11473072',
      GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-E2E/.github/workflows/beta-qualification.yml@refs/heads/main',
      E2E_STAGE: 'beta', ENABLE_BETA_MUTATION: 'true', E2E_OPERATION: 'full', GITHUB_SHA: e2eSha, GITHUB_WORKFLOW_SHA: e2eSha,
      GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', E2E_AWS_ACCOUNT: '650880818323',
      E2E_AWS_PRINCIPAL_ARN: 'arn:aws:sts::650880818323:assumed-role/beta-e2e-qualification-role/fixture-123',
      AWS_ACCOUNT_ID: '650880818323', AWS_REGION: 'ap-east-1', E2E_CLEANUP_SERVICE_SHA: 'b'.repeat(40) };
    try {
      await writeFile(join(output, 'platform-deployment-record.json'), fixture.bytes.platform);
      await writeFile(join(output, 'deployment-record.json'), fixture.bytes.workload);
      for (const principal of [undefined, 'arn:aws:sts::650880818323:assumed-role/beta-infra-role/fixture-123']) {
        await assert.rejects(pinnedInfraObserver(compatibility, { platform: fixture.platformRecord, workload: fixture.workloadRecord },
          { ...environment, E2E_AWS_PRINCIPAL_ARN: principal }), /dedicated E2E principal/);
        await assert.rejects(readFile(join(output, 'aws-observation.json')), { code: 'ENOENT' });
      }
      const snapshot = await pinnedInfraObserver(compatibility, { platform: fixture.platformRecord, workload: fixture.workloadRecord }, environment);
      assert.deepEqual(snapshot, { stacks: fixture.platformRecord.stacks, inputs: fixture.platformRecord.inputs,
        observed: fixture.platformRecord.observed, schema: fixture.platformRecord.schema });
      assert.deepEqual(JSON.parse(await readFile(join(output, 'aws-observation.json'))), snapshot);
      assert.equal(environment.GH_TOKEN, 'infra-read-fixture');
    } finally { await rm(output, { recursive: true, force: true }); }
  }, { 'observe-deployment.mjs': observerFixture });
});

test('pinned observer refuses a deferred producer before invoking the helper', async () => {
  const fixture = qualificationFixture({ deferred: true });
  await assert.rejects(pinnedInfraObserver(fixture.compatibility, { platform: fixture.platformRecord, workload: fixture.workloadRecord }, {}),
    /Deployment evidence deferred/);
});

test('pinned source guard evaluates the original commit despite Git replacement objects', async () => {
  await withInfraFixture(async ({ git, filename, compatibility, env }) => {
    const original = compatibility.infra.sha;
    await writeFile(filename, 'export const authentic = false;\n');
    git(['add', 'scripts/observer.mjs']); git(['commit', '--quiet', '-m', 'Replacement fixture']);
    const replacement = git(['rev-parse', 'HEAD']);
    git(['reset', '--soft', original]); git(['replace', original, replacement]);
    assert.equal(git(['status', '--porcelain']), '');
    assert.throws(() => reviewedInfraSource(compatibility, env), /replacement refs/);
  });
});
