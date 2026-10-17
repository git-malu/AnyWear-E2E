import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// The deployed invocations select scenarios by tag, so a tag is the scenario's
// declared membership in an invocation. This offline check holds the two ends of
// that contract together: every spec file declares at least one invocation tag on
// its `test.describe` title, and the deployed invocation scripts in package.json
// are exactly the ones the inventory document describes. A renamed or removed tag
// would otherwise drop a scenario out of the release-qualifying selection with
// nothing left to fail, which is the failure this file exists to prevent.
//
// The selection itself is not executed here. A discovery run cannot establish a
// deployed claim, and an offline file cannot load the deployed environment.

const testsDirectory = fileURLToPath(new URL('.', import.meta.url));
const inventoryUrl = new URL('../docs/scenario-inventory.md', import.meta.url);
const packageUrl = new URL('../package.json', import.meta.url);
const inventoryPath = 'docs/scenario-inventory.md';

// Invocation tags, and the scripts that select them. A scenario may carry several:
// `@smoke` and `@regression` overlap deliberately, because the on-demand diagnostic
// and the release gate ask different questions of the same stable path.
const deployedInvocationTag = /@(smoke|regression|instrumentation|drill|full-stack|beta-sizing)\b/;

async function specDeclarations() {
  const entries = (await readdir(testsDirectory)).filter((name) => name.endsWith('.spec.ts')).sort();
  assert.ok(entries.length > 0, 'no spec file was discovered: a check over an empty set proves nothing');
  const specs = [];
  for (const name of entries) {
    // Keys are repository-relative paths, because the inventory names each scenario
    // by the path a reader can open.
    const file = `tests/${name}`;
    const source = await readFile(new URL(name, import.meta.url), 'utf8');
    const title = /test\.describe\(\s*'([^']+)'/.exec(source)?.[1];
    assert.ok(title, `${file} declares no test.describe title`);
    specs.push({ file, title, tags: title.match(/@[a-z-]+/g) ?? [] });
  }
  return specs;
}

function inventorySections(inventory) {
  // The inventory names each scenario with a level-three heading whose text is the
  // spec path. A section runs to the next heading of the same or a higher level.
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

function inventoryTags(section) {
  const declared = /^\| Tags \| (.+) \|$/m.exec(section)?.[1];
  assert.ok(declared, 'the inventory section has no Tags row');
  return declared.match(/@[a-z-]+/g) ?? [];
}

function invocationTags(tags) {
  return tags.filter((tag) => deployedInvocationTag.test(tag)).sort();
}

test('every scenario declares its deployed invocation membership as a tag', async () => {
  for (const { file, title, tags } of await specDeclarations()) {
    assert.ok(deployedInvocationTag.test(title),
      `${file} declares no deployed invocation tag in its describe title: ${title}`);
    assert.equal(new Set(tags).size, tags.length, `${file} repeats a tag: ${tags.join(' ')}`);
  }
});

test('every scenario is classified in the scenario inventory and vice versa', async () => {
  const specs = await specDeclarations();
  const inventory = await readFile(inventoryUrl, 'utf8');
  const sections = inventorySections(inventory);
  for (const { file, title } of specs) {
    const section = sections.get(file);
    assert.ok(section, `${inventoryPath} has no section for ${file}`);
    assert.ok(section.includes(title),
      `${inventoryPath} does not record the current title of ${file}: ${title}`);
  }
  for (const heading of sections.keys()) {
    assert.ok(specs.some(({ file }) => file === heading),
      `${inventoryPath} classifies ${heading}, which is not a tracked scenario`);
  }
});

test('the inventory and every spec agree about which invocations select the scenario', async () => {
  const inventory = await readFile(inventoryUrl, 'utf8');
  const sections = inventorySections(inventory);
  for (const { file, tags } of await specDeclarations()) {
    const section = sections.get(file);
    assert.ok(section, `${inventoryPath} has no section for ${file}`);
    assert.deepEqual(invocationTags(inventoryTags(section)), invocationTags(tags),
      `${inventoryPath} and ${file} disagree about the invocations that select it. `
      + 'A scenario that loses a tag leaves its invocation, so both must move in one change');
  }
});

test('the documented deployed invocations are exactly the scripts that select them', async () => {
  const inventory = await readFile(inventoryUrl, 'utf8');
  // The `## Deployed invocations` table is the record of what exists today. The
  // change that finishes the release-gating split extends that table, and this check
  // fails until it does, so the inventory cannot drift behind package.json.
  const section = /^## Deployed invocations$([\s\S]*?)(?=^## )/m.exec(inventory)?.[1];
  assert.ok(section, `${inventoryPath} has no "Deployed invocations" section`);
  const documented = new Set([...section.matchAll(/`(test(?::[a-z-]+)?)`/g)].map(([, name]) => name));
  documented.delete('test:list'); // Discovery, documented in prose rather than as an invocation.
  assert.ok(documented.size > 0, `${inventoryPath} documents no deployed invocation`);

  const pkg = JSON.parse(await readFile(packageUrl, 'utf8'));
  const declared = new Set(Object.keys(pkg.scripts).filter((name) => name.startsWith('test') && name !== 'test:list'));
  for (const name of declared) assert.ok(documented.has(name),
    `package.json declares ${name} but ${inventoryPath} does not document it`);
  for (const name of documented) assert.ok(declared.has(name),
    `${inventoryPath} documents ${name} but package.json does not declare it`);
});
