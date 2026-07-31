import { readFile } from 'node:fs/promises';

const manifestUrl = new URL('../compatibility.json', import.meta.url);
const expectedRepositories = {
  client: 'git-malu/AnyWear-Client',
  service: 'git-malu/AnyWear-Service',
};
const commitPattern = /^[0-9a-f]{40}$/;

const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));
const errors = [];

if (manifest.version !== 1) {
  errors.push('version must be 1');
}

for (const [component, repository] of Object.entries(expectedRepositories)) {
  const entry = manifest[component];
  if (!entry || typeof entry !== 'object') {
    errors.push(`${component} entry is required`);
    continue;
  }
  if (entry.repository !== repository) {
    errors.push(`${component}.repository must be ${repository}`);
  }
  if (typeof entry.sha !== 'string' || !commitPattern.test(entry.sha)) {
    errors.push(`${component}.sha must be a full lowercase 40-character commit SHA`);
  }
}

if (errors.length > 0) {
  throw new Error(`Invalid compatibility.json:\n- ${errors.join('\n- ')}`);
}

console.log(
  `Compatibility set: Client ${manifest.client.sha.slice(0, 7)}, Service ${manifest.service.sha.slice(0, 7)}`,
);
