import { and, asc, eq, sql } from 'drizzle-orm';
import type { AsyncDb, AsyncDbHandle, AsyncTx } from '../db/async.js';
import { attempts, runFacts, runs, type RunFactRow, type RunFactType } from '../db/schema.js';

/**
 * Append a fact assigning the next monotonic `seq` (`max(seq)+1`, 1-based) on a
 * caller-supplied executor — either a plain {@link AsyncDb} (the store's own
 * `.write()` unit) or an already-open {@link AsyncTx}. Extracted from
 * {@link RunFactStore.append} so a caller that must append a fact atomically
 * with a second write shares this one source of seq assignment instead of
 * re-deriving it. The `(run_id, seq)` unique index stays the cross-process
 * integrity backstop.
 */
export async function appendRunFactTx(
  db: AsyncDb | AsyncTx,
  runId: number,
  type: RunFactType,
  payload: Record<string, unknown> = {},
  now: number = Date.now(),
): Promise<RunFactRow> {
  const seq =
    ((
      await db
        .select({ n: sql<number>`coalesce(max(${runFacts.seq}), 0)` })
        .from(runFacts)
        .where(eq(runFacts.runId, runId))
        .get()
    )?.n ?? 0) + 1;
  const run = await db.select({ taskId: runs.taskId, number: runs.attempt }).from(runs).where(eq(runs.id, runId)).get();
  const attempt = run
    ? await db.select({ id: attempts.id }).from(attempts).where(and(eq(attempts.taskId, run.taskId), eq(attempts.number, run.number))).get()
    : undefined;
  return db
    .insert(runFacts)
    .values({ runId, attemptId: attempt?.id ?? null, seq, ts: now, type, payload: JSON.stringify(payload) })
    .returning()
    .get();
}

/**
 * The append-only fact log store (issue #112, reliability-design §0.1/§0.3):
 * persists every ending signal a Run emits as an immutable `run_fact` with a
 * per-Run monotonic `seq`. The ordered log is the sole input (with a cutoff) to
 * `computeDisposition` (domain/run-disposition.ts).
 *
 * Scope is deliberately narrow: this is the persisted substrate only. Nothing
 * here computes a disposition, drives the Runner, or touches the settle path —
 * those are later units. Facts are only ever appended and read; there is no
 * update or delete path, by design.
 */
export class RunFactStore {
  constructor(private readonly db: AsyncDbHandle) {}

  /**
   * Append an ending-signal fact to `runId`'s log, assigning the next monotonic
   * `seq` as `max(seq)+1` (1-based). This reads the current max and inserts —
   * two statements wrapped as a single write-queue unit (ADR-0029 §3): the
   * async single-writer queue is what now stands in for better-sqlite3's
   * synchrony, so no concurrent append can interleave between the read and the
   * insert and steal the `seq`. The `(run_id, seq)` unique index remains
   * the cross-process integrity backstop: a racing append that computed the same
   * `seq` is rejected loudly (a raw UNIQUE violation) rather than corrupting the
   * log's total order — mirroring `RunStore.appendEvent` but with the added index
   * guarantee. `payload` is signal-specific detail, JSON-encoded.
   */
  append(
    runId: number,
    type: RunFactType,
    payload: Record<string, unknown> = {},
    now: number = Date.now(),
  ): Promise<RunFactRow> {
    return this.db.write((db) => appendRunFactTx(db, runId, type, payload, now));
  }

  /** A Run's fact log in `seq` order — the input to `computeDisposition`. */
  list(runId: number): Promise<RunFactRow[]> {
    return this.db.read((db) =>
      db.select().from(runFacts).where(eq(runFacts.runId, runId)).orderBy(asc(runFacts.seq)).all(),
    );
  }
}
