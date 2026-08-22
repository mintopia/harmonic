import { describe, expect, it } from 'vitest';
import { orderEligibleWork, type OrderableTask } from '../src/domain/work-ordering.js';

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
});
