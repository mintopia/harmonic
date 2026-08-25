import { desc, eq } from 'drizzle-orm';
import type { AsyncDb, AsyncDbHandle } from '../db/async.js';
import { executionChains, runs, type RunRow } from '../db/schema.js';

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
   *    `chainId`, if it has one. Every retry and crash-resume stays on this
   *    ticket's chain.
   * 2. No previous Run exists — this Run starts a brand-new line
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
  resolveForTask(task: { id: number }): Promise<number> {
    return this.db.write(async (db) => {
      const own = await latestChainedRunOn(db, task.id);
      if (own?.chainId != null) return own.chainId;

      return insertChainOn(db, Date.now());
    });
  }
}
