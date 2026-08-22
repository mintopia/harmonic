import { describe, expect, it } from 'vitest';
import {
  orderEligibleWork,
  orderEligibleWorkYielding,
  type OrderableTask,
} from '../src/domain/work-ordering.js';

const task = (over: Partial<OrderableTask> & { id: number }): OrderableTask => ({
  priority: 'normal',
  createdAt: 0,
  blockedBy: [],
  ...over,
});

const ids = (tasks: OrderableTask[]) => tasks.map((item) => item.id);

describe('orderEligibleWork', () => {
  it('ranks an unblocked task that unblocks more work ahead of an equal-priority peer', () => {
    const input = [
      task({ id: 10 }),
      task({ id: 11 }),
      task({ id: 12, blockedBy: [11] }),
      task({ id: 13, blockedBy: [11] }),
    ];

    expect(ids(orderEligibleWork(input))).toEqual([11, 10, 12, 13]);
  });

  it('orders mixed priorities, dependency rank, and age deterministically', () => {
    const input = [
      task({ id: 100, priority: 'low', createdAt: 0 }),
      task({ id: 200, createdAt: 10 }),
      task({ id: 201, createdAt: 5, blockedBy: [200] }),
      task({ id: 202, createdAt: 5, blockedBy: [200] }),
      task({ id: 203, createdAt: 1 }),
      task({ id: 300, priority: 'high', createdAt: 999 }),
    ];

    expect(ids(orderEligibleWork(input))).toEqual([300, 200, 203, 201, 202, 100]);
  });

  it('does not mutate the caller input', () => {
    const input = [task({ id: 2, priority: 'low' }), task({ id: 1, priority: 'high' })];
    const snapshot = [...input];

    orderEligibleWork(input);

    expect(input).toEqual(snapshot);
  });

  // The yielding merge sort is hand-rolled; small hand-written fixtures cannot
  // catch an off-by-one in the merge that only shows up at larger widths. Fuzz
  // both orderings against the same random inputs and require identical output.
  describe('orderEligibleWork vs orderEligibleWorkYielding (fuzz)', () => {
    // Deterministic PRNG (mulberry32) so any failure is reproducible from SEED.
    const makeRng = (seed: number) => {
      let state = seed >>> 0;
      return () => {
        state = (state + 0x6d2b79f5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    };

    // Priorities include the ranked ones plus unmapped strings to exercise the
    // `PRIORITY_RANK[...] ?? 1` fallback (the "null-ish priority" path).
    const PRIORITIES = ['high', 'normal', 'low', 'urgent', '', 'unknown'];

    const randomInput = (rng: () => number): OrderableTask[] => {
      const size = Math.floor(rng() * 51); // 0..50
      // Unique ids drawn from a shuffled pool so ordering is fully determined
      // by the comparator (id is the final tiebreak) yet id values vary.
      const pool = Array.from({ length: size }, () => Math.floor(rng() * 100000));
      const uniqueIds = Array.from(new Set(pool));
      return uniqueIds.map((id) => {
        const blockerCount = rng() < 0.5 ? 0 : 1 + Math.floor(rng() * 3);
        const blockedBy = Array.from({ length: blockerCount }, () =>
          // Reference some id (often a real one, occasionally arbitrary) to vary unblock-counts.
          rng() < 0.8 && uniqueIds.length > 0
            ? uniqueIds[Math.floor(rng() * uniqueIds.length)]!
            : Math.floor(rng() * 100000),
        );
        return {
          id,
          priority: PRIORITIES[Math.floor(rng() * PRIORITIES.length)]!,
          createdAt: Math.floor(rng() * 20), // small range → many ties on age
          blockedBy,
        };
      });
    };

    it('produce identical id orderings across 200 random inputs', async () => {
      const SEED = 0x9e3779b9;
      const rng = makeRng(SEED);
      for (let iteration = 0; iteration < 200; iteration++) {
        const input = randomInput(rng);
        const sync = ids(orderEligibleWork(input));
        const yielding = ids(await orderEligibleWorkYielding(input));
        expect(
          yielding,
          `mismatch at iteration ${iteration} (SEED=${SEED}); input=${JSON.stringify(input)}`,
        ).toEqual(sync);
      }
    });
  });
});
