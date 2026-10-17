import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { assertVendoredProvenance, loadVendoredProvenance } from './vendored-contract.mjs';

test('the vendored v3 contract matches its pinned producer commit and file hashes', async () => {
  const provenance = await loadVendoredProvenance();
  assert.equal(provenance.source_repository, 'git-malu/AnyWear-Infra');
  assert.equal(provenance.source_sha, 'bab0b6a69ad27f86f405c80f34f588044f28adc4');
  assert.equal(provenance.final_c_sha, 'fc0e23a7efc832562559ae465d06f68a7bf94126');
  assert.deepEqual(Object.keys(provenance.files).sort(), ['deployment-contract.mjs', 'json-contract.mjs', 'operation-stacks.mjs']);
  assert.deepEqual(await assertVendoredProvenance(), provenance);
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
    await assert.rejects(assertVendoredProvenance({ root }), /deployment-contract\.mjs differs from git-malu\/AnyWear-Infra@bab0b6a/);
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

test('a malformed provenance source identity is refused before any module is trusted', async () => {
  await withVendoredCopy(async ({ directory, root, provenance }) => {
    await writeFile(join(directory, 'provenance.json'), JSON.stringify({ ...provenance, source_repository: 'other/Infra' }));
    await assert.rejects(loadVendoredProvenance({ root }), /source repository is unexpected/);
    await writeFile(join(directory, 'provenance.json'), JSON.stringify({ ...provenance, source_sha: 'main' }));
    await assert.rejects(loadVendoredProvenance({ root }), /source SHA is malformed/);
  });
});
