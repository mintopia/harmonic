/**
 * Cooperative event-loop yielding for background loops and heavy in-request
 * work (issue #200 / ADR-0029 §5).
 *
 * Harmonic runs on a single Node event loop, shared by every HTTP handler and
 * every background loop. A loop that runs
 * unbounded JS between `await`s starves every in-flight request until it
 * finishes. These helpers let such a loop hand the loop back on a wall-clock
 * budget, so it never blocks for more than ~`budgetMs` at a stretch however
 * many items it processes.
 */

/** Resolve on the next event-loop turn, after pending I/O callbacks run. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

export interface YieldOptions {
  /**
   * Maximum wall-clock ms to run synchronously before yielding. The loop can
   * still overrun by one item's cost past this bound (the check is between
   * items), so keep item work itself small. Default 25ms.
   */
  budgetMs?: number;
  /** Monotonic clock injection for deterministic tests. Default `Date.now`. */
  now?: () => number;
  /** Yield primitive injection for tests. Default {@link yieldToEventLoop}. */
  yieldNow?: () => Promise<void>;
}

/**
 * Iterate `items`, awaiting `fn` for each, and yield to the event loop whenever
 * the current synchronous slice has held the thread past `budgetMs`. Bounds the
 * longest uninterrupted block to roughly `budgetMs`, independent of item count.
 */
export async function forEachYielding<T>(
  items: Iterable<T>,
  fn: (item: T, index: number) => void | Promise<void>,
  options: YieldOptions = {},
): Promise<void> {
  const budgetMs = options.budgetMs ?? 25;
  const now = options.now ?? Date.now;
  const yieldNow = options.yieldNow ?? yieldToEventLoop;
  let sliceStart = now();
  let index = 0;
  for (const item of items) {
    await fn(item, index++);
    if (now() - sliceStart >= budgetMs) {
      await yieldNow();
      sliceStart = now();
    }
  }
}
