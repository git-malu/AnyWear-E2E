import assert from 'node:assert/strict';
import test from 'node:test';
import { isTerminalTaggingStatus } from '../tests/support/wardrobe-lifecycle.ts';

test('only completed auto-tagging states permit fixture cleanup', () => {
  for (const status of ['uploading', 'processing', 'retry', 'unknown']) {
    assert.equal(isTerminalTaggingStatus(status), false, `${status} must be retained for recovery`);
  }
  assert.equal(isTerminalTaggingStatus('ready'), true);
  assert.equal(isTerminalTaggingStatus('failed'), true);
});
