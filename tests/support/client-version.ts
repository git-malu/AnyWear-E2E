import { readMinimumSupportedClient } from '../../scripts/minimum-supported-client.mjs';

/**
 * The Client identity header every direct Service request in this suite carries (#256).
 *
 * The deployed Service refuses a request below its release floor with HTTP 400
 * `CLIENT_VERSION_UNSUPPORTED`, so at a floor above 0 a headerless request fails. The
 * value is the committed reviewed floor in `minimum-supported-client.json`, never a
 * literal: the deployed Service's own `/health.minimum_client_version` must equal it,
 * and qualification refuses the disagreement instead of sending a guessed version.
 *
 * The record is read from the committed file at module load only. Discovery and the
 * offline checks load every spec with no E2E environment, so this module must not read
 * one. Merge the record into an existing headers object:
 *
 *   headers: { ...CLIENT_VERSION_HEADERS, Authorization: authorization }
 */
export const CLIENT_VERSION_HEADER = 'X-AnyWear-Client-Version';

export const CLIENT_VERSION_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  [CLIENT_VERSION_HEADER]: String(readMinimumSupportedClient().version),
});
