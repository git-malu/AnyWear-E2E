import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reviewedInfraSource } from './infra-source.mjs';
import { qualificationFixture } from './fixtures/infra-qualification.mjs';
import { verifyPinnedPublication } from './trusted-deployment-inputs.mjs';
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
    const compatibility = qualificationFixture().compatibility; compatibility.infra.sha = git(['rev-parse', 'HEAD']);
    await action({ directory, git, filename, source, compatibility, env: { QUALIFICATION_INFRA_DIR: directory } });
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
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const argument = name => process.argv[process.argv.indexOf(name) + 1];
function requireScopedReader() {
  assert.equal(process.env.GH_TOKEN, 'service-read-fixture');
  for (const name of ['GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN',
    'SERVICE_ARTIFACT_READ_TOKEN', 'CLIENT_CONTENTS_READ_TOKEN']) assert.equal(process.env[name], undefined);
  assert.equal(argument('--trusted-infra-root'), process.env.QUALIFICATION_INFRA_DIR);
  if (process.env.TEST_NATIVE_PERMISSION_DENIED === 'true') throw new Error('Native release verification denied');
}
`;

function readerEnvironment(directory) {
  return { ...process.env, GH_TOKEN: 'infra-read-fixture', SERVICE_ARTIFACT_READ_TOKEN: 'service-read-fixture',
    CLIENT_CONTENTS_READ_TOKEN: 'client-read-fixture', GITHUB_TOKEN: 'cleanup-write-fixture',
    GH_ENTERPRISE_TOKEN: 'other-host-fixture', GITHUB_ENTERPRISE_TOKEN: 'other-host-fixture',
    QUALIFICATION_INFRA_DIR: directory };
}

test('pinned publication CLI receives only its Service reader and native denial cannot accept inputs', async () => {
  const consumer = `${scopedReaderAssertions}
requireScopedReader();
const selector = JSON.parse(readFileSync(argument('--selection')));
const output = argument('--output-dir'); mkdirSync(output, { recursive: true });
writeFileSync(join(output, 'service-artifacts.json'), JSON.stringify({ release: selector.release }));
`;
  await withInfraFixture(async ({ directory, compatibility }) => {
    const output = await mkdtemp(join(tmpdir(), 'anywear-pinned-publication-'));
    const environment = readerEnvironment(directory);
    const selector = { release: compatibility.service_artifacts };
    try {
      const result = await verifyPinnedPublication(compatibility, selector, output, environment);
      assert.deepEqual(result.manifest.release, selector.release);
      assert.equal(environment.GH_TOKEN, 'infra-read-fixture');
      assert.equal(environment.GITHUB_TOKEN, 'cleanup-write-fixture');
      await assert.rejects(verifyPinnedPublication(compatibility, selector, output,
        { ...environment, TEST_NATIVE_PERMISSION_DENIED: 'true' }), /Native release verification denied/);
      delete environment.SERVICE_ARTIFACT_READ_TOKEN;
      await assert.rejects(verifyPinnedPublication(compatibility, selector, output, environment), /SERVICE_ARTIFACT_READ_TOKEN/);
    } finally { await rm(output, { recursive: true, force: true }); }
  }, { 'artifact-consumer.mjs': consumer });
});

test('pinned observer scopes all inherited native release calls to the Service reader', async () => {
  const observer = `${scopedReaderAssertions}
export function validateDeploymentRecord(record) { return record; }
export function assertObservedMatchesDeployment(record, snapshot) {
  assert.equal(snapshot.schema.verification.service_sha, record.observed.service_sha);
}
if (process.argv.includes('--expected')) {
  requireScopedReader();
  const record = JSON.parse(readFileSync(argument('--expected')));
  const snapshot = { schema: { verification: { source_repository: 'git-malu/AnyWear-Infra',
    source_sha: record.infra.sha, image_digest: record.observed.image_digest, service_sha: record.observed.service_sha,
    executor: { repository: process.env.GITHUB_REPOSITORY, sha: process.env.GITHUB_SHA,
      workflow_path: '.github/workflows/beta-qualification.yml', run_id: Number(process.env.GITHUB_RUN_ID),
      run_attempt: Number(process.env.GITHUB_RUN_ATTEMPT) } } } };
  writeFileSync(argument('--output'), JSON.stringify(snapshot));
}
`;
  await withInfraFixture(async ({ directory, compatibility }) => {
    const output = await mkdtemp(join(tmpdir(), 'anywear-pinned-observation-'));
    const record = qualificationFixture().deployment; record.infra.sha = compatibility.infra.sha;
    const sha = 'd'.repeat(40);
    const environment = { ...readerEnvironment(directory), QUALIFICATION_INPUTS_DIR: output,
      GITHUB_REPOSITORY: 'git-malu/AnyWear-E2E', GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-E2E/.github/workflows/beta-qualification.yml@refs/heads/main',
      E2E_STAGE: 'beta', ENABLE_INFRA_E2E: 'true', GITHUB_SHA: sha, E2E_WRITER_SHA: sha,
      GITHUB_RUN_ID: '123', E2E_WRITER_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', E2E_WRITER_RUN_ATTEMPT: '1',
      E2E_WRITER_WINDOW_TOKEN: 'test-window', E2E_EXPECTED_WRITER_WINDOW_TOKEN: 'test-window',
      E2E_WRITER_EXPIRES_AT: '2099-01-01T00:00:00Z',
      E2E_WRITER_RECORD_URL: 'https://github.com/git-malu/AnyWear/issues/54#issuecomment-1',
      AWS_ACCOUNT_ID: '650880818323', AWS_REGION: 'ap-east-1', E2E_CLEANUP_SERVICE_SHA: 'b'.repeat(40) };
    try {
      await writeFile(join(output, 'deployment-record.json'), JSON.stringify(record));
      const snapshot = await pinnedInfraObserver(compatibility, record, environment);
      assert.equal(snapshot.schema.verification.source_sha, compatibility.infra.sha);
      assert.deepEqual(JSON.parse(await readFile(join(output, 'aws-observation.json'))), snapshot);
      assert.equal(environment.GH_TOKEN, 'infra-read-fixture');
      delete environment.SERVICE_ARTIFACT_READ_TOKEN;
      await assert.rejects(pinnedInfraObserver(compatibility, record, environment), /SERVICE_ARTIFACT_READ_TOKEN/);
    } finally { await rm(output, { recursive: true, force: true }); }
  }, { 'observe-deployment.mjs': observer });
});

test('pinned source guard evaluates the original commit despite Git replacement objects', async () => {
  await withInfraFixture(async ({ git, filename, compatibility, env }) => {
    const original = compatibility.infra.sha;
    await writeFile(filename, 'export const authentic = false;\n');
    git(['add', 'scripts/observer.mjs']); git(['commit', '--quiet', '-m', 'Replacement fixture']);
    const replacement = git(['rev-parse', 'HEAD']);
    git(['reset', '--soft', original]); git(['replace', original, replacement]);
    assert.equal(git(['status', '--porcelain']), '');
    assert.throws(() => reviewedInfraSource(compatibility, env), /local changes/);
  });
});
