import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reviewedInfraSource } from './infra-source.mjs';
import { qualificationFixture } from './fixtures/infra-qualification.mjs';

async function withInfraFixture(action) {
  const directory = await mkdtemp(join(tmpdir(), 'anywear-infra-source-'));
  const git = args => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).trim();
  try {
    git(['init', '--quiet']); git(['config', 'user.email', 'fixture@anywear.local']); git(['config', 'user.name', 'Offline fixture']);
    git(['config', 'core.autocrlf', 'false']);
    git(['remote', 'add', 'origin', 'https://github.com/git-malu/AnyWear-Infra']);
    await mkdir(join(directory, 'scripts'));
    const filename = join(directory, 'scripts', 'observer.mjs');
    const source = 'export const authentic = true;\n';
    await writeFile(filename, source); git(['add', 'scripts/observer.mjs']); git(['commit', '--quiet', '-m', 'Offline fixture']);
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
