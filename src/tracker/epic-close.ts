import type { TrackerAdapter, TrackerRef } from './adapter.js';
import { safeErrorReason } from './rest-client.js';

/** Close an integrated Epic's tracker issue; idempotent, since `gh issue close` errors on an already-closed issue. False when the tracker cannot close. */
export async function closeIntegratedEpic(adapter: TrackerAdapter, epicRef: TrackerRef, comment = 'Epic integrated by Harmonic.'): Promise<boolean> {
  if (!adapter.close) return false;
  const ref = { ref: epicRef, title: '', state: 'open' as const };
  if ((await adapter.readTicket(ref)).state === 'closed') return true;
  await adapter.close(ref, comment);
  return true;
}

/** Settle the stored Epic record (failure propagates), then close its tracker issue best-effort. */
export async function recordAndCloseIntegratedEpic(deps: {
  epicRef: TrackerRef;
  settle: () => Promise<void>;
  resolveAdapter: () => Promise<TrackerAdapter>;
  onError: (msg: string) => void;
}): Promise<void> {
  await deps.settle();
  try {
    await closeIntegratedEpic(await deps.resolveAdapter(), deps.epicRef);
  } catch (err) {
    deps.onError(`epic ${deps.epicRef} tracker issue close failed: ${safeErrorReason(err)}`);
  }
}
