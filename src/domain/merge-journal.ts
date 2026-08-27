import { asc, eq, sql } from 'drizzle-orm';
import type { AsyncDb, AsyncDbHandle, AsyncTx } from '../db/async.js';
import { mergeJournal, type MergeJournalRow } from '../db/schema.js';
import {
  poncCutoff,
  type MergeEffect,
  type MergeIntent,
  type MergeJournalKind,
  type MergeJournalRowView,
  type MergeResult,
} from './merge.js';

/**
 * Append a journal row assigning the next monotonic `seq` (`max(seq)+1`,
 * 1-based) on a caller-supplied executor — a plain {@link AsyncDb} (the store's
 * own `.write()` unit) or an already-open {@link AsyncTx}. Extracted from
 * {@link MergeJournalStore.append} so the merging PONC freeze
 * (merge-coordinator.ts) can write the `ponc` row inside the **same
 * transaction** as the merge `run_fact` — the two writes must be one write-queue
 * unit so no racing settle append can slip between the merge fact and its PONC
 * (ADR-0029; see `appendRunFactTx`). `effect`/`idempotencyKey` are omitted for a
 * `'ponc'` row.
 */
export async function appendMergeJournalTx(
  db: AsyncDb | AsyncTx,
  runId: number,
  kind: MergeJournalKind,
  detail: { effect?: MergeEffect; idempotencyKey?: string; payload?: Record<string, unknown> } = {},
  now: number = Date.now(),
): Promise<MergeJournalRow> {
  const seq =
    ((
      await db
        .select({ n: sql<number>`coalesce(max(${mergeJournal.seq}), 0)` })
        .from(mergeJournal)
        .where(eq(mergeJournal.runId, runId))
        .get()
    )?.n ?? 0) + 1;
  return db
    .insert(mergeJournal)
    .values({
      runId,
      seq,
      ts: now,
      kind,
      effect: detail.effect ?? null,
      idempotencyKey: detail.idempotencyKey ?? null,
      payload: JSON.stringify(detail.payload ?? {}),
    })
    .returning()
    .get();
}

/**
 * The append-only merging journal store (issue #115, reliability-design
 * §0.3): persists every step of a journaled merging — the PONC marker, and
 * the intent/result of each irreversible effect — as an immutable
 * `merge_journal` row with a per-Run monotonic `seq`. Mirrors
 * `RunFactStore` (run-facts.ts) exactly: same `max(seq)+1` assignment under
 * the same single-owner-per-Run assumption (ADR-0022), same append-only
 * discipline (no update/delete path), same `(run_id, seq)` unique index as
 * the cross-process integrity backstop.
 *
 * This is the persisted substrate only; `MergeCoordinator`
 * (merge-coordinator.ts) is what actually drives a merging through it.
 */
export class MergeJournalStore {
  constructor(private readonly db: AsyncDbHandle) {}

  /**
   * Append a journal row to `runId`'s merging log, assigning the next monotonic
   * `seq` as `max(seq)+1` (1-based) — one write-queue unit (ADR-0029), so the
   * async single-writer queue now stands in for better-sqlite3's synchrony:
   * no concurrent append can interleave between the read and the insert. One
   * owner per Run (ADR-0022) and the `(run_id, seq)` unique index remain the
   * integrity backstop. `effect`/`idempotencyKey` are omitted for a `'ponc'`
   * row. The PONC freeze needs the `ponc` row written atomically with the merge
   * `run_fact` instead — see {@link appendMergeJournalTx}.
   */
  append(
    runId: number,
    kind: MergeJournalKind,
    detail: { effect?: MergeEffect; idempotencyKey?: string; payload?: Record<string, unknown> } = {},
    now: number = Date.now(),
  ): Promise<MergeJournalRow> {
    return this.db.write((db) => appendMergeJournalTx(db, runId, kind, detail, now));
  }

  /** A Run's merging journal in `seq` order — raw persisted rows. */
  list(runId: number): Promise<MergeJournalRow[]> {
    return this.db.read((db) =>
      db
        .select()
        .from(mergeJournal)
        .where(eq(mergeJournal.runId, runId))
        .orderBy(asc(mergeJournal.seq))
        .all(),
    );
  }

  /** `list`, decoded into the shape `foldJournal`/`poncCutoff`/`reconcile`
   * (merge.ts) consume — the one place this store's JSON payload gets
   * parsed, so the pure module never has to. */
  async views(runId: number): Promise<MergeJournalRowView[]> {
    return (await this.list(runId)).map((row) => ({
      seq: row.seq,
      kind: row.kind,
      effect: row.effect,
      idempotencyKey: row.idempotencyKey,
      payload: JSON.parse(row.payload) as Record<string, unknown>,
    }));
  }

  /** Write the PONC marker (see merge.ts's module doc comment): freezes
   * `run_facts`'s disposition cutoff at `cutoffSeq` before the first
   * irreversible merging effect runs. The live `merge` path freezes the PONC
   * atomically with the merge fact in one transaction ({@link
   * appendMergeJournalTx}); this standalone write serves the crash-recovery
   * substrate and its tests. */
  writePonc(runId: number, cutoffSeq: number, now: number = Date.now()): Promise<MergeJournalRow> {
    return this.append(runId, 'ponc', { payload: { cutoffSeq } }, now);
  }

  /** Record "about to attempt `intent.effect`" — always written before that
   * effect's `apply()` call. */
  recordIntent(runId: number, intent: MergeIntent, now: number = Date.now()): Promise<MergeJournalRow> {
    return this.append(
      runId,
      'intent',
      { effect: intent.effect, idempotencyKey: intent.idempotencyKey, payload: { expected: intent.expected } },
      now,
    );
  }

  /** Record the outcome of attempting `result.effect` — always written after
   * that effect's `apply()` call resolves (or reconciliation adopts/retries
   * it). */
  recordResult(runId: number, result: MergeResult, now: number = Date.now()): Promise<MergeJournalRow> {
    return this.append(
      runId,
      'result',
      {
        effect: result.effect,
        idempotencyKey: result.idempotencyKey,
        payload: { ok: result.ok, observed: result.observed, detail: result.detail },
      },
      now,
    );
  }

  /** The PONC cutoff seq for `runId`, or `null` if merging hasn't reached
   * its point of no cancel yet. Thin wrapper over `poncCutoff` (merge.ts)
   * so `RunSettleCoordinator` (an optional consumer — back-compat, see its
   * doc comment) has a one-call read. */
  async ponc(runId: number): Promise<number | null> {
    return poncCutoff(await this.views(runId));
  }
}
