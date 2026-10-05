export function isTerminalTaggingStatus(status: string): boolean {
  return status === 'ready' || status === 'failed';
}
