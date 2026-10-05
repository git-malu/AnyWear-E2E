import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const SCRIPT = '.github/scripts/run-one-shot-task.sh';
const DEFINITION = /^arn:aws:ecs:ap-east-1:650880818323:task-definition\/beta-anywear-(task-audit|lifecycle|tester-cleanup):[1-9][0-9]*$/;
const TASK = /^arn:aws:ecs:ap-east-1:650880818323:task\/beta-anywear\/[a-f0-9]{32}$/;

function abortProcessTree(child) {
  if (!Number.isInteger(child.pid) || child.pid < 1) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 2_000 }, () => {});
    return;
  }
  const killGroup = (signal) => { try { process.kill(-child.pid, signal); } catch { /* Already exited. */ } };
  killGroup('SIGTERM');
  const forced = setTimeout(() => killGroup('SIGKILL'), 2_000);
  forced.unref();
}

export function createOneShotRunner(environment, {
  execute = exec, spawnProcess = spawn, terminate = abortProcessTree, deadlineMs = 600_000, helperScript = SCRIPT,
} = {}) {
  return ({ scope, purpose, action, payload, onLine }) => new Promise((resolve, reject) => {
    let child;
    let terminal = false;
    let stdout = '';
    let buffered = '';
    let lines = Promise.resolve();
    let definition;
    let task;
    let checkpoint = 0;
    const abort = new AbortController();
    const guard = () => { if (terminal) throw new Error('One-shot transport is terminal'); };
    const timer = setTimeout(() => fail(new Error('One-shot execution deadline exceeded')), deadlineMs);
    const fail = (error) => {
      if (terminal) return;
      terminal = true;
      clearTimeout(timer);
      reject(error);
      try { abort.abort(); } catch { /* Rejection must not depend on abort cleanup. */ }
      if (child) {
        for (const stream of [child.stdin, child.stdout, child.stderr]) {
          try { stream.destroy(); } catch { /* Best effort after terminal rejection. */ }
        }
        try { Promise.resolve(terminate(child)).catch(() => {}); } catch { /* Best effort after terminal rejection. */ }
      }
    };
    const acknowledge = async (value) => {
      guard();
      await new Promise((done, failed) => child.stdin.write(`${value}\n`, (error) => error ? failed(new Error('One-shot checkpoint acknowledgement write failed')) : done()));
      guard();
    };
    const consume = async (line) => {
      guard();
      if (line.startsWith('Runtime checkpoint')) {
        const phase = checkpoint === 0 ? 'definition' : 'task';
        const arn = checkpoint === 0 ? definition : task;
        const expected = `runtime-checkpoint-v1:${scope.runScope}:${phase}:${arn}`;
        if (checkpoint >= 2 || !arn || line !== `Runtime checkpoint: ${expected}`) throw new Error('One-shot checkpoint failed exact run/phase/metadata binding');
        await acknowledge(expected);
        checkpoint++;
        return;
      }
      if (line.startsWith('Task definition: ')) {
        const value = line.slice('Task definition: '.length);
        if (definition || DEFINITION.exec(value)?.[1] !== purpose || checkpoint !== 0) throw new Error('Duplicate or foreign one-shot definition metadata');
        await onLine(line);
        guard();
        definition = value;
        return;
      }
      if (line.startsWith('Task ARN: ')) {
        const value = line.slice('Task ARN: '.length);
        if (task || !TASK.test(value) || checkpoint !== 1) throw new Error('Duplicate, out-of-order or foreign one-shot task metadata');
        await onLine(line);
        guard();
        task = value;
        return;
      }
      await onLine(line);
      guard();
    };
    const queue = (line) => { lines = lines.then(() => terminal ? undefined : consume(line)).catch(fail); };
    (async () => {
      if (typeof environment.E2E_SERVICE_CHECKOUT !== 'string' || !environment.E2E_SERVICE_CHECKOUT) throw new Error('E2E_SERVICE_CHECKOUT is required');
      const cwd = path.resolve(environment.E2E_SERVICE_CHECKOUT);
      const options = { cwd, env: environment, signal: abort.signal, timeout: Math.min(deadlineMs, 30_000), maxBuffer: 4096, windowsHide: true };
      const revision = await execute('git', ['rev-parse', 'HEAD'], options);
      guard();
      if (revision.stdout.trim() !== scope.deployment.service.source_commit) throw new Error('One-shot Service checkout differs from the exact pinned revision');
      await execute('git', ['diff', '--quiet', 'HEAD', '--', helperScript], options);
      guard();
      const probe = await execute('bash', [helperScript, '--runtime-checkpoint-protocol'], options);
      guard();
      if (probe.stdout.trim() !== 'v1') throw new Error('Pinned Service helper does not support the required checkpoint protocol');
      child = spawnProcess('bash', [helperScript, 'beta', purpose, scope.deployment.service.image_digest,
        scope.deployment.service.source_commit, action, payload], {
        cwd, env: { ...environment, RUNTIME_DRILL_RUN_SCOPE: scope.runScope, RUNTIME_DRILL_CHECKPOINT_PROTOCOL: 'v1' },
        stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true,
      });
      child.stdin.on('error', () => fail(new Error('One-shot checkpoint stdin failed')));
      child.on('error', () => fail(new Error('One-shot child process failed')));
      child.stdout.on('error', () => fail(new Error('One-shot stdout failed')));
      child.stderr.on('error', () => fail(new Error('One-shot stderr failed')));
      child.stderr.resume();
      child.stdout.on('data', (chunk) => {
        if (terminal) return;
        stdout += chunk.toString();
        if (Buffer.byteLength(stdout) > 2 * 1024 * 1024) { fail(new Error('One-shot output budget exceeded')); return; }
        buffered += chunk.toString();
        const complete = buffered.split(/\r?\n/);
        buffered = complete.pop();
        for (const line of complete) queue(line);
      });
      child.on('close', (code) => {
        if (terminal) return;
        if (code !== 0) { fail(new Error(`One-shot ${purpose} failed; owned recovery metadata retained`)); return; }
        if (buffered) queue(buffered);
        lines.then(() => {
          if (terminal) return;
          if (checkpoint !== 2) { fail(new Error('One-shot child exited without both durable checkpoints')); return; }
          terminal = true;
          clearTimeout(timer);
          resolve({ stdout });
        }, fail);
      });
    })().catch(() => fail(new Error('One-shot pinned helper support check or process setup failed')));
  });
}
