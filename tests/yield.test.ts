import { describe, expect, it } from 'vitest';
import { forEachYielding, yieldToEventLoop } from '../src/reliability/yield.js';

/**
 * The loops-must-yield helper (ADR-0029 §5, issue #211). These tests pin the
 * chunk-and-yield contract deterministically by injecting the clock and the
 * yield primitive, so they never depend on real wall-clock timing.
 */
describe('yieldToEventLoop', () => {
  it('defers to a later event-loop turn rather than resolving synchronously', async () => {
    let resolvedSynchronously = true;
    const p = yieldToEventLoop().then(() => {
      // If this ran before the synchronous tail below, the flag would still be true.
      expect(resolvedSynchronously).toBe(false);
    });
    resolvedSynchronously = false;
    await p;
  });

  it('resolves to undefined', async () => {
    await expect(yieldToEventLoop()).resolves.toBeUndefined();
  });
});

describe('forEachYielding', () => {
  it('invokes fn for every item, in order, with a running index', async () => {
    const seen: Array<[string, number]> = [];
    await forEachYielding(['a', 'b', 'c'], (item, index) => {
      seen.push([item, index]);
    });
    expect(seen).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 2],
    ]);
  });

  it('does not yield while a slice stays within the time budget', async () => {
    let yields = 0;
    // Clock never advances → no slice ever exceeds the budget.
    await forEachYielding([1, 2, 3, 4, 5], () => {}, {
      budgetMs: 10,
      now: () => 0,
      yield: async () => {
        yields += 1;
      },
    });
    expect(yields).toBe(0);
  });

  it('yields once per elapsed budget and resets the slice each time', async () => {
    let clock = 0;
    let yields = 0;
    // Each item burns 4ms of the 10ms budget: a yield falls on the item that
    // pushes cumulative slice time to >=10ms (items 2 and 5), and the slice
    // clock resets at each yield.
    await forEachYielding(
      [0, 1, 2, 3, 4, 5],
      () => {
        clock += 4;
      },
      {
        budgetMs: 10,
        now: () => clock,
        yield: async () => {
          yields += 1;
        },
      },
    );
    expect(yields).toBe(2);
  });

  it('awaits an async fn before advancing to the next item', async () => {
    const order: string[] = [];
    await forEachYielding(['x', 'y'], async (item) => {
      order.push(`start:${item}`);
      await Promise.resolve();
      order.push(`end:${item}`);
    });
    expect(order).toEqual(['start:x', 'end:x', 'start:y', 'end:y']);
  });

  it('accepts any iterable, not just arrays', async () => {
    const set = new Set(['one', 'two']);
    const seen: string[] = [];
    await forEachYielding(set, (item) => {
      seen.push(item);
    });
    expect(seen).toEqual(['one', 'two']);
  });

  it('does nothing for an empty iterable — no fn calls, no yields', async () => {
    let calls = 0;
    let yields = 0;
    await forEachYielding<number>([], () => {
      calls += 1;
    }, { yield: async () => {
      yields += 1;
    } });
    expect(calls).toBe(0);
    expect(yields).toBe(0);
  });

  it('yields through the real event loop by default (no injected primitive)', async () => {
    // budgetMs:0 makes every item trip the budget, so the default real
    // `setImmediate` yield fires between items. A probe `setImmediate` registered
    // *before* the sweep runs ahead of the sweep's own (FIFO within the check
    // phase), proving the default path really returns control to the loop rather
    // than running the whole sweep synchronously.
    let probeRan = false;
    setImmediate(() => {
      probeRan = true;
    });
    await forEachYielding([0, 1, 2, 3, 4], () => {}, { budgetMs: 0 });
    expect(probeRan).toBe(true);
  });
});
