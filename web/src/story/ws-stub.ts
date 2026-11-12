/* eslint-disable */
export function subscribe(_fn: (msg: any) => void) {
  return () => {};
}
export function subscribeAttemptLog(_opts: any) {
  return () => {};
}
export function subscribeConnectionState(_listener: () => void) {
  return () => {};
}
export function getConnectionState() {
  return 'connected' as const;
}

export function subscribeFiles(_workspaceId: number): () => void {
  return () => {};
}
