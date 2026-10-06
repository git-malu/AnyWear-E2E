import assert from 'node:assert/strict';
import test from 'node:test';
import { createOwnedRuntimeIo } from './beta-runtime-adapter.mjs';

test('recovery-only snapshot mode writes the recovery file without uploading intermediate artifacts', async () => {
  const uploads = [];
  const writes = [];
  const environment = { GITHUB_ACTIONS: 'true', RUNTIME_RECOVERY_SKIP_SNAPSHOT_UPLOAD: 'true', RUNTIME_DRILL_RECOVERY_PATH: 'recovery.json' };
  const io = createOwnedRuntimeIo({
    aws: async () => ({}), fetch: async () => ({}), sleep: async () => {}, cognitoSend: async () => ({}), close: async () => {},
    writeRecoveryFile: async (...args) => writes.push(args), uploadRecoveryArtifact: async (...args) => uploads.push(args),
  }, async () => ({}), environment);
  await io.saveRecovery({ runScope: 'scope', marker: 'beta-runtime-test', userPoolId: 'pool', config: { serviceUrl: 'https://service.example' } });
  assert.equal(writes.length, 1);
  assert.equal(uploads.length, 0);
});
