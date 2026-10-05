import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createOneShotRunner } from './runtime-one-shot-runner.mjs';

const scope = { runScope: '123-1-aaaaaaaaaaaaaaaa', deployment: { service: { source_commit: 'b'.repeat(40), image_digest: `sha256:${'c'.repeat(64)}` } } };
const definition = 'arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-lifecycle:1';
const task = 'arn:aws:ecs:ap-east-1:650880818323:task/beta-anywear/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const checkpoint = (phase, arn) => `runtime-checkpoint-v1:${scope.runScope}:${phase}:${arn}`;
const defLines = `Task definition: ${definition}\nRuntime checkpoint: ${checkpoint('definition', definition)}\n`;
const taskLines = `Task ARN: ${task}\nRuntime checkpoint: ${checkpoint('task', task)}\n`;
const flush = () => new Promise((resolve) => setImmediate(resolve));

function harness({ deadlineMs = 1000, onLine = async () => {}, execute, pendingAck = false, terminate } = {}) {
  const child = new EventEmitter();
  const writes = [];
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdin = new Writable({ write(chunk, _encoding, done) { writes.push(chunk.toString()); if (!pendingAck) done(); } });
  let killed = 0;
  let spawned = 0;
  const consumed = [];
  const runner = createOneShotRunner({ E2E_SERVICE_CHECKOUT: '.', TEST_NONSECRET: 'value' }, { deadlineMs,
    execute: execute ?? (async (command) => ({ stdout: command === 'git' ? `${scope.deployment.service.source_commit}\n` : 'v1\n' })),
    spawnProcess(command, args, options) {
      assert.equal(command, 'bash'); assert.equal(args[1], 'beta');
      assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe']);
      assert.equal(options.env.RUNTIME_DRILL_CHECKPOINT_PROTOCOL, 'v1');
      assert.equal(options.env.RUNTIME_DRILL_RUN_SCOPE, scope.runScope);
      spawned++; return child;
    }, terminate() { killed++; return terminate?.(); },
  });
  const result = runner({ scope, purpose: 'lifecycle', action: 'close', payload: '', onLine: async (line) => {
    consumed.push(line); await onLine(line);
  } });
  return { child, writes, result, consumed, killed: () => killed, spawned: () => spawned };
}

test('ACKs exact metadata only after awaited durable callback, handling fragmented CRLF and coalesced output', async () => {
  let release;
  const durable = new Promise((resolve) => { release = resolve; });
  const h = harness({ onLine: async (line) => { if (line.startsWith('Task definition: ')) await durable; } });
  await flush();
  h.child.stdout.write(defLines.slice(0, 17));
  h.child.stdout.write(defLines.slice(17).replaceAll('\n', '\r\n'));
  await flush();
  assert.deepEqual(h.writes, []);
  release(); await flush();
  assert.deepEqual(h.writes, [`${checkpoint('definition', definition)}\n`]);
  h.child.stdout.write(taskLines);
  await flush(); h.child.emit('close', 0);
  assert.ok((await h.result).stdout.includes(task));
  assert.deepEqual(h.writes, [`${checkpoint('definition', definition)}\n`, `${checkpoint('task', task)}\n`]);
  assert.equal(h.killed(), 0);
});

test('durable callback failure latches before every later callback and ACK even in one coalesced chunk', async () => {
  const h = harness({ onLine: async () => { throw new Error('durable upload failed'); } });
  await flush();
  h.child.stdout.write(defLines + taskLines);
  await assert.rejects(h.result, /durable upload failed/);
  await flush();
  assert.equal(h.consumed.length, 1);
  assert.deepEqual(h.writes, []);
  assert.equal(h.killed(), 1);
});

test('deadline rejects independently while child never closes, after close with pending persistence, and during pending ACK', async () => {
  for (const boundary of ['running', 'after-close', 'ack', 'probe']) {
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    const h = harness({ deadlineMs: 30,
      onLine: boundary === 'after-close' ? () => pending : undefined, pendingAck: boundary === 'ack',
      execute: boundary === 'probe' ? () => pending : undefined });
    await flush();
    if (boundary === 'after-close' || boundary === 'ack') h.child.stdout.write(defLines + taskLines);
    if (boundary === 'after-close') h.child.emit('close', 0);
    await assert.rejects(h.result, /deadline exceeded/);
    const writes = h.writes.length;
    release({ stdout: 'v1' });
    await delay(5);
    h.child.emit('close', 0);
    assert.equal(h.writes.length, writes);
    assert.equal(h.killed(), boundary === 'probe' ? 0 : 1);
    if (boundary === 'probe') assert.equal(h.spawned(), 0);
  }
});

test('malformed, duplicate, out-of-order, foreign-run, foreign-purpose and absent checkpoints fail closed', async () => {
  for (const output of [
    taskLines, `Runtime checkpoint: ${checkpoint('definition', definition)}\n`,
    defLines.replace('runtime-checkpoint-v1', 'runtime-checkpoint-v2'),
    defLines.replace('runtime-checkpoint-v1:123', 'runtime-checkpoint-v1:456'),
    defLines.replaceAll('beta-anywear-lifecycle', 'beta-anywear-tester-cleanup'),
    defLines + `Runtime checkpoint: ${checkpoint('definition', definition)}\n`,
    defLines + defLines, defLines + taskLines + taskLines,
    `Task definition: ${definition}\nTask ARN: ${task}\n`,
  ]) {
    const h = harness(); await flush();
    h.child.stdout.write(output); h.child.emit('close', 0);
    await assert.rejects(h.result, /checkpoint|metadata/);
    assert.equal(h.killed(), 1);
  }
});

test('child or stdin errors, nonzero close and output budget reject once without later callback processing', async () => {
  for (const boundary of ['child', 'stdin', 'close', 'budget']) {
    const h = harness(); await flush();
    if (boundary === 'child') h.child.emit('error', new Error('private command error'));
    if (boundary === 'stdin') h.child.stdin.emit('error', new Error('private stdin error'));
    if (boundary === 'close') h.child.emit('close', 1);
    if (boundary === 'budget') h.child.stdout.write('x'.repeat(2 * 1024 * 1024 + 1));
    await assert.rejects(h.result, /failed|budget/);
    h.child.emit('close', 0); await flush();
    assert.equal(h.killed(), 1);
    assert.deepEqual(h.writes, []);
  }
});

test('foreign checkout, missing/wrong protocol and support-check failure do not spawn a mutating helper', async () => {
  for (const boundary of ['revision', 'version', 'failed']) {
    const h = harness({ execute: async (command) => {
      if (boundary === 'failed') throw new Error('raw command/private output');
      return { stdout: command === 'git' ? (boundary === 'revision' ? 'foreign' : scope.deployment.service.source_commit)
        : (boundary === 'version' ? 'v2' : 'v1') };
    } });
    await assert.rejects(h.result, /support check/);
    assert.equal(h.spawned(), 0); assert.equal(h.killed(), 0);
  }
});

test('real Bash subprocess waits for production consumer durable callbacks before crossing each checkpoint', async () => {
  const exec = promisify(execFile);
  const bash = process.platform === 'win32' ? `${process.env.ProgramFiles ?? 'C:/Program Files'}/Git/bin/bash.exe` : 'bash';
  const helper = fileURLToPath(new URL('./fixtures/runtime-checkpoint-helper.sh', import.meta.url));
  let saves = 0;
  const runner = createOneShotRunner({ ...process.env, E2E_SERVICE_CHECKOUT: process.cwd() }, { helperScript: helper,
    execute: async (command, args, options) => command === 'git' ? { stdout: scope.deployment.service.source_commit }
      : exec(bash, args, options),
    spawnProcess: (_command, args, options) => spawn(bash, args, options), deadlineMs: 10_000 });
  const result = await runner({ scope, purpose: 'lifecycle', action: 'close', payload: '', onLine: async (line) => {
    if (line.startsWith('Task definition: ')) { assert.equal(saves, 0); await delay(20); saves++; }
    if (line.startsWith('Task ARN: ')) { assert.equal(saves, 1); await delay(20); saves++; }
  } });
  assert.equal(saves, 2);
  assert.match(result.stdout, /Runtime checkpoint: runtime-checkpoint-v1/);
});

test('terminal rejection is independent of throwing stream destruction or sync/async process abort cleanup', async () => {
  for (const boundary of ['stream', 'terminate', 'async-terminate']) {
    const h = harness({ terminate: boundary === 'terminate' ? () => { throw new Error('termination unavailable'); }
      : boundary === 'async-terminate' ? async () => { throw new Error('termination unavailable'); } : undefined });
    await flush();
    if (boundary === 'stream') h.child.stdout.destroy = () => { throw new Error('destruction unavailable'); };
    h.child.emit('error', new Error('child failed'));
    await assert.rejects(h.result, /child process failed/);
    await flush();
    h.child.emit('close', 0);
    assert.equal(h.killed(), 1);
    assert.deepEqual(h.writes, []);
  }
});
