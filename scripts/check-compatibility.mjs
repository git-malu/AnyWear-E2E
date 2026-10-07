import { readFile } from 'node:fs/promises';
import { parseStrictJson, validateCompatibility } from './evidence-contract.mjs';

const path = process.argv.find((argument) => argument.startsWith('--file='))?.slice(7)
  ?? new URL('../compatibility.json', import.meta.url);
const manifest = validateCompatibility(parseStrictJson(await readFile(path)), {
  // Existing legacy pins remain valid for offline source checks. Runtime
  // workflows explicitly require v2 before collecting any new Infra evidence.
  allowLegacy: !process.argv.includes('--require-infra'),
});
console.log(`Compatibility v${manifest.version}: Client ${manifest.client.sha.slice(0, 7)}, Service ${manifest.service.sha.slice(0, 7)}${manifest.infra ? `, Infra ${manifest.infra.sha.slice(0, 7)}` : ''}`);
