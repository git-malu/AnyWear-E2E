import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseStrictJson, validateCompatibility } from './evidence-contract.mjs';
import { ghApi, loadTrustedInputs } from './trusted-deployment-inputs.mjs';

const inputIndex = process.argv.indexOf('--reviewed-input');
if (inputIndex < 0 || !process.argv[inputIndex + 1]) throw new Error('Usage: node scripts/migrate-compatibility.mjs --reviewed-input <exact-reviewed-v2.json>');
const candidate = validateCompatibility(parseStrictJson(await readFile(resolve(process.argv[inputIndex + 1]))));
for (const component of ['client', 'service', 'infra']) {
  const entry = candidate[component];
  const commit = parseStrictJson(ghApi(`repos/${entry.repository}/commits/${entry.sha}`));
  if (commit.sha !== entry.sha) throw new Error(`Reviewed ${component} commit does not exist on its remote`);
}
await loadTrustedInputs(candidate, resolve('.qualification-inputs'));
await writeFile(new URL('../compatibility.json', import.meta.url), `${JSON.stringify(candidate, null, 2)}\n`);
console.log('Wrote the explicitly supplied v2 tuple; review and commit its diff before runtime execution.');
