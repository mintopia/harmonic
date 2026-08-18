import { desc, eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { executionChains, runs, tasks, type RunRow } from '../db/schema.js';

/**
 * The Execution Chain's persisted identity + resolver (issue #129,
 * reliability-design Unit A). {@link executionChains} rows are the chain
 * identity itself (nothing but an id + createdAt — the chain carries no
 * state of its own, only the Runs that reference it via `runs.chainId`); this
 * store is how a Run picks which chain it belongs to.
 */
export class ExecutionChainStore {
  constructor(private readonly db: Db) {}

  /** Mint a brand-new chain identity — the start of a new line of work. */
  create(now = Date.now()): number {
    return this.db.insert(executionChains).values({ createdAt: now }).returning({ id: executionChains.id }).get()!
      .id;
  }

  /** Every Run on `chainId`, oldest-first — the chain's member Runs across
   * however many Tasks and attempts continue the same line of work. */
  listForChain(chainId: number): RunRow[] {
    return this.db.select().from(runs).where(eq(runs.chainId, chainId)).orderBy(runs.id).all();
  }

  /** The given task's latest Run (by attempt, falling back to id) that has a
   * non-null `chainId`, or undefined if it has none (yet). */
  private latestChainedRun(taskId: number): RunRow | undefined {
    return this.db
      .select()
      .from(runs)
      .where(eq(runs.taskId, taskId))
      .orderBy(desc(runs.attempt), desc(runs.id))
      .all()
      .find((run) => run.chainId != null);
  }

  /**
   * Decide the Execution Chain a NEW Run for `task` joins. Three branches,
   * tried in order:
   *
   * 1. Same-task continuation — the task's own latest chained Run's
   *    `chainId`, if it has one. Covers a mirrored retry, a crash-resume, or
   *    any other new attempt of the same Task: the new Run stays on the
   *    Task's existing chain.
   * 2. Reattempt ancestry — a re-attempt is a *new, linked* Task
   *    (`tasks.reattemptOf`), not a new attempt of the same Task, so branch 1
   *    finds nothing on a fresh reattempt Task. Walk `reattemptOf` upward:
   *    for each ancestor task id, look for its latest chained Run; the first
   *    one found wins. A depth bound (`MAX_ANCESTRY_DEPTH`) guards against a
   *    corrupt/cyclic `reattemptOf` chain looping forever.
   * 3. Neither found anything to inherit — this Run starts a brand-new line
   *    of work; mint a fresh chain via {@link create}.
   */
  resolveForTask(task: { id: number; reattemptOf: number | null }): number {
    // Branch 1: same-task continuation.
    const own = this.latestChainedRun(task.id);
    if (own?.chainId != null) return own.chainId;

    // Branch 2: walk the reattempt ancestry.
    const MAX_ANCESTRY_DEPTH = 100;
    let ancestorId: number | null = task.reattemptOf;
    const visited = new Set<number>();
    for (let depth = 0; ancestorId != null && depth < MAX_ANCESTRY_DEPTH; depth++) {
      if (visited.has(ancestorId)) break; // cycle guard
      visited.add(ancestorId);

      const ancestorRun = this.latestChainedRun(ancestorId);
      if (ancestorRun?.chainId != null) return ancestorRun.chainId;

      const ancestorTask = this.db
        .select({ reattemptOf: tasks.reattemptOf })
        .from(tasks)
        .where(eq(tasks.id, ancestorId))
        .get();
      ancestorId = ancestorTask?.reattemptOf ?? null;
    }

    // Branch 3: neither the task itself nor its reattempt ancestry has a
    // chained Run to inherit — this Run starts a brand-new line of work.
    return this.create();
  }
}
