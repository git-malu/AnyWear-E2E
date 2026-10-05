// Kept closed until the complete non-paid controls/recovery source passes independent review.
export const LIVE_RUNTIME_SOURCE_READY = false;

export function assertLiveRuntimeSourceReady() {
  if (!LIVE_RUNTIME_SOURCE_READY) throw new Error('Live runtime source is not ready: cloud mutations are disabled pending complete review');
}
