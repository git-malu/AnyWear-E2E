import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertEqual, byteHash } from './evidence-contract.mjs';

// The qualification record's `test` member states which selection issued the record, and
// every part of that statement is derived here from four independent sources in this
// checkout. The invocation comes from the qualification workflow's own suite step, found
// by its machine identifier rather than its display name; the tag comes from that
// invocation's `package.json` script, which must be a single positive `--grep` selection;
// the scenario list comes from the run's own Playwright JSON report; and the membership
// comes from the `test.describe` titles of `tests/*.spec.ts`, cross-checked against the
// scenario inventory. The producer that writes a record and the verifier that refuses one
// both call this module, so neither end can carry its own copy of the answer and a stale or
// hand-edited field has to agree with all four sources at once.
//
// Nothing here imports from `node_modules`: the release consumer imports the producer's
// verifier from a bare checkout that has no installed dependencies.

const moduleDirectory = dirname(fileURLToPath(import.meta.url));

// Paths are resolved from this module, never from the process: the verifier runs in its own
// checkout and the tests copy single files into temporary roots.
export const repositoryRoot = resolve(moduleDirectory, '..');

export const QUALIFICATION_WORKFLOW_PATH = '.github/workflows/beta-qualification.yml';
export const QUALIFICATION_SUITE_STEP = 'beta-suite';
export const QUALIFICATION_REPORT_ENV = 'E2E_QUALIFICATION_REPORT';
export const QUALIFICATION_REPORT_PATH = 'test-results/qualification-report.json';
export const SCENARIO_DIRECTORY = 'tests/';
export const INVENTORY_PATH = 'docs/scenario-inventory.md';

export const TEST_KEYS = Object.freeze(['runner', 'result', 'selection', 'report_sha256', 'scenarios']);
export const SELECTION_KEYS = Object.freeze(['invocation', 'tag']);
export const SCENARIO_KEYS = Object.freeze(['file', 'outcome', 'collected', 'skipped']);
export const SCENARIO_OUTCOMES = Object.freeze(['passed', 'flaky', 'skipped', 'failed']);
// A record may state a clean run or one that passed only on a retry. A failed scenario
// refuses the record instead of being written, and a run in which nothing executed cannot
// issue one at all.
export const RECORDABLE_RESULTS = Object.freeze(['passed', 'flaky']);

// Invocation tags, and the scripts that select them. A scenario may carry several. This
// vocabulary is shared with the offline declaration check so both ends read a title the
// same way.
export const deployedInvocationTag = /@(smoke|regression|instrumentation|drill|full-stack|beta-sizing)\b/;

function rootOf(options = {}) {
  return resolve(options.root ?? repositoryRoot);
}

function readText(relativePath, options) {
  return readFileSync(resolve(rootOf(options), relativePath), 'utf8');
}

export function qualificationReportPath(options = {}) {
  return resolve(rootOf(options), QUALIFICATION_REPORT_PATH);
}

// A small, deliberate reader for the one structure this module needs: the workflow's step
// list. A YAML parser would add a dependency the consumer's verifier checkout does not
// have, and the workflow is a fixed file whose steps all sit at one indentation. Only a
// `- name:` at that indentation starts a step, so a `- name:` inside a `run:` block cannot
// be mistaken for one.
function workflowSteps(source) {
  const lines = source.split(/\r?\n/);
  const starts = [];
  for (const [index, line] of lines.entries()) {
    const match = /^( *)- name:/.exec(line);
    if (match) starts.push({ index, indent: match[1].length });
  }
  if (starts.length === 0) throw new Error(`${QUALIFICATION_WORKFLOW_PATH} declares no workflow step`);
  const steps = starts.filter((start) => start.indent === starts[0].indent);
  return steps.map((start, position) => {
    const end = position + 1 < steps.length ? steps[position + 1].index : lines.length;
    return readStep(lines.slice(start.index, end), start.indent);
  });
}

// A step's keys are read from the whole step, wherever a `run:` block sits inside it: an
// `id:` written above or below a block `run:` is the step's id either way. What a block
// scalar contains is content rather than keys, so a `- name:` or an `id:`-shaped line inside
// a `run: |` script cannot start a step or become one.
function readStep(lines, indent) {
  const keyIndent = indent + 2;
  const keyPattern = new RegExp(`^ {${keyIndent}}([a-zA-Z_][a-zA-Z0-9_-]*):[ \t]*(.*)$`);
  const step = { name: /^( *)- name:[ \t]*(.*)$/.exec(lines[0])?.[2].trim() ?? '', id: undefined, run: [] };
  let block = null;
  for (const line of lines.slice(1)) {
    const lineIndent = line.length - line.trimStart().length;
    if (block !== null) {
      if (line.trim() === '' || lineIndent > keyIndent) {
        if (block === 'run') step.run.push(line);
        continue;
      }
      block = null;
    }
    const key = keyPattern.exec(line);
    if (!key) continue;
    const value = key[2].trim();
    if (/^[|>][-+]?$/.test(value)) { block = key[1]; continue; }
    if (key[1] === 'id') { step.id = value; continue; }
    if (key[1] === 'run' && value) step.run.push(value);
  }
  return step;
}

export function qualificationSuiteStep(options = {}) {
  const steps = workflowSteps(readText(QUALIFICATION_WORKFLOW_PATH, options));
  const suite = steps.find((step) => step.id === QUALIFICATION_SUITE_STEP);
  if (!suite) {
    const declared = steps.map((step) => step.id).filter(Boolean);
    throw new Error(`${QUALIFICATION_WORKFLOW_PATH} declares no step with id ${QUALIFICATION_SUITE_STEP}, so the selection that issued a record is unknown (declared step ids: ${declared.length > 0 ? declared.join(', ') : 'none'})`);
  }
  return suite;
}

const pnpmScript = /^pnpm[ \t]+([^\s#]+)[ \t]*$/;

// The invocation is the script the suite step runs, whatever the step is called: renaming
// a step for a reader cannot change which selection produced a record.
export function qualificationInvocation(options = {}) {
  const step = qualificationSuiteStep(options);
  const scripts = step.run.map((line) => pnpmScript.exec(line.trim())?.[1]).filter(Boolean);
  if (scripts.length === 0) {
    const commands = step.run.map((line) => line.trim()).filter(Boolean);
    throw new Error(`The ${QUALIFICATION_SUITE_STEP} step in ${QUALIFICATION_WORKFLOW_PATH} runs no pnpm script, so the selection that issued a record is unknown (its run block is ${commands.length > 0 ? commands.join('; ') : 'empty'})`);
  }
  if (scripts.length > 1) {
    throw new Error(`The ${QUALIFICATION_SUITE_STEP} step in ${QUALIFICATION_WORKFLOW_PATH} runs more than one pnpm script (${scripts.join(', ')}), so the selection that issued a record is ambiguous`);
  }
  return scripts[0];
}

export function readPackageJson(options = {}) {
  return JSON.parse(readText('package.json', options));
}

const selectionCommand = /^playwright test --grep (@[a-z][a-z-]*)$/;

// The tag is the one positive `--grep` selection the invocation makes. A script that
// discovers every test, lists them, or runs offline contracts has no single tag, so it
// cannot say which selection a record would be about and refuses to issue one.
export function selectionTag(pkg, invocation) {
  const command = pkg?.scripts?.[invocation];
  if (typeof command !== 'string') throw new Error(`package.json declares no ${invocation} script, so the qualification selection has no tag`);
  const match = selectionCommand.exec(command);
  if (!match) throw new Error(`package.json script ${invocation} is not a single positive --grep tag selection, so it cannot issue a qualification record: ${command}`);
  return match[1];
}

export function qualificationSelection(options = {}) {
  const invocation = qualificationInvocation(options);
  return { invocation, tag: selectionTag(readPackageJson(options), invocation) };
}

// A spec declares a runtime skip when `test.skip(...)` starts with a computed condition. A
// quoted first argument names a test and skips it unconditionally, which is a declaration
// rather than a runtime reason the record has to explain.
const runtimeSkip = /^[ \t]*test\.skip\(\s*(?![`'"])/m;

export function declaresRuntimeSkip(source) {
  return runtimeSkip.test(source);
}

export function specDeclarations(options = {}) {
  const directory = resolve(rootOf(options), SCENARIO_DIRECTORY);
  const entries = readdirSync(directory).filter((name) => name.endsWith('.spec.ts')).sort();
  if (entries.length === 0) throw new Error('no spec file was discovered: a check over an empty set proves nothing');
  return entries.map((name) => {
    // Keys are repository-relative paths, because the record and the inventory name each
    // scenario by the path a reader can open.
    const file = `${SCENARIO_DIRECTORY}${name}`;
    const source = readFileSync(resolve(directory, name), 'utf8');
    const title = /test\.describe\(\s*'([^']+)'/.exec(source)?.[1];
    return { file, title, tags: title?.match(/@[a-z-]+/g) ?? [], declaresRuntimeSkip: declaresRuntimeSkip(source) };
  });
}

export function inventorySections(inventory) {
  // The inventory names each scenario with a level-three heading whose text is the spec
  // path. A section runs to the next heading of the same or a higher level.
  const headings = [...inventory.matchAll(/^(#{1,3}) (.+)$/gm)];
  const sections = new Map();
  headings.forEach((heading, index) => {
    const level = heading[1].length;
    const start = heading.index + heading[0].length;
    let end = inventory.length;
    for (const next of headings.slice(index + 1)) {
      if (next[1].length <= level) { end = next.index; break; }
    }
    const name = /^`([^`]+)`$/.exec(heading[2])?.[1];
    if (level === 3 && name) sections.set(name, inventory.slice(start, end));
  });
  return sections;
}

export function inventoryTags(section) {
  const declared = /^\| Tags \| (.+) \|$/m.exec(section)?.[1];
  if (!declared) throw new Error('the inventory section has no Tags row');
  return declared.match(/@[a-z-]+/g) ?? [];
}

export function invocationTags(tags) {
  return tags.filter((tag) => deployedInvocationTag.test(tag)).sort();
}

// The spec titles and the inventory must agree about every tag a scenario carries. They are
// two records of one classification, so a change that moves one and not the other fails here
// rather than silently leaving a scenario out of the selection a record states.
export function assertScenarioDeclarations(options = {}) {
  const declarations = specDeclarations(options);
  const sections = inventorySections(readText(INVENTORY_PATH, options));
  for (const declaration of declarations) {
    const section = sections.get(declaration.file);
    if (!section) throw new Error(`${INVENTORY_PATH} has no section for ${declaration.file}`);
    if (!declaration.title) throw new Error(`${declaration.file} declares no test.describe title`);
    if (!section.includes(declaration.title)) {
      throw new Error(`${INVENTORY_PATH} does not record the current title of ${declaration.file}: ${declaration.title}`);
    }
    assertEqual([...new Set(declaration.tags)].sort(), [...new Set(inventoryTags(section))].sort(),
      `${INVENTORY_PATH} tags for ${declaration.file}`);
  }
  for (const classified of sections.keys()) {
    if (!declarations.some((declaration) => declaration.file === classified)) {
      throw new Error(`${INVENTORY_PATH} classifies ${classified}, which is not a tracked scenario`);
    }
  }
  return declarations;
}

export function selectedScenarios(tag, options = {}) {
  return assertScenarioDeclarations(options)
    .filter(({ tags }) => tags.includes(tag))
    .map(({ file, title, declaresRuntimeSkip: skip }) => ({ file, title, declaresRuntimeSkip: skip }))
    .sort((left, right) => (left.file < right.file ? -1 : left.file > right.file ? 1 : 0));
}

const reportStatusOutcome = Object.freeze({ expected: 'passed', flaky: 'flaky', skipped: 'skipped', unexpected: 'failed' });

// The report is the run's own output, not a signed record: it is parsed leniently so a
// retry-heavy report larger than the evidence contract's record limit is still readable.
export function parsePlaywrightReport(bytes) {
  let source;
  if (typeof bytes === 'string') source = bytes;
  else if (Buffer.isBuffer(bytes) || ArrayBuffer.isView(bytes)) {
    try {
      source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (error) {
      throw new Error(`The Playwright JSON report at ${QUALIFICATION_REPORT_PATH} is not valid UTF-8`, { cause: error });
    }
  } else {
    throw new Error(`The run's Playwright JSON report bytes are required at ${QUALIFICATION_REPORT_PATH}`);
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`The Playwright JSON report at ${QUALIFICATION_REPORT_PATH} is not JSON: ${error.message}`, { cause: error });
  }
}

// The report names each spec file relative to the configured test directory, so the record's
// repository-relative path is the declared one. The path still has to be a declared member:
// the membership check refuses a file this repository does not track.
function reportFile(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`The Playwright JSON report contains a ${label} that names no spec file`);
  }
  const normalized = value.replaceAll('\\', '/');
  return normalized.startsWith(SCENARIO_DIRECTORY) ? normalized : `${SCENARIO_DIRECTORY}${normalized}`;
}

function collectReportSpec(suiteFile, spec, files) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new Error(`The Playwright JSON report contains an invalid spec in ${suiteFile}`);
  }
  if (spec.file !== undefined && reportFile(spec.file, 'spec') !== suiteFile) {
    throw new Error(`The Playwright JSON report places the ${reportFile(spec.file, 'spec')} spec in a suite for ${suiteFile}`);
  }
  if (!Array.isArray(spec.tests) || spec.tests.length === 0) {
    throw new Error(`The Playwright JSON report records a spec in ${suiteFile} with no test`);
  }
  const entry = files.get(suiteFile) ?? { file: suiteFile, collected: 0, skipped: 0, outcomes: [] };
  for (const recorded of spec.tests) {
    if (!recorded || typeof recorded !== 'object' || Array.isArray(recorded)) {
      throw new Error(`The Playwright JSON report records an invalid test in ${suiteFile}`);
    }
    const outcome = reportStatusOutcome[recorded.status];
    if (!outcome) {
      throw new Error(`The Playwright JSON report records the unknown test status ${JSON.stringify(recorded.status)} in ${suiteFile}`);
    }
    entry.collected += 1;
    if (outcome === 'skipped') entry.skipped += 1;
    entry.outcomes.push(outcome);
  }
  files.set(suiteFile, entry);
}

function collectReportSuites(suites, inheritedFile, files) {
  for (const suite of suites) {
    if (!suite || typeof suite !== 'object' || Array.isArray(suite)) {
      throw new Error('The Playwright JSON report contains an invalid suite');
    }
    const declared = suite.file ?? inheritedFile;
    if (declared === undefined) throw new Error('The Playwright JSON report contains a suite that names no spec file');
    const suiteFile = reportFile(declared, 'suite');
    if (Array.isArray(suite.specs)) for (const spec of suite.specs) collectReportSpec(suiteFile, spec, files);
    if (suite.suites !== undefined) {
      if (!Array.isArray(suite.suites)) throw new Error(`The Playwright JSON report records a non-list suites member under ${suiteFile}`);
      collectReportSuites(suite.suites, suiteFile, files);
    }
  }
}

// One entry per selected spec, with the outcome aggregated over its collected tests by
// priority: a failure anywhere, then a retry-only pass, then a file in which nothing ran,
// then a pass.
export function reportScenarios(reportBytes) {
  const report = parsePlaywrightReport(reportBytes);
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    throw new Error('The Playwright JSON report must be an object');
  }
  if (!Array.isArray(report.suites)) throw new Error('The Playwright JSON report declares no suites');
  const files = new Map();
  collectReportSuites(report.suites, undefined, files);
  if (files.size === 0) {
    throw new Error('The Playwright JSON report records no scenario, so it cannot issue a qualification record');
  }
  return [...files.values()]
    .map(({ file, collected, skipped, outcomes }) => ({
      file,
      outcome: outcomes.includes('failed') ? 'failed'
        : outcomes.includes('flaky') ? 'flaky'
          : collected === skipped ? 'skipped' : 'passed',
      collected,
      skipped,
    }))
    .sort((left, right) => (left.file < right.file ? -1 : left.file > right.file ? 1 : 0));
}

function missingReportMessage(options) {
  return `The qualification record requires the run's Playwright JSON report bytes at ${qualificationReportPath(options)}; ${QUALIFICATION_REPORT_ENV} names that path and the release-gating suite step writes it`;
}

export function buildTestMember(reportBytes, options = {}) {
  if (reportBytes === undefined || reportBytes === null) throw new Error(missingReportMessage(options));
  const selection = qualificationSelection(options);
  const scenarios = reportScenarios(reportBytes);
  const member = {
    runner: 'playwright',
    result: scenarios.some(({ outcome }) => outcome === 'flaky') ? 'flaky' : 'passed',
    selection: { invocation: selection.invocation, tag: selection.tag },
    report_sha256: byteHash(reportBytes),
    scenarios,
  };
  assertTestSelection(member, options);
  return member;
}

// The verifier's half of the same derivation. Every statement a record makes about its
// selection is re-derived from this checkout and compared here, so the field cannot become a
// constant again: a hard-coded value would have to equal the workflow, `package.json`, the
// spec titles, the scenario inventory and the per-scenario counts at once.
//
// This function is synchronous on purpose: `verifyQualificationRecord` is called
// synchronously by fixtures and tests, so its repository reads must be synchronous too.
export function assertTestSelection(test, options = {}) {
  if (!test || typeof test !== 'object' || Array.isArray(test)) {
    throw new Error('The qualification record has no test member to verify');
  }
  if (test.runner !== 'playwright') throw new Error('Qualification test runner must be playwright');
  const selection = qualificationSelection(options);
  const stated = test.selection;
  if (!stated || typeof stated !== 'object' || Array.isArray(stated)) {
    throw new Error('The qualification record states no test selection');
  }
  if (stated.invocation !== selection.invocation || stated.tag !== selection.tag) {
    throw new Error(`Qualification selection mismatch: the record states ${JSON.stringify(stated.invocation)} ${JSON.stringify(stated.tag)}, but ${QUALIFICATION_WORKFLOW_PATH}'s ${QUALIFICATION_SUITE_STEP} step runs ${selection.invocation}, whose package.json script selects ${selection.tag}`);
  }
  const members = selectedScenarios(selection.tag, options);
  if (!Array.isArray(test.scenarios)) throw new Error('The qualification record states no scenario list');
  const derived = members.map(({ file }) => file);
  for (const scenario of test.scenarios) {
    if (!scenario || typeof scenario !== 'object' || Array.isArray(scenario)) {
      throw new Error('A qualification scenario must be an object');
    }
  }
  const statedFiles = test.scenarios.map(({ file }) => file);
  const missing = derived.filter((file) => !statedFiles.includes(file));
  const unselected = statedFiles.filter((file) => !derived.includes(file));
  if (missing.length > 0 || unselected.length > 0) {
    const differences = [
      missing.length > 0 ? `omits ${missing.join(', ')}` : '',
      unselected.length > 0 ? `adds ${unselected.join(', ')}` : '',
    ].filter(Boolean).join('; ');
    throw new Error(`The qualification scenarios ${differences}, but the ${selection.tag} selection declared by the spec titles and ${INVENTORY_PATH} is ${derived.join(', ')}`);
  }
  assertEqual(statedFiles, derived, `Qualification scenario order for the ${selection.tag} selection`);

  const declared = new Map(members.map((member) => [member.file, member]));
  for (const { file, outcome, collected, skipped } of test.scenarios) {
    if (!Number.isInteger(collected) || collected < 1) {
      throw new Error(`Qualification scenario ${file} must collect at least one test`);
    }
    if (!Number.isInteger(skipped) || skipped < 0 || skipped > collected) {
      throw new Error(`Qualification scenario ${file} must skip between 0 and ${collected} of its collected tests`);
    }
    if (!SCENARIO_OUTCOMES.includes(outcome)) {
      throw new Error(`Qualification scenario ${file} records the unknown outcome ${JSON.stringify(outcome)}`);
    }
    if (outcome === 'failed') {
      throw new Error(`Qualification scenario ${file} failed, so the run cannot issue a qualification record`);
    }
    if ((outcome === 'skipped') !== (skipped === collected)) {
      throw new Error(`Qualification scenario ${file} is stated ${outcome} with ${skipped} of its ${collected} collected tests skipped`);
    }
  }
  // A run that collected tests and executed none establishes nothing, so it cannot issue a
  // record even when every one of its skips is declared.
  if (!test.scenarios.some(({ collected, skipped }) => skipped < collected)) {
    throw new Error('A qualification record requires at least one scenario that executed; this run recorded none');
  }
  for (const { file, skipped } of test.scenarios) {
    if (skipped > 0 && !declared.get(file).declaresRuntimeSkip) {
      throw new Error(`Qualification scenario ${file} records ${skipped} skipped test(s), but ${file} declares no runtime skip, so the record would excuse an acceptance path that never ran`);
    }
  }
  const derivedResult = test.scenarios.some(({ outcome }) => outcome === 'flaky') ? 'flaky' : 'passed';
  if (test.result !== derivedResult) {
    throw new Error(`Qualification test result ${JSON.stringify(test.result)} must be ${derivedResult} for the recorded scenario outcomes`);
  }
  return test;
}
