import { describe, it, expect } from 'vitest';
import { forEachYielding, yieldToEventLoop } from '../src/reliability/yield.js';

describe('yieldToEventLoop', () => {
  it('resolves on a later event-loop turn', async () => {
    const order: string[] = [];
    const p = yieldToEventLoop().then(() => order.push('after-yield'));
    order.push('sync');
    await p;
    expect(order).toEqual(['sync', 'after-yield']);
  });
});

describe('forEachYielding', () => {
  it('visits every item in order with its index', async () => {
    const seen: Array<[number, number]> = [];
    await forEachYielding([10, 20, 30], (item, index) => {
      seen.push([index, item]);
    });
    expect(seen).toEqual([
      [0, 10],
      [1, 20],
      [2, 30],
    ]);
  });

  it('yields once the wall-clock budget is exceeded, then resets the slice', async () => {
    // Fake clock advances 10ms per item; budget 25ms ⇒ yield after items that
    // push the slice to/over 25ms (i.e. after the 3rd item and again after the
    // 6th), never mid-slice.
    let clock = 0;
    let yields = 0;
    const yieldedAt: number[] = [];
    await forEachYielding(
      [0, 1, 2, 3, 4, 5],
      (item) => {
        clock += 10;
        void item;
      },
      {
        now: () => clock,
        yieldNow: async () => {
          yields += 1;
          yieldedAt.push(clock);
        },
      },
    );
    // After item#2 slice=30>=25 ⇒ yield (clock 30); reset. After item#5
    // slice=30>=25 ⇒ yield (clock 60).
    expect(yields).toBe(2);
    expect(yieldedAt).toEqual([30, 60]);
  });

  it('never yields when the whole loop stays within budget', async () => {
    let clock = 0;
    let yields = 0;
    await forEachYielding(
      [0, 1, 2],
      () => {
        clock += 1;
      },
      { now: () => clock, budgetMs: 1000, yieldNow: async () => void (yields += 1) },
    );
    expect(yields).toBe(0);
  });

  it('awaits an async body before measuring the slice', async () => {
    const done: number[] = [];
    await forEachYielding(
      [1, 2],
      async (item) => {
        await Promise.resolve();
        done.push(item);
      },
      { budgetMs: 1_000_000 },
    );
    expect(done).toEqual([1, 2]);
  });

  it('does nothing for an empty iterable', async () => {
    let calls = 0;
    await forEachYielding([], () => void (calls += 1));
    expect(calls).toBe(0);
  });
});
