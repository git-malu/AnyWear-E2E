import { execFileSync } from 'node:child_process';
import { repositories } from './evidence-contract.mjs';

// The retained read-only GitHub helpers. They are the credential seam for every
// non-AWS read this repository performs: the recovery owner artifact, the cleanup
// diagnostic evidence and the immutable Service release that qualification verifies.
// They were carved out of the retired deployment-record consumer
// (`trusted-deployment-inputs.mjs`) unchanged, so `recover` keeps working after the
// pin/record download chain is gone (#180).

// Each reader is scoped to exactly one repository: the token that can read that
// repository is renamed to GH_TOKEN for the duration of the command, and every other
// reader token is removed from the child environment. A reader therefore cannot
// reach another repository with a token it was not given.
export function repositoryReadEnvironment(repository, environment = process.env) {
  const input = new Map([
    [repositories.infra, 'GH_TOKEN'],
    [repositories.service, 'SERVICE_ARTIFACT_READ_TOKEN'],
    [repositories.client, 'CLIENT_CONTENTS_READ_TOKEN'],
  ]).get(repository);
  if (!input) throw new Error('Unexpected repository for scoped evidence access');
  if (!environment[input]?.trim()) throw new Error(`${input} required for ${repository} read access`);
  const scoped = { ...environment, GH_TOKEN: environment[input] };
  for (const key of ['GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN',
    'E2E_EVIDENCE_READ_TOKEN', 'INFRA_EVIDENCE_READ_TOKEN', 'SERVICE_ARTIFACT_READ_TOKEN',
    'CLIENT_CONTENTS_READ_TOKEN']) delete scoped[key];
  return scoped;
}

export function ghApi(path, binary = false, environment = process.env, { execute = execFileSync, binaryAccept } = {}) {
  // Actions artifact ZIP API endpoints accept JSON before redirecting to raw ZIP
  // bytes, while release assets require octet-stream to return the asset itself.
  const accept = binary
    ? binaryAccept ?? (/\/actions\/artifacts\/\d+\/zip$/.test(path) ? 'application/json'
      : /\/releases\/assets\/\d+$/.test(path) ? 'application/octet-stream' : undefined)
    : 'application/vnd.github+json';
  if (!accept || (binary && !['application/json', 'application/octet-stream'].includes(accept))) {
    throw new Error('Unsupported binary GitHub API response type');
  }
  return execute('gh', ['api', path, '-H', `Accept: ${accept}`], {
    encoding: binary ? undefined : 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 60_000,
    stdio: ['ignore', 'pipe', 'pipe'], env: environment,
  });
}
