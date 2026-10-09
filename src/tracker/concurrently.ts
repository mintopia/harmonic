import { forEachYielding } from '../reliability/yield.js';

/** {@link forEachYielding} across `concurrency` workers draining one shared queue. */
export async function forEachConcurrently<T>(items: readonly T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = items[Symbol.iterator]();
  const shared: Iterable<T> = { [Symbol.iterator]: () => queue };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => forEachYielding(shared, fn)));
}

export const DEPENDENCY_CONCURRENCY = 4;
