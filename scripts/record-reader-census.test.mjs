import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';
import { repositoryRoot } from './test-selection.mjs';

// AnyWear #207 retired the self-built Infra operation/deployment evidence chain. It left
// exactly one labelled historical reader in this repository: `scripts/beta-cleanup-diagnostic.mjs`,
// the frozen account-recovery diagnostic that replays only the pinned 2026-01 Infra run
// artifacts named in its own `DIAGNOSTIC_EXPECTED` and reads no new run. Everything else
// qualifies from platform facts (the Environment deployment `beta`, the CloudFormation stack
// events, the release tag→commit and the ECR image digest), never from a producer record.
//
// These source assertions keep a second reader from appearing silently. They are a census,
// not a parser: every `.mjs` module under `scripts/` and `tests/` is scanned (the frozen
// `scripts/vendor/**` producer copy is excluded because it is kept byte-identical and its own
// validators are checked by `vendored-contract.test.mjs`). The census file itself must name
// the forbidden tokens to assert on them, so it excludes itself from its own scan.

const DIAGNOSTIC = 'scripts/beta-cleanup-diagnostic.mjs';
const DIAGNOSTIC_TEST = 'scripts/beta-cleanup-diagnostic.test.mjs';
const CENSUS = 'scripts/record-reader-census.test.mjs';
const MODULE_ROOTS = Object.freeze(['scripts', 'tests']);
const VENDOR = 'scripts/vendor';

// The record-shape validators of the retired producer contract. Only the diagnostic test may
// mention one, and only to assert that the pinned historical fixture is not a current record.
const RECORD_VALIDATORS = Object.freeze([
  'validateDeploymentRecord',
  'validateServiceDeploymentRecord',
  'validateServiceStacks',
  'DEPLOYMENT_RECORD_MEMBERS',
  'SERVICE_DEPLOYMENT_RECORD_MEMBERS',
  'SERVICE_DEPLOYMENT_RECORD_SCHEMA',
  'DEPLOYMENT_RECORD_SCHEMA',
  'validateDeploymentStacks',
]);

// The record types and artifact names of the retired chain. In a module that is not a test,
// only the frozen diagnostic may mention one; a test may use them as fixture data.
const RECORD_SHAPES = Object.freeze([
  'anywear_infra_operation',
  'anywear_infra_verified_inputs',
  'anywear_infra_release_inputs',
  'anywear_infra_deployment',
  'anywear_infra_family_observation',
  'anywear_service_deployment',
  'infra-operation-',
  'infra-deployment-',
  'infra-family-observation-',
  'infra-record-',
  'infra-verified-inputs-',
  'verified-inputs.json',
  'release-inputs.json',
  'operation-record.json',
  'deployment-record.json',
]);

const posix = (path) => relative(repositoryRoot, path).replace(/\\/g, '/');

function moduleFiles() {
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (posix(path) !== VENDOR) walk(path);
      } else if (entry.name.endsWith('.mjs')) {
        files.push(posix(path));
      }
    }
  };
  for (const root of MODULE_ROOTS) walk(join(repositoryRoot, root));
  return files.sort();
}

const FILES = moduleFiles();

function mentions(path, tokens) {
  const source = readFileSync(join(repositoryRoot, path), 'utf8');
  return tokens.filter((token) => source.includes(token));
}

// One line per offending file and token, so a second importer is named in the failure.
function offenders(tokens, allowed, { skipTests = false } = {}) {
  const found = [];
  for (const path of FILES) {
    if (path === CENSUS) continue;
    if (skipTests && path.endsWith('.test.mjs')) continue;
    for (const token of mentions(path, tokens)) {
      if (!allowed.includes(path)) found.push(`${path}: ${token}`);
    }
  }
  return found;
}

test('the record-shape validators appear only in the frozen diagnostic test', () => {
  // The allow-list is not vacuous: the diagnostic test still imports the validator to prove
  // the pinned historical fixture is not a current producer record.
  const diagnosticTest = readFileSync(join(repositoryRoot, DIAGNOSTIC_TEST), 'utf8');
  assert.match(diagnosticTest, /import \{ validateDeploymentRecord \} from '\.\/vendor\/deployment-contract\.mjs';/,
    `${DIAGNOSTIC_TEST} must keep importing the validator for the frozen fixture`);

  const found = offenders(RECORD_VALIDATORS, [DIAGNOSTIC_TEST]);
  assert.deepEqual(found, [],
    `record-shape validators may appear only in ${DIAGNOSTIC_TEST}; found:\n${found.join('\n')}`);
});

test('only the frozen diagnostic names the retired record and artifact shapes', () => {
  // The allow-list is not vacuous either: the frozen diagnostic still pins the artifact and
  // record names it replays from the historical run.
  const diagnostic = readFileSync(join(repositoryRoot, DIAGNOSTIC), 'utf8');
  for (const token of ['anywear_infra_operation', 'operation-record.json']) {
    assert.ok(diagnostic.includes(token), `${DIAGNOSTIC} must keep naming ${token}`);
  }

  const found = offenders(RECORD_SHAPES, [DIAGNOSTIC], { skipTests: true });
  assert.deepEqual(found, [],
    `retired record/artifact shapes may appear only in ${DIAGNOSTIC}; found:\n${found.join('\n')}`);
});
