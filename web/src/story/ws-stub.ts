/* eslint-disable */
import { criticLog } from './fixtures';

export function subscribe(_fn: (msg: any) => void) {
  return () => {};
}
export function subscribeAttemptLog(_opts: any) {
  return () => {};
}
export function subscribeCriticLog(opts: { onEvent: (event: any) => void }) {
  // Replay the fixture critic transcript so a running-critic story renders the
  // same live chat the real critic-log channel streams.
  queueMicrotask(() => criticLog.forEach((event: any) => opts.onEvent(event)));
  return () => {};
}
