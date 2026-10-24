import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { byteHash } from './evidence-contract.mjs';
import { assertVendoredProvenance, loadVendoredProvenance } from './vendored-contract.mjs';

const SOURCE_SHA = '8022da659001d0c14bcc35e09f5d667180c49dd5';
const VENDORED_FILES = [
  'contracts.mjs', 'deployment-contract.mjs', 'json-contract.mjs', 'operation-stacks.mjs', 'stage-contract-parameters.mjs',
];

test('the vendored contract matches its pinned producer commit and file hashes', async () => {
  const provenance = await loadVendoredProvenance();
  assert.equal(provenance.source_repository, 'git-malu/AnyWear-Infra');
  assert.equal(provenance.source_sha, SOURCE_SHA);
  assert.deepEqual(Object.keys(provenance.files).sort(), VENDORED_FILES);
  assert.deepEqual(provenance.producer_paths, {
    'contracts.mjs': 'lib/contracts.mjs',
    'deployment-contract.mjs': 'scripts/deployment-contract.mjs',
    'json-contract.mjs': 'scripts/json-contract.mjs',
    'operation-stacks.mjs': 'scripts/operation-stacks.mjs',
    'stage-contract-parameters.mjs': 'scripts/stage-contract-parameters.mjs',
  });
  assert.deepEqual(Object.keys(provenance.producer_files), ['stage-contract-parameters.mjs']);
  assert.deepEqual(provenance.import_rewrites, {
    'stage-contract-parameters.mjs': [{ from: "from '../lib/contracts.mjs'", to: "from './contracts.mjs'" }],
  });
  assert.equal(provenance.package, undefined);
  assert.deepEqual(await assertVendoredProvenance(), provenance);
});

// #180: E2E takes the authenticated platform observation itself, so it reads the
// stage contract through the same bounded `ssm get-parameters` reader the producer
// uses. The vendored copy is the producer's file with one declared import rewrite,
// and the reader still refuses a short or foreign stage-contract surface.
test('the vendored stage-input reader is the producer copy with the declared rewrite', async () => {
  const reader = await import('./vendor/stage-contract-parameters.mjs');
  assert.equal(typeof reader.readStageInputs, 'function');
  assert.equal(reader.SSM_GET_PARAMETERS_LIMIT, 10);
  assert.ok(Array.isArray(reader.STAGE_CONTRACT_READ_PARAMETERS) && reader.STAGE_CONTRACT_READ_PARAMETERS.length > 0);
  assert.ok(Array.isArray(reader.STAGE_CONTRACT_READ_BATCHES) && reader.STAGE_CONTRACT_READ_BATCHES.length > 0);
  const source = await readFile(new URL('./vendor/stage-contract-parameters.mjs', import.meta.url), 'utf8');
  assert.match(source, /from '\.\/contracts\.mjs'/);
});

// Issue #166: the Service release slice is the Runtime stack, and #195 moved its
// deployment into Infra's restricted mutations entry. The vendored contract and
// operation table are the only place this repository learns the stack identity, so
// the pinned bytes must state Runtime, name the mutate workflow, and keep both
// disposable stacks out of the always-present manifest.
test('the vendored Runtime identity and the operation-owned stacks stay pinned', async () => {
  const stage = await import('./vendor/contracts.mjs');
  assert.equal(stage.SERVICE_RUNTIME_STACK.name, 'AnyWearRuntimeStack-beta');
  assert.equal(stage.SERVICE_RUNTIME_STACK.region, 'ap-east-1');
  assert.equal(stage.SERVICE_RUNTIME_STACK.workflow_path, '.github/workflows/mutate.yml');
  assert.equal(stage.runtimeStackName('beta'), 'AnyWearRuntimeStack-beta');
  assert.equal(stage.runtimeStageFromStack('AnyWearRuntimeStack-beta'), 'beta');
  // #207 retired the operation/deployment record chain and #191 re-sourced the
  // producer, so neither the record validators nor the Workload identity exists in
  // the pinned bytes. The reader census forbids naming the retired validators
  // outside the frozen diagnostic test, so this test asserts only the absence.
  assert.equal(stage.SERVICE_WORKLOAD_STACK, undefined);
  assert.equal(stage.workloadStageFromStack, undefined);
  const stacks = await import('./vendor/operation-stacks.mjs');
  assert.deepEqual(stacks.configuredStacks.map(({ stack_name: name }) => name),
    ['AnyWearFoundationStack', 'AnyWearPlatformStack-beta', 'AnyWearBillingStack-beta']);
  assert.deepEqual(stacks.operationOwnedStacks.map(({ stack_name: name }) => name),
    ['AnyWearEgressStack-beta', 'AnyWearRuntimeStack-beta']);
  assert.deepEqual(stacks.changedStackNames('deploy-runtime'), ['AnyWearRuntimeStack-beta']);
  assert.deepEqual(stacks.changedStackNames('stop-runtime'), ['AnyWearRuntimeStack-beta']);
  assert.deepEqual(stacks.changedStackNames('deploy-egress'), ['AnyWearEgressStack-beta']);
  assert.deepEqual(stacks.changedStackNames('delete-egress'), ['AnyWearEgressStack-beta']);
});

async function withVendoredCopy(action) {
  const directory = await mkdtemp(join(tmpdir(), 'anywear-vendor-'));
  try {
    const provenance = await loadVendoredProvenance();
    for (const name of Object.keys(provenance.files)) {
      await writeFile(join(directory, name), await readFile(new URL(`./vendor/${name}`, import.meta.url)));
    }
    await writeFile(join(directory, 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`);
    const root = pathToFileURL(`${directory}/`);
    await action({ directory, root, provenance });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('a modified vendored module is refused with the producer identity and actual hash', async () => {
  await withVendoredCopy(async ({ directory, root }) => {
    await writeFile(join(directory, 'deployment-contract.mjs'), 'export const tampered = true;\n');
    await assert.rejects(assertVendoredProvenance({ root }), new RegExp(`deployment-contract\\.mjs differs from git-malu/AnyWear-Infra@${SOURCE_SHA}`));
  });
});

test('an extra or missing vendored module is refused as a file-set drift', async () => {
  await withVendoredCopy(async ({ directory, root }) => {
    await writeFile(join(directory, 'extra.mjs'), 'export {};\n');
    await assert.rejects(assertVendoredProvenance({ root }), /file set differs from provenance/);
  });
  await withVendoredCopy(async ({ directory, root }) => {
    await rm(join(directory, 'json-contract.mjs'));
    await assert.rejects(assertVendoredProvenance({ root }), /file set differs from provenance/);
  });
});

test('a producer file without its declared rewrite is refused instead of being trusted as a copy', async () => {
  await withVendoredCopy(async ({ directory, root, provenance }) => {
    const missing = structuredClone(provenance);
    delete missing.import_rewrites['stage-contract-parameters.mjs'];
    await writeFile(join(directory, 'provenance.json'), `${JSON.stringify(missing, null, 2)}\n`);
    await assert.rejects(assertVendoredProvenance({ root }), /producer file stage-contract-parameters\.mjs has no declared import rewrite/);
  });
  await withVendoredCopy(async ({ directory, root, provenance }) => {
    const { import_rewrites: ignored, ...declarationless } = provenance;
    void ignored;
    await writeFile(join(directory, 'provenance.json'), `${JSON.stringify(declarationless, null, 2)}\n`);
    await assert.rejects(assertVendoredProvenance({ root }), /producer rewrite declarations are malformed/);
  });
  await withVendoredCopy(async ({ directory, root, provenance }) => {
    const undeclared = structuredClone(provenance);
    undeclared.import_rewrites['json-contract.mjs'] = [{ from: 'a', to: 'b' }];
    await writeFile(join(directory, 'provenance.json'), `${JSON.stringify(undeclared, null, 2)}\n`);
    await assert.rejects(assertVendoredProvenance({ root }), /import rewrite for json-contract\.mjs is undeclared in producer_files/);
  });
});

test('producer bytes declared next to an empty rewrite list are refused', async () => {
  await withVendoredCopy(async ({ directory, root, provenance }) => {
    const empty = structuredClone(provenance);
    empty.import_rewrites['stage-contract-parameters.mjs'] = [];
    await writeFile(join(directory, 'provenance.json'), `${JSON.stringify(empty, null, 2)}\n`);
    await assert.rejects(assertVendoredProvenance({ root }), /empty rewrite list with producer bytes/);
  });
});

test('a vendored file with no producer path is refused', async () => {
  await withVendoredCopy(async ({ directory, root, provenance }) => {
    const missing = structuredClone(provenance);
    delete missing.producer_paths['json-contract.mjs'];
    await writeFile(join(directory, 'provenance.json'), `${JSON.stringify(missing, null, 2)}\n`);
    await assert.rejects(assertVendoredProvenance({ root }), /producer_paths must cover exactly the files key set \(missing json-contract\.mjs/);
  });
  await withVendoredCopy(async ({ directory, root, provenance }) => {
    const extra = structuredClone(provenance);
    extra.producer_paths['extra.mjs'] = 'scripts/extra.mjs';
    await writeFile(join(directory, 'provenance.json'), `${JSON.stringify(extra, null, 2)}\n`);
    await assert.rejects(assertVendoredProvenance({ root }), /producer_paths names files that are not vendored \(extra\.mjs/);
  });
});

test('a package block is refused and names the retired artifact', async () => {
  await withVendoredCopy(async ({ directory, root, provenance }) => {
    const packaged = structuredClone(provenance);
    packaged.package = {
      name: '@example/retired-artifact',
      version: '1.2.3',
      source: 'packages/retired-artifact',
      sha256: '0'.repeat(64),
      tarball_commit: 'a'.repeat(40),
    };
    await writeFile(join(directory, 'provenance.json'), `${JSON.stringify(packaged, null, 2)}\n`);
    await assert.rejects(assertVendoredProvenance({ root }),
      /package block for the retired artifact @example\/retired-artifact@1\.2\.3/);
  });
});

test('a malformed rewrite declaration is refused', async () => {
  await withVendoredCopy(async ({ directory, root, provenance }) => {
    const malformed = structuredClone(provenance);
    malformed.import_rewrites['stage-contract-parameters.mjs'][0].to = '';
    await writeFile(join(directory, 'provenance.json'), `${JSON.stringify(malformed, null, 2)}\n`);
    await assert.rejects(assertVendoredProvenance({ root }), /import rewrite for stage-contract-parameters\.mjs is malformed/);
  });
});

test('bytes that move beyond the declared rewrite are refused even when the vendored hash is updated', async () => {
  await withVendoredCopy(async ({ directory, root, provenance }) => {
    // An extra, undeclared specifier rewrite: the committed file and its `files`
    // hash agree, but the reconstructed producer bytes no longer do.
    const doctored = (await readFile(join(directory, 'stage-contract-parameters.mjs'), 'utf8'))
      .replace('./json-contract.mjs', './json-contract-local.mjs');
    await writeFile(join(directory, 'stage-contract-parameters.mjs'), doctored);
    provenance.files['stage-contract-parameters.mjs'] = byteHash(Buffer.from(doctored));
    await writeFile(join(directory, 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`);
    await assert.rejects(assertVendoredProvenance({ root }), /differs from its raw git-malu\/AnyWear-Infra@\w+ producer bytes beyond the declared import rewrites/);
  });
  await withVendoredCopy(async ({ directory, root, provenance }) => {
    // A declared rewrite that no longer appears cannot be reversed deterministically.
    const rewritten = (await readFile(join(directory, 'stage-contract-parameters.mjs'), 'utf8'))
      .replace("from './contracts.mjs'", "from './contracts-copy.mjs'");
    await writeFile(join(directory, 'stage-contract-parameters.mjs'), rewritten);
    provenance.files['stage-contract-parameters.mjs'] = byteHash(Buffer.from(rewritten));
    await writeFile(join(directory, 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`);
    await assert.rejects(assertVendoredProvenance({ root }), /import rewrite for stage-contract-parameters\.mjs is not applied exactly once/);
  });
});

test('a malformed provenance source identity is refused before any module is trusted', async () => {
  await withVendoredCopy(async ({ directory, root, provenance }) => {
    await writeFile(join(directory, 'provenance.json'), JSON.stringify({ ...provenance, source_repository: 'other/Infra' }));
    await assert.rejects(loadVendoredProvenance({ root }), /source repository is unexpected/);
    await writeFile(join(directory, 'provenance.json'), JSON.stringify({ ...provenance, source_sha: 'main' }));
    await assert.rejects(loadVendoredProvenance({ root }), /source SHA is malformed/);
  });
});
