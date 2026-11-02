// The committed reviewed Client floor. The runtime module validates the exact key set,
// so `version` is the only member this declaration carries.
export interface MinimumSupportedClient {
  version: number;
}

export const MINIMUM_SUPPORTED_CLIENT_PATH: 'minimum-supported-client.json';
export const MINIMUM_SUPPORTED_CLIENT_KEYS: readonly ['version'];
export const MINIMUM_SUPPORTED_CLIENT_SOURCE: 'minimum-supported-client.json';

export function validateMinimumSupportedClient(value: unknown): MinimumSupportedClient;
export function readMinimumSupportedClient(root?: string): MinimumSupportedClient;
export function assertLiveClientFloor(
  deployed: { clientVersion: number; minimumClientVersion: number },
  floor: MinimumSupportedClient,
): MinimumSupportedClient;
