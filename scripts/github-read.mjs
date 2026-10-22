import { execFileSync } from 'node:child_process';
import { parseStrictJson, repositories } from './evidence-contract.mjs';

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

// GitHub Actions artifact ZIP reads accept JSON before redirecting to raw ZIP bytes.
// Release assets are deliberately not readable through this seam (#193): the Service
// release identity is the release API document and the tag it resolves to, never an
// asset body, so no caller can download a release asset here.
export function ghApi(path, binary = false, environment = process.env, { execute = execFileSync } = {}) {
  if (binary && !/\/actions\/artifacts\/\d+\/zip$/.test(path)) {
    throw new Error('Unsupported binary GitHub API response type');
  }
  return execute('gh', ['api', path, '-H', `Accept: ${binary ? 'application/json' : 'application/vnd.github+json'}`], {
    encoding: binary ? undefined : 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 60_000,
    stdio: ['ignore', 'pipe', 'pipe'], env: environment,
  });
}

// #193: a release tag is a git ref, and an annotated tag points at a tag object before
// it reaches the commit it names. Resolve the chain with the documented REST reads —
// one `git/ref/tags/<tag>` read plus one `git/tags/<sha>` read per annotated-tag
// dereference — and refuse a chain deeper than the issue's bound or one that ends in a
// non-commit. Nothing here reads a release asset.
export const TAG_DEREF_LIMIT = 4;
const GIT_SHA = /^[0-9a-f]{40}$/;

const describe = (value) => {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

function requireGitObject(object, label) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) throw new Error(`${label} is malformed`);
  if (typeof object.type !== 'string' || object.type.length === 0) throw new Error(`${label} type is required`);
  if (typeof object.sha !== 'string' || !GIT_SHA.test(object.sha)) throw new Error(`${label} sha ${describe(object.sha)} is not a full lowercase 40-character object SHA`);
  return object;
}

function readFailure(error) {
  return String(error.message ?? error).split('\n')[0];
}

export async function resolveTagCommit({ repository, tag, api = ghApi, environment = process.env, label = 'Tag' } = {}) {
  let object;
  try {
    object = parseStrictJson(await api(`repos/${repository}/git/ref/tags/${tag}`, false, environment))?.object;
  } catch (error) {
    throw new Error(`${label} ${tag} could not be read from ${repository} (${readFailure(error)})`, { cause: error });
  }
  object = requireGitObject(object, `${label} ${tag} ref object`);
  let dereferences = 0;
  while (object.type !== 'commit') {
    if (object.type !== 'tag') throw new Error(`${label} ${tag} resolves to a ${object.type} object, not a commit`);
    if (dereferences >= TAG_DEREF_LIMIT) {
      throw new Error(`${label} ${tag} annotated-tag chain exceeds ${TAG_DEREF_LIMIT} dereferences`);
    }
    dereferences += 1;
    const annotatedSha = object.sha;
    try {
      object = parseStrictJson(await api(`repos/${repository}/git/tags/${annotatedSha}`, false, environment))?.object;
    } catch (error) {
      throw new Error(`${label} ${tag} annotated tag ${annotatedSha} could not be read from ${repository} (${readFailure(error)})`, { cause: error });
    }
    object = requireGitObject(object, `${label} ${tag} annotated tag ${annotatedSha} object`);
  }
  return { commit: object.sha, dereferences };
}
