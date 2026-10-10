import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertSizingCompatibilityEqual, assertSizingSourceRun, captureSizingSource, reconstructSizingSource,
  validateSizingSource, verifySizingSourceAtCommit } from './beta-sizing-source.mjs';
import { qualificationFixture } from './fixtures/infra-qualification.mjs';
import { sizingSourceFixture } from './fixtures/beta-sizing-source.mjs';
import { byteHash, canonicalJson } from './evidence-contract.mjs';

function environment(sha) {
  return { GITHUB_REPOSITORY: 'git-malu/AnyWear-E2E', GITHUB_REPOSITORY_ID: '1317091305',
    GITHUB_REPOSITORY_OWNER: 'git-malu', GITHUB_REPOSITORY_OWNER_ID: '11473072',
    GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch', E2E_STAGE: 'beta',
    ENABLE_INFRA_E2E: 'true', GITHUB_SHA: sha, GITHUB_WORKFLOW_SHA: sha,
    GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-E2E/.github/workflows/beta-qualification.yml@refs/heads/main',
    GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', AWS_ACCOUNT_ID: '650880818323', AWS_REGION: 'ap-east-1',
    E2E_CLEANUP_SERVICE_SHA: 'b'.repeat(40), E2E_AWS_ACCOUNT: '650880818323',
    E2E_AWS_PRINCIPAL_ARN: 'arn:aws:sts::650880818323:assumed-role/beta-e2e-qualification-role/test-123' };
}

async function withRepository(action) {
  const directory = await mkdtemp(join(tmpdir(), 'anywear-sizing-source-'));
  const git = args => execFileSync('git', ['--no-replace-objects', '-C', directory, ...args], { encoding: 'utf8' }).trim();
  try {
    git(['init', '--quiet']); git(['config', 'user.email', 'fixture@anywear.local']); git(['config', 'user.name', 'Sizing source fixture']);
    git(['config', 'core.autocrlf', 'false']); git(['remote', 'add', 'origin', 'https://github.com/git-malu/AnyWear-E2E']);
    const compatibility = qualificationFixture().compatibility;
    await mkdir(join(directory, 'scripts')); await mkdir(join(directory, 'tests')); await mkdir(join(directory, '.github', 'workflows'), { recursive: true });
    await writeFile(join(directory, 'compatibility.json'), `${JSON.stringify(compatibility, null, 2)}\n`);
    await writeFile(join(directory, 'scripts', 'workload.mjs'), 'export const workload = true;\n');
    await writeFile(join(directory, 'tests', 'fixture.bin'), Buffer.from([0, 1, 2]));
    await writeFile(join(directory, '.github', 'workflows', 'beta-qualification.yml'), 'name: Source fixture\n');
    await writeFile(join(directory, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    await writeFile(join(directory, '.gitignore'), 'generated/\n');
    git(['add', '.']); git(['commit', '--quiet', '-m', 'Frozen workload fixture']);
    await action({ directory, git, compatibility, sha: git(['rev-parse', 'HEAD']) });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('complete protected source proof permits only committed compatibility-record changes', async () => {
  await withRepository(async ({ directory, git, compatibility, sha }) => {
    const first = captureSizingSource(environment(sha), { root: directory });
    assert.equal(verifySizingSourceAtCommit(first, { root: directory, expectedSha: sha }), true);
    Object.assign(compatibility.deployment, { run_id: 31, run_attempt: 1, artifact_id: 41, record_sha256: 'f'.repeat(64) });
    await writeFile(join(directory, 'compatibility.json'), `${JSON.stringify(compatibility, null, 2)}\n`);
    assert.throws(() => captureSizingSource(environment(sha), { root: directory }), /local changes/);
    git(['add', 'compatibility.json']); git(['commit', '--quiet', '-m', 'New deployment record only']);
    const next = git(['rev-parse', 'HEAD']);
    const second = captureSizingSource(environment(next), { root: directory });
    assert.notEqual(second.e2e_sha, first.e2e_sha);
    assert.notEqual(second.tree_sha, first.tree_sha);
    assert.equal(second.benchmark_source_sha256, first.benchmark_source_sha256);
    assert.equal(assertSizingCompatibilityEqual(second.compatibility, first.compatibility), true);
    assert.equal(verifySizingSourceAtCommit(first, { root: directory, expectedSha: sha }), true);
    assert.throws(() => verifySizingSourceAtCommit(second, { root: directory, expectedSha: sha }), /run\/source/);
    const invented = structuredClone(first); invented.inventory.pop();
    assert.throws(() => verifySizingSourceAtCommit(invented, { root: directory, expectedSha: sha }), /inventory/);
    invented.benchmark_source_sha256 = byteHash(canonicalJson(invented.inventory.filter(entry =>
      Buffer.from(entry.path_base64, 'base64').toString() !== 'compatibility.json')));
    assert.equal(validateSizingSource(invented, { e2eSha: sha, runId: first.run_id, runAttempt: first.run_attempt }), true);
    assert.throws(() => verifySizingSourceAtCommit(invented, { root: directory, expectedSha: sha }), /Trusted actual/);
  });
});

test('every tracked workload, workflow, fixture, lock and file mode affects the source digest', async () => {
  await withRepository(async ({ directory, git, sha }) => {
    let prior = reconstructSizingSource(directory, sha);
    for (const file of ['scripts/workload.mjs', '.github/workflows/beta-qualification.yml', 'tests/fixture.bin', 'pnpm-lock.yaml']) {
      await writeFile(join(directory, file), `changed ${file}\n`);
      git(['add', file]); git(['commit', '--quiet', '-m', `Change ${file}`]);
      const next = reconstructSizingSource(directory, git(['rev-parse', 'HEAD']));
      assert.notEqual(next.benchmark_source_sha256, prior.benchmark_source_sha256);
      prior = next;
    }
    git(['update-index', '--chmod=+x', 'scripts/workload.mjs']); git(['commit', '--quiet', '-m', 'Executable mode']);
    const next = reconstructSizingSource(directory, git(['rev-parse', 'HEAD']));
    assert.notEqual(next.benchmark_source_sha256, prior.benchmark_source_sha256);
    assert.equal(next.inventory.find(entry => Buffer.from(entry.path_base64, 'base64').toString() === 'scripts/workload.mjs').mode, '100755');
  });
});

test('clean actual source refuses dirty/index-hidden/untracked/replaced/foreign source and run identities', async () => {
  await withRepository(async ({ directory, git, sha }) => {
    const env = environment(sha);
    for (const patch of [{ GITHUB_SHA: 'c'.repeat(40) }, { GITHUB_WORKFLOW_SHA: 'c'.repeat(40) },
      { GITHUB_RUN_ATTEMPT: '0' }, { GITHUB_REF: 'refs/heads/other' },
      { GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-E2E/.github/workflows/integration.yml@refs/heads/main' }]) {
      assert.throws(() => captureSizingSource({ ...env, ...patch }, { root: directory }));
    }
    assert.throws(() => captureSizingSource(env, { root: join(directory, 'scripts') }), /repository root/);
    for (const flag of ['skip-worktree', 'assume-unchanged']) {
      git(['update-index', `--${flag}`, 'scripts/workload.mjs']);
      assert.throws(() => captureSizingSource(env, { root: directory }), /index flags/);
      git(['update-index', `--no-${flag}`, 'scripts/workload.mjs']);
    }
    await writeFile(join(directory, 'untracked.mjs'), 'untracked');
    assert.throws(() => captureSizingSource(env, { root: directory }), /local changes/);
    await rm(join(directory, 'untracked.mjs'));
    await mkdir(join(directory, 'generated')); await writeFile(join(directory, 'generated', 'report.json'), '{}');
    assert.equal(captureSizingSource(env, { root: directory }).e2e_sha, sha);
    git(['remote', 'set-url', 'origin', 'https://github.com/other/AnyWear-E2E']);
    assert.throws(() => captureSizingSource(env, { root: directory }), /origin/);
    git(['remote', 'set-url', 'origin', 'https://github.com/git-malu/AnyWear-E2E']);
    await writeFile(join(directory, 'scripts', 'workload.mjs'), 'replacement');
    git(['add', '.']); git(['commit', '--quiet', '-m', 'Replacement']);
    git(['replace', sha, git(['rev-parse', 'HEAD'])]);
    assert.throws(() => reconstructSizingSource(directory, sha), /replacement refs/);
  });
});

test('complete source inventory preserves pinned gitlinks and requires clean initialized submodules', async () => {
  await withRepository(async ({ directory, git }) => {
    const child = join(directory, 'child'); await mkdir(child);
    const childGit = args => execFileSync('git', ['-C', child, ...args], { encoding: 'utf8' }).trim();
    childGit(['init', '--quiet']); childGit(['config', 'user.email', 'fixture@anywear.local']); childGit(['config', 'user.name', 'Child fixture']);
    await writeFile(join(child, 'source.mjs'), 'export const child = true;\n');
    childGit(['add', '.']); childGit(['commit', '--quiet', '-m', 'Child']);
    const pin = childGit(['rev-parse', 'HEAD']);
    await writeFile(join(directory, '.gitmodules'), '[submodule "child"]\n\tpath = child\n\turl = https://github.com/git-malu/api\n');
    git(['add', '.gitmodules']); git(['update-index', '--add', '--cacheinfo', `160000,${pin},child`]); git(['commit', '--quiet', '-m', 'Pinned child']);
    const sha = git(['rev-parse', 'HEAD']);
    const proof = captureSizingSource(environment(sha), { root: directory });
    assert.equal(proof.inventory.find(entry => entry.type === 'commit').object, pin);
    await writeFile(join(child, 'source.mjs'), 'changed');
    assert.throws(() => captureSizingSource(environment(sha), { root: directory }), /local changes/);
    childGit(['add', '.']); childGit(['commit', '--quiet', '-m', 'New child']);
    assert.throws(() => captureSizingSource(environment(sha), { root: directory }), /local changes|protected source/);
    const nextPin = childGit(['rev-parse', 'HEAD']);
    git(['update-index', '--cacheinfo', `160000,${nextPin},child`]); git(['commit', '--quiet', '-m', 'New child pin']);
    const next = captureSizingSource(environment(git(['rev-parse', 'HEAD'])), { root: directory });
    assert.notEqual(next.benchmark_source_sha256, proof.benchmark_source_sha256);
    childGit(['update-index', '--skip-worktree', 'source.mjs']);
    assert.throws(() => captureSizingSource(environment(next.e2e_sha), { root: directory }), /index flags/);
    childGit(['update-index', '--no-skip-worktree', 'source.mjs']);
    await rm(child, { recursive: true, force: true }); await mkdir(child);
    assert.throws(() => captureSizingSource(environment(next.e2e_sha), { root: directory }));
  });
});

test('proof rejects missing/malformed inventories, invented run/source and compatibility content', () => {
  const proof = sizingSourceFixture();
  const binding = { e2eSha: proof.e2e_sha, runId: proof.run_id, runAttempt: proof.run_attempt };
  assert.equal(validateSizingSource(proof, binding), true);
  for (const mutate of [value => { value.e2e_sha = 'c'.repeat(40); }, value => { value.run_id = '2'; },
    value => { value.run_attempt = '2'; }, value => { value.inventory.reverse(); },
    value => { value.inventory.push(value.inventory[1]); }, value => { value.inventory[1].mode = '160000'; },
    value => { value.inventory[1].path_base64 = 'YQ==junk'; }, value => { value.compatibility_blob = 'd'.repeat(40); },
    value => { value.compatibility.service.sha = 'd'.repeat(40); }, value => { value.compatibility_bytes_base64 = 'e30='; },
    value => { value.excluded = ['scripts']; }]) {
    const value = structuredClone(proof); mutate(value);
    assert.throws(() => validateSizingSource(value, binding));
  }
});

test('strict comparison allows no compatibility changes outside four deployment record fields', () => {
  const original = qualificationFixture().compatibility;
  const candidate = structuredClone(original);
  Object.assign(candidate.deployment, { run_id: 31, run_attempt: 1, artifact_id: 41, record_sha256: 'e'.repeat(64) });
  assert.equal(assertSizingCompatibilityEqual(candidate, original), true);
  for (const mutate of [value => { value.client.sha = 'c'.repeat(40); }, value => { value.service.sha = 'c'.repeat(40); },
    value => { value.infra.sha = 'c'.repeat(40); }, value => { value.service_artifacts.release_id++; },
    value => { value.service_artifacts.manifest_asset_id++; }, value => { value.service_artifacts.manifest_sha256 = 'c'.repeat(64); },
    value => { value.deployment.workflow_path = '.github/workflows/other.yml'; }, value => { value.deployment.extra = true; },
    value => { value.client.repository = 'git-malu/other'; }, value => { value.version = 1; }]) {
    const value = structuredClone(candidate); mutate(value);
    assert.throws(() => assertSizingCompatibilityEqual(value, original));
  }
});

test('source self-hash never replaces native completed-success run/workflow/main/source/attempt authentication', () => {
  const proof = sizingSourceFixture();
  const run = { repository: { full_name: 'git-malu/AnyWear-E2E' }, path: '.github/workflows/beta-qualification.yml',
    head_branch: 'main', event: 'workflow_dispatch', status: 'completed', conclusion: 'success',
    head_sha: proof.e2e_sha, id: 1, run_attempt: 1 };
  assert.equal(assertSizingSourceRun(proof, run), true);
  for (const patch of [undefined, { head_sha: 'c'.repeat(40) }, { id: 2 }, { run_attempt: 2 },
    { conclusion: 'failure' }, { status: 'in_progress' }, { event: 'push' }, { head_branch: 'other' },
    { path: '.github/workflows/integration.yml' }, { repository: { full_name: 'other/AnyWear-E2E' } }]) {
    assert.throws(() => assertSizingSourceRun(proof, patch ? { ...run, ...patch } : patch), /Native completed-success/);
  }
});
