import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_RECOVERY_SNAPSHOTS, validateRecoveryArtifactName, validateRecoverySnapshot, validateRecoverySourceInputs } from './runtime-recovery-snapshots.mjs';
import { validateRecoveryArtifactBinding } from './runtime-recovery-artifact.mjs';

test('snapshot input uses one bounded immutable three-digit contract', () => {
  assert.equal(MAX_RECOVERY_SNAPSHOTS, 400);
  assert.ok(MAX_RECOVERY_SNAPSHOTS + 1 < 500);
  for (const value of ['001', '150', '197', '202', '399', '400']) assert.equal(validateRecoverySnapshot(value), value);
  for (const value of [undefined, 400, '', '000', '401', '999', '1000', '40', '+400', '4e2', '400 ', ' 400']) {
    assert.throws(() => validateRecoverySnapshot(value), /Invalid bounded recovery snapshot/);
  }
  assert.equal(validateRecoveryArtifactName(''), '');
  assert.equal(validateRecoveryArtifactName('beta-runtime-recovery-outcome-37551424976-1'), 'beta-runtime-recovery-outcome-37551424976-1');
  for (const value of ['beta-runtime-recovery-123-1-001', 'beta-runtime-recovery-outcome-0-1',
    'beta-runtime-recovery-outcome-123-0', 'beta-runtime-recovery-outcome-123-1-extra', 'outcome']) {
    assert.throws(() => validateRecoveryArtifactName(value), /retained recovery outcome artifact/);
  }
  const input = { SOURCE_RUN_ID: '123', SOURCE_RUN_ATTEMPT: '1', SOURCE_SNAPSHOT: '400', SOURCE_ARTIFACT_NAME: '' };
  assert.doesNotThrow(() => validateRecoverySourceInputs(input));
  assert.doesNotThrow(() => validateRecoverySourceInputs({ ...input, SOURCE_ARTIFACT_NAME: 'beta-runtime-recovery-outcome-123-1' }));
  for (const values of [{ SOURCE_RUN_ID: '0' }, { SOURCE_RUN_ID: '1'.repeat(21) },
    { SOURCE_RUN_ATTEMPT: '0' }, { SOURCE_RUN_ATTEMPT: '1'.repeat(7) }, { SOURCE_SNAPSHOT: '401' }]) {
    assert.throws(() => validateRecoverySourceInputs({ ...input, ...values }));
  }
});

test('historical artifact binding retains protected run metadata checks', () => {
  const record = { run_scope: '123-1-aaaaaaaaaaaaaaaa', deployment: { service: { source_commit: 'b'.repeat(40) } } };
  const metadata = { id: 123, run_attempt: 1, path: '.github/workflows/runtime-drill.yml', event: 'workflow_dispatch',
    head_branch: 'main', head_sha: 'a'.repeat(40), status: 'completed', repository: { full_name: 'git-malu/AnyWear-E2E' } };
  const input = { SOURCE_RUN_ID: '123', SOURCE_RUN_ATTEMPT: '1', SOURCE_SNAPSHOT: '400', SOURCE_ARTIFACT_NAME: '', ORIGINAL_RUN_SCOPE: record.run_scope };
  const compatibility = { service: { sha: 'b'.repeat(40) } };
  assert.equal(validateRecoveryArtifactBinding(metadata, record, input, compatibility), record);
  assert.throws(() => validateRecoveryArtifactBinding(metadata, record, { ...input, SOURCE_SNAPSHOT: '401' }, compatibility), /bounded recovery snapshot/);
  assert.throws(() => validateRecoveryArtifactBinding({ ...metadata, run_attempt: 2 }, record, input, compatibility), /exact protected/);
  const retainedInput = { ...input, SOURCE_ARTIFACT_NAME: 'beta-runtime-recovery-outcome-123-1' };
  const retainedMetadata = { ...metadata, path: '.github/workflows/runtime-recovery.yml' };
  assert.equal(validateRecoveryArtifactBinding(retainedMetadata, record, retainedInput, compatibility), record);
  assert.throws(() => validateRecoveryArtifactBinding({ ...retainedMetadata, id: 124 }, record, retainedInput, compatibility), /exact protected/);
  assert.throws(() => validateRecoveryArtifactBinding({ ...retainedMetadata, path: '.github/workflows/runtime-drill.yml' }, record, retainedInput, compatibility), /Retained recovery outcome/);
});
