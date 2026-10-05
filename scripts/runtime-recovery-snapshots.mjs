import { pathToFileURL } from 'node:url';

// The complete drill currently needs at most 202 saves. Leave room below 500 artifacts/job.
export const MAX_RECOVERY_SNAPSHOTS = 400;

export function validateRecoverySnapshot(value) {
  if (typeof value !== 'string' || !/^[0-9]{3}$/.test(value) || Number(value) < 1 || Number(value) > MAX_RECOVERY_SNAPSHOTS) {
    throw new Error('Invalid bounded recovery snapshot');
  }
  return value;
}

export function validateRecoverySourceInputs(environment) {
  if (!/^[1-9][0-9]{0,19}$/.test(environment.SOURCE_RUN_ID ?? '')
    || !/^[1-9][0-9]{0,5}$/.test(environment.SOURCE_RUN_ATTEMPT ?? '')) throw new Error('Invalid source run');
  validateRecoverySnapshot(environment.SOURCE_SNAPSHOT);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  validateRecoverySourceInputs(process.env);
}
