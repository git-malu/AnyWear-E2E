// Independent source review passed; live execution still requires every protected workflow gate.
export const LIVE_RUNTIME_SOURCE_READY = true;

export function assertLiveRuntimeSourceReady() {
  if (!LIVE_RUNTIME_SOURCE_READY) throw new Error('Live runtime source is not ready: cloud mutations are disabled pending complete review');
}
