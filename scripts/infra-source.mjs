import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { repositories, validateCompatibility } from './evidence-contract.mjs';

export function reviewedInfraSource(compatibility, environment = process.env) {
  validateCompatibility(compatibility);
  const directory = resolve(environment.QUALIFICATION_INFRA_DIR ?? '.infra-source');
  const git = args => execFileSync('git', ['-C', directory, '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', ...args], {
    encoding: 'utf8', env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
  }).trim();
  if (realpathSync(git(['rev-parse', '--show-toplevel'])) !== realpathSync(directory)) throw new Error('Infra helper path must be the exact repository root');
  const head = git(['rev-parse', 'HEAD']);
  if (head !== compatibility.infra.sha) throw new Error('Infra helper does not match the reviewed immutable revision');
  if (git(['for-each-ref', '--format=%(refname)', 'refs/replace'])) throw new Error('Infra helper has Git replacement refs');
  if (git(['ls-files', '-v']).split('\n').some(line => /^[a-zS]/.test(line))) throw new Error('Infra helper checkout hides tracked changes through Git index flags');
  if (git(['status', '--porcelain', '--untracked-files=all'])) throw new Error('Reviewed Infra checkout has local changes');
  const remote = git(['remote', 'get-url', 'origin']);
  if (remote !== `https://github.com/${repositories.infra}` && remote !== `https://github.com/${repositories.infra}.git`) throw new Error('Unexpected Infra helper repository');
  return directory;
}
