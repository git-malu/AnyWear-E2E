import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { exactKeys, parseStrictJson } from './evidence-contract.mjs';
import { repositoryRoot } from './test-selection.mjs';

// #180/#256: the reviewed Client floor is the one small committed file the live path
// still reads. It is not a tuple identity and not a pre-submitted copy of the live
// deployment: the floor version is the deployed Service's own
// `/health.minimum_client_version`, and this file states the reviewed floor version the
// suite must meet. Qualification refuses a disagreement instead of picking the oldest
// version itself, so a deployment that raises the floor cannot be qualified against a
// stale file, and a file that moves ahead of the deployment cannot silently qualify
// either. The file names no Client commit: the oldest-Client qualification leg that read
// a `sha` is deleted, and the exact-key check below refuses a leftover `sha` instead of
// ignoring it.
export const MINIMUM_SUPPORTED_CLIENT_PATH = 'minimum-supported-client.json';
export const MINIMUM_SUPPORTED_CLIENT_KEYS = Object.freeze(['version']);
export const MINIMUM_SUPPORTED_CLIENT_SOURCE = MINIMUM_SUPPORTED_CLIENT_PATH;

export function validateMinimumSupportedClient(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${MINIMUM_SUPPORTED_CLIENT_PATH} must be an object`);
  }
  exactKeys(value, [...MINIMUM_SUPPORTED_CLIENT_KEYS], MINIMUM_SUPPORTED_CLIENT_PATH);
  if (!Number.isSafeInteger(value.version) || value.version < 0) {
    throw new Error(`${MINIMUM_SUPPORTED_CLIENT_PATH}.version must be a non-negative safe integer`);
  }
  return value;
}

// Read and validate the committed floor. A missing or malformed file refuses instead
// of defaulting to version 0: an absent floor would qualify an unstated Client.
export function readMinimumSupportedClient(root = repositoryRoot) {
  const path = resolve(root, MINIMUM_SUPPORTED_CLIENT_PATH);
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    throw new Error(`${MINIMUM_SUPPORTED_CLIENT_PATH} is unreadable at ${path}; the live floor comparison and the rejection-contract scenario require it (${error.code ?? error.message})`, { cause: error });
  }
  let value;
  try {
    value = parseStrictJson(bytes);
  } catch (error) {
    throw new Error(`${MINIMUM_SUPPORTED_CLIENT_PATH} is not strict JSON (${error.message})`, { cause: error });
  }
  return validateMinimumSupportedClient(value);
}

// The live comparison. The Service states the floor it enforces and the Client states
// the version it built; the committed file states the reviewed floor. The Service's
// value must equal the file exactly, and the deployed Client must meet it. Every
// refusal names the observed and the expected value and says which file to sync.
export function assertLiveClientFloor({ clientVersion, minimumClientVersion }, floor) {
  validateMinimumSupportedClient(floor);
  if (!Number.isSafeInteger(clientVersion) || clientVersion < 0) {
    throw new Error('Deployed Client client_version must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(minimumClientVersion) || minimumClientVersion < 0) {
    throw new Error('Deployed Service minimum_client_version must be a non-negative safe integer');
  }
  if (minimumClientVersion !== floor.version) {
    throw new Error(`Deployed Service minimum_client_version ${minimumClientVersion} differs from ${MINIMUM_SUPPORTED_CLIENT_PATH} version ${floor.version} (observed ${minimumClientVersion}, expected ${floor.version}); sync ${MINIMUM_SUPPORTED_CLIENT_PATH} with the deployed Service floor and re-dispatch`);
  }
  if (clientVersion < floor.version) {
    throw new Error(`Deployed Client client_version ${clientVersion} is below ${MINIMUM_SUPPORTED_CLIENT_PATH} version ${floor.version} (observed ${clientVersion}, expected at least ${floor.version}); deploy a Client that meets the floor or sync the reviewed floor file`);
  }
  return floor;
}
