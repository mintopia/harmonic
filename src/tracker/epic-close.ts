import type { TrackerAdapter } from './adapter.js';

/** Close an integrated Epic's tracker issue; idempotent, since `gh issue close` errors on an already-closed issue. */
export async function closeIntegratedEpic(adapter: TrackerAdapter, epicRef: number): Promise<void> {
  if (!adapter.close) return;
  const ref = { number: epicRef, title: '', state: 'open' as const };
  if ((await adapter.readTicket(ref)).state === 'closed') return;
  await adapter.close(ref, 'Epic integrated by Harmonic.');
}

/** Settle the stored Epic record (failure propagates), then close its tracker issue best-effort. */
export async function recordAndCloseIntegratedEpic(deps: {
  epicRef: number;
  settle: () => Promise<void>;
  resolveAdapter: () => Promise<TrackerAdapter>;
  onError: (msg: string) => void;
}): Promise<void> {
  await deps.settle();
  try {
    await closeIntegratedEpic(await deps.resolveAdapter(), deps.epicRef);
  } catch (err) {
    deps.onError(`epic ${deps.epicRef} tracker issue close failed: ${String(err)}`);
  }
}
