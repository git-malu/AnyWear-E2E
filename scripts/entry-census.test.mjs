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
// GitHub Actions accepts both workflow extensions. Enumerate both, so a `.yaml` entry
// cannot appear beside the tracked `.yml` files without changing the census.
const entries = readdirSync(directory).filter((name) => /\.ya?ml$/.test(name)).sort();
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
  assert.match(operation, /options: \[full, smoke, recover\]/);
  // The retired measurement operation carried the only sizing stage input; nothing in the
  // entry may declare it again.
  assert.doesNotMatch(qualify, /sizing_stage/, 'the retired measurement operation carries no dispatch input');

  // #180: the live-tuple dispatch surface. The expectation is optional and only `full`
  // compares it; the trigger is a closed choice; the dispatching run URL is optional and
  // only accepted for a non-manual trigger.
  for (const name of ['expected_service_commit', 'expected_client_commit']) {
    const input = inputBlock(name);
    assert.match(input, /required: false/);
    assert.match(input, /type: string/);
  }
  const trigger = inputBlock('trigger');
  assert.match(trigger, /type: choice/);
  assert.match(trigger, /default: manual/);
  assert.match(trigger, /options: \[manual, deploy-smoke, release-qualify\]/);
  const dispatchedBy = inputBlock('dispatched_by');
  assert.match(dispatchedBy, /required: false/);
  assert.match(dispatchedBy, /type: string/);
  // The qualification entry reads no committed compatibility file and checks out no
  // producer source: the live tuple comes from the deployed endpoints and the platform
  // observation comes from this repository's own vendored contract.
  assert.doesNotMatch(qualify, /compatibility\.json/);
  assert.doesNotMatch(qualify, /check-compatibility\.mjs/);
  assert.doesNotMatch(qualify, /trusted-deployment-inputs\.mjs/);
  assert.doesNotMatch(qualify, /\.infra-source/);
  assert.match(qualify, /node scripts\/service-release\.mjs/);
  assert.match(qualify, /minimum-supported-client\.json/);
});

test('the qualify chain keeps one credential job per operation and a credential-free record', () => {
  const preflight = job('preflight');
  assert.ok(preflight.length > 0);
  assert.match(preflight, /permissions:\n {6}contents: read\n/);
  assert.doesNotMatch(preflight, /environment:|id-token|configure-aws-credentials/);
  assert.match(preflight, /node scripts\/execution-guard\.mjs --source-only/);
  // #180: the live tuple is verified in the credential-free preflight through the Service
  // App token, and the retired producer sources are gone.
  assert.match(preflight, /node scripts\/service-release\.mjs/);
  assert.match(preflight, /repositories: AnyWear-Service/);
  assert.doesNotMatch(preflight, /check-compatibility|trusted-deployment-inputs|\.infra-source|GH_TOKEN: \$\{\{ steps\.evidence-token/);

  for (const operation of ['full', 'smoke', 'recover']) {
    const section = job(operation);
    assert.ok(section.length > 0, `the qualify entry must declare ${operation}`);
    assert.match(section, /needs: preflight/);
    assert.match(section, new RegExp(`if: github\\.ref == 'refs/heads/main' && needs\\.preflight\\.outputs\\.operation == '${operation}'`));
    assert.match(section, /environment: beta/);
    assert.match(section, /id-token: write/);
    assert.equal([...section.matchAll(/configure-aws-credentials/g)].length, 1, `${operation} has exactly one AWS credential step`);
  }

  // The record job holds no credential and runs only for full. Only full may produce the
  // record; the record job validates and attaches it and is the last qualification job. The
  // attached tuple is the live identity and the verified release, not a producer deployment
  // record.
  const record = job('record');
  assert.ok(record.length > 0);
  assert.match(record, /needs: \[preflight, full\]/);
  assert.match(record, /if: github\.ref == 'refs\/heads\/main' && needs\.preflight\.outputs\.operation == 'full'/);
  assert.match(record, /permissions:\n {6}contents: read\n/);
  assert.doesNotMatch(record, /environment:|id-token|configure-aws-credentials/);
  assert.match(job('full'), /qualification:generate/);

  // The release decision is the green `full` run plus the sealed record: there is no human
  // approval job and no approval Environment. The dispatch event (actor and time), the run
  // and the record tuple are the audit trail.
  assert.equal(job('approve'), '', 'the qualify entry must not declare an approval job');
  assert.match(qualify, /dispatched_by/);
  assert.doesNotMatch(qualify, /beta-release-approval/);
  assert.doesNotMatch(qualify, /AwaitingApproval|Approved|Rejected/);
  for (const name of ['preflight', 'smoke', 'recover', 'record']) {
    assert.doesNotMatch(job(name), /qualification:generate/, `${name} must not produce the qualification record`);
  }
  // `record` is the last job in the workflow.
  assert.ok(qualify.trimEnd().endsWith('if-no-files-found: error'), 'record must be the last qualification job');
});

test('no qualification job downloads a producer deployment record or checks out producer source', () => {
  for (const name of ['preflight', 'full', 'smoke', 'record']) {
    const section = job(name);
    assert.doesNotMatch(section, /platform-deployment-record\.json/, `${name} must not retain the retired platform record`);
    assert.doesNotMatch(section, /\.qualification-inputs\/deployment-record\.json/, `${name} must not retain the retired workload record`);
    assert.doesNotMatch(section, /repository: git-malu\/AnyWear-Infra/, `${name} must not check out the Infra observer`);
  }
  // The full job records and retains the two files the v3 record is built from.
  for (const name of ['full', 'record']) {
    const section = job(name);
    assert.match(section, /\.qualification-inputs\/live-identity\.json/);
    assert.match(section, /\.qualification-inputs\/service-artifacts\.json/);
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
