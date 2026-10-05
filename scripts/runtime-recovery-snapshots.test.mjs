import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { MAX_RECOVERY_SNAPSHOTS, validateRecoverySnapshot, validateRecoverySourceInputs } from './runtime-recovery-snapshots.mjs';
import { validateRecoveryArtifactBinding } from './runtime-recovery-artifact.mjs';

test('snapshot input uses one bounded immutable three-digit contract', () => {
  assert.equal(MAX_RECOVERY_SNAPSHOTS, 400);
  assert.ok(MAX_RECOVERY_SNAPSHOTS + 1 < 500);
  for (const value of ['001', '150', '197', '202', '399', '400']) assert.equal(validateRecoverySnapshot(value), value);
  for (const value of [undefined, 400, '', '000', '401', '999', '1000', '40', '+400', '4e2', '400 ', ' 400']) {
    assert.throws(() => validateRecoverySnapshot(value), /Invalid bounded recovery snapshot/);
  }
  const input = { SOURCE_RUN_ID: '123', SOURCE_RUN_ATTEMPT: '1', SOURCE_SNAPSHOT: '400' };
  assert.doesNotThrow(() => validateRecoverySourceInputs(input));
  for (const values of [{ SOURCE_RUN_ID: '0' }, { SOURCE_RUN_ID: '1'.repeat(21) },
    { SOURCE_RUN_ATTEMPT: '0' }, { SOURCE_RUN_ATTEMPT: '1'.repeat(7) }, { SOURCE_SNAPSHOT: '401' }]) {
    assert.throws(() => validateRecoverySourceInputs({ ...input, ...values }));
  }
});

test('artifact binding accepts the new final boundary without weakening protected run metadata', () => {
  const record = { run_scope: '123-1-aaaaaaaaaaaaaaaa', deployment: { service: { source_commit: 'b'.repeat(40) } } };
  const metadata = { id: 123, run_attempt: 1, path: '.github/workflows/runtime-drill.yml', event: 'workflow_dispatch',
    head_branch: 'main', head_sha: 'a'.repeat(40), repository: { full_name: 'git-malu/AnyWear-E2E' } };
  const input = { SOURCE_RUN_ID: '123', SOURCE_RUN_ATTEMPT: '1', SOURCE_SNAPSHOT: '400', ORIGINAL_RUN_SCOPE: record.run_scope };
  const compatibility = { service: { sha: 'b'.repeat(40) } };
  assert.equal(validateRecoveryArtifactBinding(metadata, record, input, compatibility), record);
  assert.throws(() => validateRecoveryArtifactBinding(metadata, record, { ...input, SOURCE_SNAPSHOT: '401' }, compatibility), /bounded recovery snapshot/);
  assert.throws(() => validateRecoveryArtifactBinding({ ...metadata, run_attempt: 2 }, record, input, compatibility), /exact protected/);
});

test('workflow validates the shared snapshot module before repository token or AWS credentials', async () => {
  const workflow = await readFile(new URL('../.github/workflows/runtime-recovery.yml', import.meta.url), 'utf8');
  const validation = workflow.indexOf('node scripts/runtime-recovery-snapshots.mjs');
  assert.ok(validation > 0 && validation < workflow.indexOf('actions/create-github-app-token'));
  assert.ok(validation < workflow.indexOf('aws-actions/configure-aws-credentials'));
  assert.ok(workflow.includes(`(001 to ${MAX_RECOVERY_SNAPSHOTS})`));
  const inputs = { SOURCE_RUN_ID: '123', SOURCE_RUN_ATTEMPT: '1', SOURCE_SNAPSHOT: '400' };
  const run = (env) => spawnSync(process.execPath, ['scripts/runtime-recovery-snapshots.mjs'], { env, encoding: 'utf8' });
  assert.equal(run(inputs).status, 0);
  const rejected = run({ ...inputs, SOURCE_SNAPSHOT: '401' });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /Invalid bounded recovery snapshot/);
});

test('drill and recovery workflows leave artifact room for their single final upload', async () => {
  for (const name of ['runtime-drill', 'runtime-recovery']) {
    const workflow = await readFile(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8');
    const finalUploads = [...workflow.matchAll(/uses: actions\/upload-artifact@v4/g)].length;
    assert.equal(finalUploads, 1);
    assert.equal(MAX_RECOVERY_SNAPSHOTS + finalUploads, 401);
    assert.ok(MAX_RECOVERY_SNAPSHOTS + finalUploads < 500);
  }
});
