import { desc, eq } from 'drizzle-orm';
import type { AsyncDb, AsyncDbHandle } from '../db/async.js';
import { executionChains, runs, tasks, type RunRow } from '../db/schema.js';

/** Mint a fresh chain identity on a caller-supplied executor (a `.write()` unit
 * or transaction), so {@link ExecutionChainStore.create} and the "mint" branch
 * of {@link ExecutionChainStore.resolveForTask} share one insert without the
 * latter nesting a second `.write()` inside its own write unit. */
function insertChainOn(db: AsyncDb, now: number): Promise<number> {
  return db
    .insert(executionChains)
    .values({ createdAt: now })
    .returning({ id: executionChains.id })
    .get()
    .then((row) => row!.id);
}

/** The given task's latest Run (by attempt, falling back to id) that has a
 * non-null `chainId`, or undefined if it has none (yet) — on a caller-supplied
 * executor so it can share {@link ExecutionChainStore.resolveForTask}'s single
 * write unit. */
async function latestChainedRunOn(db: AsyncDb, taskId: number): Promise<RunRow | undefined> {
  return (
    await db.select().from(runs).where(eq(runs.taskId, taskId)).orderBy(desc(runs.attempt), desc(runs.id)).all()
  ).find((run) => run.chainId != null);
}

/**
 * The Execution Chain's persisted identity + resolver (issue #129,
 * reliability-design Unit A). {@link executionChains} rows are the chain
 * identity itself (nothing but an id + createdAt — the chain carries no
 * state of its own, only the Runs that reference it via `runs.chainId`); this
 * store is how a Run picks which chain it belongs to.
 */
export class ExecutionChainStore {
  constructor(private readonly db: AsyncDbHandle) {}

  /** Mint a brand-new chain identity — the start of a new line of work. */
  create(now = Date.now()): Promise<number> {
    return this.db.write((db) => insertChainOn(db, now));
  }

  /** Every Run on `chainId`, oldest-first — the chain's member Runs across
   * however many Tasks and attempts continue the same line of work. */
  listForChain(chainId: number): Promise<RunRow[]> {
    return this.db.read((db) => db.select().from(runs).where(eq(runs.chainId, chainId)).orderBy(runs.id).all());
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
   *    of work; mint a fresh chain.
   *
   * The whole read-decide-mint runs as one `this.db.write()` unit (ADR-0029
   * §3). The synchronous better-sqlite3 version got this atomicity for free —
   * nothing could interleave a resolve that had no `await` points. Under the
   * async facade the single-writer queue is what restores it: without one write
   * unit, two concurrent resolves for the same fresh line of work could each read
   * "no chain yet" and both mint (branch 3), and — unlike a Run's `seq` — a
   * `chainId` has no UNIQUE-index backstop to reject the duplicate.
   */
  resolveForTask(task: { id: number; reattemptOf: number | null }): Promise<number> {
    return this.db.write(async (db) => {
      // Branch 1: same-task continuation.
      const own = await latestChainedRunOn(db, task.id);
      if (own?.chainId != null) return own.chainId;

      // Branch 2: walk the reattempt ancestry.
      const MAX_ANCESTRY_DEPTH = 100;
      let ancestorId: number | null = task.reattemptOf;
      const visited = new Set<number>();
      for (let depth = 0; ancestorId != null && depth < MAX_ANCESTRY_DEPTH; depth++) {
        if (visited.has(ancestorId)) break; // cycle guard
        visited.add(ancestorId);

        const currentAncestorId = ancestorId;
        const ancestorRun = await latestChainedRunOn(db, currentAncestorId);
        if (ancestorRun?.chainId != null) return ancestorRun.chainId;

        const ancestorTask = await db
          .select({ reattemptOf: tasks.reattemptOf })
          .from(tasks)
          .where(eq(tasks.id, currentAncestorId))
          .get();
        ancestorId = ancestorTask?.reattemptOf ?? null;
      }

      // Branch 3: neither the task itself nor its reattempt ancestry has a
      // chained Run to inherit — this Run starts a brand-new line of work.
      return insertChainOn(db, Date.now());
    });
  }
}
