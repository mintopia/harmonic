/** A Task-shaped value the DB query can order without coupling this module to I/O. */
export interface OrderableTask {
  id: number;
  priority: string;
  createdAt: number;
  /** IDs of blockers that have not completed. */
  blockedBy: readonly number[];
}

const PRIORITY_RANK: Record<string, number> = { high: 0, normal: 1, low: 2 };

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

  const priorityRank = (task: OrderableTask): number => PRIORITY_RANK[task.priority] ?? 1;

  return [...tasks].sort(
    (left, right) =>
      priorityRank(left) - priorityRank(right) ||
      Number(left.blockedBy.length > 0) - Number(right.blockedBy.length > 0) ||
      (unblockCount.get(right.id) ?? 0) - (unblockCount.get(left.id) ?? 0) ||
      left.createdAt - right.createdAt ||
      left.id - right.id,
  );
}
