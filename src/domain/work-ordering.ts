/** A Task-shaped value the DB query can order without coupling this module to I/O. */
export interface OrderableTask {
  id: number;
  priority: string;
  createdAt: number;
  /** IDs of blockers that have not completed. */
  blockedBy: readonly number[];
}

const PRIORITY_RANK: Record<string, number> = { high: 0, normal: 1, low: 2 };

function compareTasks<T extends OrderableTask>(unblockCount: ReadonlyMap<number, number>, left: T, right: T): number {
  const priorityRank = (task: OrderableTask): number => PRIORITY_RANK[task.priority] ?? 1;
  return priorityRank(left) - priorityRank(right) ||
    Number(left.blockedBy.length > 0) - Number(right.blockedBy.length > 0) ||
    (unblockCount.get(right.id) ?? 0) - (unblockCount.get(left.id) ?? 0) ||
    left.createdAt - right.createdAt || left.id - right.id;
}

/**
 * Return the active backlog in scheduler priority order: explicit priority,
 * then unblocked work and unblock-count, then age and ID. Pure and non-mutating.
 */
export function orderEligibleWork<T extends OrderableTask>(tasks: readonly T[]): T[] {
  const unblockCount = new Map<number, number>();
  for (const task of tasks) {
    for (const blockerId of task.blockedBy) {
      unblockCount.set(blockerId, (unblockCount.get(blockerId) ?? 0) + 1);
    }
  }

  return [...tasks].sort((left, right) => compareTasks(unblockCount, left, right));
}

/** Yielding variant for the process-wide background scheduler. */
export async function orderEligibleWorkYielding<T extends OrderableTask>(tasks: readonly T[]): Promise<T[]> {
  const unblockCount = new Map<number, number>();
  let values: T[] = [];
  let sliceStartedAt = Date.now();
  const yieldIfNeeded = async (): Promise<void> => {
    if (Date.now() - sliceStartedAt < 25) return;
    await yieldToEventLoop();
    sliceStartedAt = Date.now();
  };
  for (const task of tasks) {
    values.push(task);
    for (const blockerId of task.blockedBy) {
      unblockCount.set(blockerId, (unblockCount.get(blockerId) ?? 0) + 1);
      await yieldIfNeeded();
    }
    await yieldIfNeeded();
  }
  for (let width = 1; width < values.length; width *= 2) {
    const next: T[] = [];
    for (let start = 0; start < values.length; start += width * 2) {
      let left = start;
      let right = Math.min(start + width, values.length);
      const leftEnd = right;
      const rightEnd = Math.min(start + width * 2, values.length);
      while (left < leftEnd || right < rightEnd) {
        if (right === rightEnd || (left < leftEnd && compareTasks(unblockCount, values[left]!, values[right]!) <= 0)) {
          next.push(values[left++]!);
        } else next.push(values[right++]!);
        await yieldIfNeeded();
      }
    }
    values = next;
  }
  return values;
}
import { yieldToEventLoop } from '../reliability/yield.js';
