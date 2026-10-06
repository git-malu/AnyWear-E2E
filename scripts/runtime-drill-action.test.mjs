import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runRuntimeDrill } from '../.github/actions/runtime-drill-executor/index.mjs';

test('protected workflow executes the drill through a Node action with artifact runtime context', async () => {
  const [workflow, action] = await Promise.all([
    readFile(new URL('../.github/workflows/runtime-drill.yml', import.meta.url), 'utf8'),
    readFile(new URL('../.github/actions/runtime-drill-executor/action.yml', import.meta.url), 'utf8'),
  ]);
  assert.match(workflow, /name: Execute reviewed runtime adapter\r?\n\s+uses: \.\/\.github\/actions\/runtime-drill-executor/);
  assert.doesNotMatch(workflow, /pnpm exec node scripts\/runtime-drill\.mjs --execute/);
  assert.match(action, /using: node24/);
  assert.match(action, /main: index\.mjs/);
});

test('runtime action inherits artifact credentials and preserves the drill exit status', async () => {
  const env = { ACTIONS_RUNTIME_TOKEN: 'runtime-token', ACTIONS_RUNTIME_URL: 'https://artifact.invalid' };
  let invocation;
  const child = new EventEmitter();
  const completed = runRuntimeDrill({ env, spawnProcess: (...args) => { invocation = args; return child; } });
  assert.equal(invocation[1].join(' '), 'scripts/runtime-drill.mjs --execute');
  assert.equal(invocation[2].env, env);
  assert.equal(invocation[2].stdio, 'inherit');
  child.emit('close', 0, null);
  await completed;

  const failed = runRuntimeDrill({ env, spawnProcess: () => {
    const processHandle = new EventEmitter();
    queueMicrotask(() => processHandle.emit('close', 1, null));
    return processHandle;
  } });
  await assert.rejects(failed, /Runtime drill exited with code 1/);
});
