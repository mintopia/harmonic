/** Resolve on the next event-loop turn, after pending I/O callbacks run. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

export interface YieldOptions {
  /** Maximum wall-clock ms to run synchronously before yielding; can overrun by one item. Default 25ms. */
  budgetMs?: number;
  /** Monotonic clock injection for deterministic tests. Default `Date.now`. */
  now?: () => number;
  /** Yield primitive injection for tests. Default {@link yieldToEventLoop}. */
  yieldNow?: () => Promise<void>;
}

/** Iterate `items`, awaiting `fn` for each, yielding to the event loop whenever the synchronous slice exceeds `budgetMs`. */
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
