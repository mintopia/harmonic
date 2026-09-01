import type { TrackerAdapter } from './adapter.js';

/**
 * Close a completed Epic's tracker issue (#442). ADR-0004 keeps tracker closure
 * input-only for Tasks — the tracker is an inbound fact source and Harmonic's own
 * verify+merge is the success signal, not the ticket state. An Epic container runs
 * no agent, so nothing on the Task path would ever close it; Harmonic closes it
 * here once the whole-Epic integrate settles (a no-op/empty-diff finish included).
 *
 * Best-effort and idempotent, mirroring the Task close (`auto-drive.closeTicket`):
 * a tracker without lifecycle writes (`close` absent) stays an inbound-only source,
 * and an already-closed issue is left alone — closing a closed issue errors on some
 * trackers (`gh issue close`).
 */
export async function closeIntegratedEpic(adapter: TrackerAdapter, epicRef: number): Promise<void> {
  if (!adapter.close) return;
  const ref = { number: epicRef, title: '', state: 'open' as const };
  if ((await adapter.readTicket(ref)).state === 'closed') return;
  await adapter.close(ref, 'Epic integrated by Harmonic.');
}

/**
 * Settle a completed Epic's stored record, then close its tracker issue (#442) —
 * the whole `recordIntegration` effect, extracted so both funnel paths (real merge
 * and no-op finish) share one tested unit.
 *
 * `settle` (the once-only `markEpicIntegrated`) runs first and its failure
 * propagates — the integrate coordinator treats an unrecorded settle as a retryable
 * miss. The close is a pure output side-effect: it runs best-effort so a tracker
 * error never undoes the already-settled record, and idempotently so a replayed
 * poll (the settle is a no-op the second time, but this still runs) re-reads live
 * state and closes nothing twice.
 */
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
