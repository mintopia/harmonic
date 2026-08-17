import { asc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { runFacts, type RunFactRow, type RunFactType } from '../db/schema.js';

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
  constructor(private readonly db: Db) {}

  /**
   * Append an ending-signal fact to `runId`'s log, assigning the next monotonic
   * `seq` as `max(seq)+1` (1-based). This reads the current max and inserts —
   * two statements, but `better-sqlite3` is synchronous, so within a process
   * nothing interleaves between them, and a Run's facts have a single owner by
   * design (ADR-0022, the Work Context lease). The `(run_id, seq)` unique index
   * is the integrity backstop: a cross-process racing append that computed the
   * same `seq` is rejected loudly (a raw UNIQUE violation) rather than
   * corrupting the log's total order — mirroring `RunStore.appendEvent` but with
   * the added index guarantee. `payload` is signal-specific detail, JSON-encoded.
   */
  append(
    runId: number,
    type: RunFactType,
    payload: Record<string, unknown> = {},
    now: number = Date.now(),
  ): RunFactRow {
    const seq =
      (this.db
        .select({ n: sql<number>`coalesce(max(${runFacts.seq}), 0)` })
        .from(runFacts)
        .where(eq(runFacts.runId, runId))
        .get()?.n ?? 0) + 1;
    return this.db
      .insert(runFacts)
      .values({ runId, seq, ts: now, type, payload: JSON.stringify(payload) })
      .returning()
      .get();
  }

  /** A Run's fact log in `seq` order — the input to `computeDisposition`. */
  list(runId: number): RunFactRow[] {
    return this.db
      .select()
      .from(runFacts)
      .where(eq(runFacts.runId, runId))
      .orderBy(asc(runFacts.seq))
      .all();
  }
}
