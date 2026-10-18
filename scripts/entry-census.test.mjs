import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { repositoryRoot } from './test-selection.mjs';

// #163: the repository-side census of the entry face. The E2E deployable unit ends with two
// entries — one automatic check and one manual qualify — one manual dispatch surface and one
// activation switch, and the qualify chain keeps each AWS-credential job behind the
// credential-free preflight with a credential-free record job after it. These are source
// assertions so the next change cannot drift the entry face without failing `pnpm check`.

const directory = join(repositoryRoot, '.github', 'workflows');
const entries = readdirSync(directory).filter((name) => name.endsWith('.yml')).sort();
const read = (name) => readFileSync(join(directory, name), 'utf8');

function jobSection(workflow, name) {
  const marker = `\n  ${name}:\n`;
  const start = workflow.indexOf(marker);
  if (start < 0) return '';
  const rest = workflow.slice(start + marker.length);
  const next = rest.search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return marker + (next < 0 ? rest : rest.slice(0, next));
}

const check = read('check.yml');
const qualify = read('beta-qualification.yml');
const job = (name) => jobSection(qualify, name);

function inputBlock(name) {
  const start = qualify.indexOf(`\n      ${name}:\n`);
  assert.ok(start >= 0, `${name} must be a workflow input`);
  const rest = qualify.slice(start + 1);
  const next = rest.search(/\n {6}[a-z_]+:\n/);
  return next < 0 ? rest : rest.slice(0, next);
}

test('the deployable unit exposes exactly two entries: one automatic check and one manual qualify', () => {
  assert.deepEqual(entries, ['beta-qualification.yml', 'check.yml']);

  // The automatic entry absorbs quality and tool-regressions. `quality.yml` carried no path
  // filter, so the workflow-level union is unfiltered and tool-regressions now runs on every
  // check; the cost is recorded in the PR body for #163.
  assert.match(check, /^on:\n {2}push:\n {4}branches: \[main\]\n {2}pull_request:\n {4}branches: \[main\]\n/m);
  assert.doesNotMatch(check, /workflow_dispatch/);
  assert.doesNotMatch(check, /\bpaths:/);

  // The manual entry is the only dispatch surface, and it declares the operation menu.
  assert.equal([...qualify.matchAll(/^ {2}workflow_dispatch:$/gm)].length, 1);
  const operation = inputBlock('operation');
  assert.match(operation, /required: true/);
  assert.match(operation, /type: choice/);
  assert.match(operation, /options: \[full, smoke, measure, recover\]/);
  const sizing = inputBlock('sizing_stage');
  assert.match(sizing, /type: choice/);
  // `none` is the unselected sentinel a no-default choice needs (GitHub preselects the first
  // option); measure refuses it, so a measurement stage is never implicit.
  assert.match(sizing, /options: \[none, S1, S2, S3\]/);
  assert.doesNotMatch(sizing, /default:/, 'a measurement stage is never implicit');
});

test('the qualify chain keeps one credential job per operation and a credential-free record', () => {
  const preflight = job('preflight');
  assert.ok(preflight.length > 0);
  assert.match(preflight, /permissions:\n {6}contents: read\n/);
  assert.doesNotMatch(preflight, /environment:|id-token|configure-aws-credentials/);
  assert.match(preflight, /node scripts\/execution-guard\.mjs --source-only/);

  for (const operation of ['full', 'smoke', 'measure', 'recover']) {
    const section = job(operation);
    assert.ok(section.length > 0, `the qualify entry must declare ${operation}`);
    assert.match(section, /needs: preflight/);
    assert.match(section, new RegExp(`if: github\\.ref == 'refs/heads/main' && needs\\.preflight\\.outputs\\.operation == '${operation}'`));
    assert.match(section, /environment: beta/);
    assert.match(section, /id-token: write/);
    assert.equal([...section.matchAll(/configure-aws-credentials/g)].length, 1, `${operation} has exactly one AWS credential step`);
  }

  // The record job holds no credential and runs only for full. Only full may produce the
  // record; the record job validates and attaches it.
  const record = job('record');
  assert.ok(record.length > 0);
  assert.match(record, /needs: \[preflight, full\]/);
  assert.match(record, /if: github\.ref == 'refs\/heads\/main' && needs\.preflight\.outputs\.operation == 'full'/);
  assert.match(record, /permissions:\n {6}contents: read\n/);
  assert.doesNotMatch(record, /environment:|id-token|configure-aws-credentials/);
  assert.match(job('full'), /qualification:generate/);
  for (const name of ['preflight', 'smoke', 'measure', 'recover', 'record']) {
    assert.doesNotMatch(job(name), /qualification:generate/, `${name} must not produce the qualification record`);
  }
});

test('the only activation switch in this repository is ENABLE_BETA_MUTATION', () => {
  const names = new Set([...qualify.matchAll(/\bENABLE_[A-Z0-9_]+\b/g)].map((match) => match[0]));
  assert.deepEqual([...names], ['ENABLE_BETA_MUTATION']);
  assert.doesNotMatch(check, /\bENABLE_[A-Z0-9_]+\b/);
  const guard = readFileSync(join(repositoryRoot, 'scripts', 'execution-guard.mjs'), 'utf8');
  assert.match(guard, /environment\.ENABLE_BETA_MUTATION/);
  assert.doesNotMatch(guard, /ENABLE_INFRA_E2E/);
});
