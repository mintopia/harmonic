/**
 * Loops-must-yield: the cooperative-yielding helper for background loops.
 *
 * **The rule (ADR-0029 §5, issue #211).** Harmonic runs every HTTP handler and
 * every background loop — boot sweeps, periodic polls, reconcile passes, the
 * Auto-Runner fill — on one Node event loop. An unbounded *synchronous* sweep
 * over a collection whose size grows with the database or the workload blocks the
 * whole process: every in-flight and incoming request stalls until the sweep
 * returns. That is exactly the failure #200 documents. So any such loop MUST
 * chunk its synchronous work and yield the event loop between chunks, turning one
 * multi-second stall into many sub-frame slices with I/O interleaved.
 *
 * Reach for {@link forEachYielding} for the common iterate-and-process case; call
 * {@link yieldToEventLoop} directly at a hand-rolled chunk boundary (e.g. a
 * `while` loop or a nested walk).
 *
 * This bounds *CPU time* on the loop. It is orthogonal to bounding *retries* /
 * subprocess spawns (issue #219 — bounded attempts + backoff + escalate-once) and
 * to routing heavy aggregate *reads* through the async path (issue #213); a loop
 * may need all three.
 */

/** Chunk before more than this many ms of uninterrupted synchronous work. */
const DEFAULT_BUDGET_MS = 10;

/**
 * Yield control back to the event loop for one turn, then resume.
 *
 * Uses `setImmediate`, which fires *after* the I/O callback phase, so any request
 * or timer that became ready while the caller held the loop gets to run before
 * the caller's next chunk of synchronous work.
 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

export interface ForEachYieldingOptions {
  /**
   * Maximum uninterrupted synchronous time, in ms, before the loop yields.
   * Kept well under the event-loop stall budget so a slice never reads as a
   * stall. Default {@link DEFAULT_BUDGET_MS}.
   */
  budgetMs?: number;
  /** Clock source; injected in tests for deterministic slicing. Default `Date.now`. */
  now?: () => number;
  /** Yield primitive; injected in tests. Default {@link yieldToEventLoop}. */
  yield?: () => Promise<void>;
}

/**
 * Iterate `items`, invoking `fn` per element, and yield the event loop whenever a
 * slice of uninterrupted work has run for longer than `budgetMs`. `fn` may be
 * async (it is awaited before the next element), so a naturally-awaiting loop
 * yields on its own I/O and rarely trips the time budget — the budget is the
 * backstop for the CPU-bound case.
 *
 * The slice clock resets after each yield, so cost is one yield per `budgetMs` of
 * work regardless of item count.
 */
export async function forEachYielding<T>(
  items: Iterable<T>,
  fn: (item: T, index: number) => void | Promise<void>,
  options: ForEachYieldingOptions = {},
): Promise<void> {
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  const now = options.now ?? Date.now;
  const doYield = options.yield ?? yieldToEventLoop;

  let sliceStart = now();
  let index = 0;
  for (const item of items) {
    await fn(item, index);
    index += 1;
    if (now() - sliceStart >= budgetMs) {
      await doYield();
      sliceStart = now();
    }
  }
}
