import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';
import { repositoryRoot } from './test-selection.mjs';

// AnyWear #207 retired the self-built Infra operation/deployment evidence chain and left
// exactly one labelled historical reader in this repository: `scripts/beta-cleanup-diagnostic.mjs`,
// the frozen account-recovery diagnostic that replayed only the pinned 2026-01 Infra run
// artifacts named in its own `DIAGNOSTIC_EXPECTED` (#212). AnyWear #217 removed the manual
// `recover` operation, that diagnostic and its tests, so this repository now has **no**
// historical record reader: everything qualifies from platform facts (the Environment
// deployment `beta`, the CloudFormation stack events, the release tag→commit and the ECR
// image digest) and from this repository's own artifacts.
//
// These source assertions keep a reader from reappearing silently. They are a census, not a
// parser: every `.mjs` module under `scripts/` and `tests/` is scanned (the frozen
// `scripts/vendor/**` producer copy is excluded because it is kept byte-identical and its own
// validators are checked by `vendored-contract.test.mjs`). The census file itself must name
// the forbidden tokens to assert on them, so it excludes itself from its own scan.

const CENSUS = 'scripts/record-reader-census.test.mjs';
const MODULE_ROOTS = Object.freeze(['scripts', 'tests']);
const VENDOR = 'scripts/vendor';

// The one labelled historical reader #207 left and #217 removed. Naming them here is what
// makes the census non-vacuous: the assertion fails if either comes back.
const REMOVED_DIAGNOSTIC = Object.freeze([
  'scripts/beta-cleanup-diagnostic.mjs',
  'scripts/beta-cleanup-diagnostic.test.mjs',
]);

// The record-shape validators of the retired producer contract. No module in this repository
// may name one any more.
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
// none may be named; a test may still use a token as fixture data (one fixture names the
// unrelated `beta-infra-deployment-role` IAM role).
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
function offenders(tokens, { skipTests = false } = {}) {
  const found = [];
  for (const path of FILES) {
    if (path === CENSUS) continue;
    if (skipTests && path.endsWith('.test.mjs')) continue;
    for (const token of mentions(path, tokens)) found.push(`${path}: ${token}`);
  }
  return found;
}

test('the frozen recovery diagnostic and its test are removed', () => {
  for (const path of REMOVED_DIAGNOSTIC) {
    assert.equal(existsSync(join(repositoryRoot, path)), false, `${path} must not be restored: the manual recovery path is removed (#217)`);
  }
  assert.equal(existsSync(join(repositoryRoot, 'scripts', 'account-recovery-inputs.mjs')), false);
  assert.equal(existsSync(join(repositoryRoot, 'docs', 'account-recovery.md')), false);
});

test('the retired producer record-shape validators appear in no module', () => {
  const found = offenders(RECORD_VALIDATORS);
  assert.deepEqual(found, [],
    `retired record-shape validators may appear nowhere; found:\n${found.join('\n')}`);
});

test('only a test fixture may name a retired record or artifact shape', () => {
  const found = offenders(RECORD_SHAPES, { skipTests: true });
  assert.deepEqual(found, [],
    `retired record/artifact shapes may appear only in test fixtures; found:\n${found.join('\n')}`);
});
