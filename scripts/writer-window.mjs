import { pathToFileURL } from 'node:url';
import { requireCommit, requireString } from './evidence-contract.mjs';

export function assertE2EWriterWindow(environment = process.env) {
  if (environment.GITHUB_REPOSITORY !== 'git-malu/AnyWear-E2E'
    || environment.GITHUB_REF !== 'refs/heads/main'
    || environment.GITHUB_EVENT_NAME !== 'workflow_dispatch'
    || environment.E2E_STAGE !== 'beta') throw new Error('E2E cloud operations require protected main Beta workflow_dispatch');
  if (environment.ENABLE_INFRA_E2E !== 'true') throw new Error('Infra E2E activation gate is closed');
  const sha = requireCommit(environment.GITHUB_SHA, 'Current E2E revision');
  if (environment.E2E_WRITER_SHA !== sha
    || environment.E2E_WRITER_RUN_ID !== requireString(environment.GITHUB_RUN_ID, 'GITHUB_RUN_ID')
    || environment.E2E_WRITER_RUN_ATTEMPT !== requireString(environment.GITHUB_RUN_ATTEMPT, 'GITHUB_RUN_ATTEMPT')) {
    throw new Error('E2E writer allocation does not match this exact run/attempt/revision');
  }
  if (!/^[1-9]\d*$/.test(environment.GITHUB_RUN_ID) || !/^[1-9]\d*$/.test(environment.GITHUB_RUN_ATTEMPT)) throw new Error('Invalid writer run identity');
  const expires = Date.parse(requireString(environment.E2E_WRITER_EXPIRES_AT, 'E2E_WRITER_EXPIRES_AT'));
  if (!Number.isFinite(expires) || expires <= Date.now()) throw new Error('E2E writer window expired');
  requireString(environment.E2E_WRITER_WINDOW_TOKEN, 'E2E_WRITER_WINDOW_TOKEN');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(environment.E2E_WRITER_WINDOW_TOKEN)) throw new Error('Invalid writer window token');
  if (environment.E2E_WRITER_WINDOW_TOKEN !== environment.E2E_EXPECTED_WRITER_WINDOW_TOKEN) throw new Error('E2E writer window token mismatch');
  if (!/^https:\/\/github\.com\/git-malu\/AnyWear\/issues\/54#issuecomment-[1-9]\d*$/.test(environment.E2E_WRITER_RECORD_URL ?? '')) throw new Error('Missing manager writer allocation evidence');
  if (environment.AWS_ACCOUNT_ID !== '650880818323' || environment.AWS_REGION !== 'ap-east-1') throw new Error('Unexpected writer account/region');
  requireCommit(environment.E2E_CLEANUP_SERVICE_SHA, 'Reviewed Service cleanup operator source');
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assertE2EWriterWindow();
  console.log('Verified the manager-assigned E2E writer window; external writer cessation is a separate release gate.');
}
