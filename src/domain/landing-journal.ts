import { asc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { landingJournal, type LandingJournalRow } from '../db/schema.js';
import {
  poncCutoff,
  type LandingEffect,
  type LandingIntent,
  type LandingJournalKind,
  type LandingJournalRowView,
  type LandingResult,
} from './landing.js';

/**
 * The append-only landing journal store (issue #115, reliability-design
 * §0.3): persists every step of a journaled landing — the PONC marker, and
 * the intent/result of each irreversible effect — as an immutable
 * `landing_journal` row with a per-Run monotonic `seq`. Mirrors
 * `RunFactStore` (run-facts.ts) exactly: same `max(seq)+1` assignment under
 * the same single-owner-per-Run assumption (ADR-0022), same append-only
 * discipline (no update/delete path), same `(run_id, seq)` unique index as
 * the cross-process integrity backstop.
 *
 * This is the persisted substrate only; `LandingCoordinator`
 * (landing-coordinator.ts) is what actually drives a landing through it.
 */
export class LandingJournalStore {
  constructor(private readonly db: Db) {}

  /**
   * Append a journal row to `runId`'s landing log, assigning the next
   * monotonic `seq` as `max(seq)+1` (1-based) — see `RunFactStore.append`'s
   * doc comment for why two statements are safe here (synchronous
   * better-sqlite3, one owner per Run, the unique index as backstop).
   * `effect`/`idempotencyKey` are omitted for a `'ponc'` row.
   */
  append(
    runId: number,
    kind: LandingJournalKind,
    detail: { effect?: LandingEffect; idempotencyKey?: string; payload?: Record<string, unknown> } = {},
    now: number = Date.now(),
  ): LandingJournalRow {
    const seq =
      (this.db
        .select({ n: sql<number>`coalesce(max(${landingJournal.seq}), 0)` })
        .from(landingJournal)
        .where(eq(landingJournal.runId, runId))
        .get()?.n ?? 0) + 1;
    return this.db
      .insert(landingJournal)
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

  /** A Run's landing journal in `seq` order — raw persisted rows. */
  list(runId: number): LandingJournalRow[] {
    return this.db
      .select()
      .from(landingJournal)
      .where(eq(landingJournal.runId, runId))
      .orderBy(asc(landingJournal.seq))
      .all();
  }

  /** `list`, decoded into the shape `foldJournal`/`poncCutoff`/`reconcile`
   * (landing.ts) consume — the one place this store's JSON payload gets
   * parsed, so the pure module never has to. */
  views(runId: number): LandingJournalRowView[] {
    return this.list(runId).map((row) => ({
      seq: row.seq,
      kind: row.kind,
      effect: row.effect,
      idempotencyKey: row.idempotencyKey,
      payload: JSON.parse(row.payload) as Record<string, unknown>,
    }));
  }

  /** Write the PONC marker (see landing.ts's module doc comment): freezes
   * `run_facts`'s disposition cutoff at `cutoffSeq` before the first
   * irreversible landing effect runs. */
  writePonc(runId: number, cutoffSeq: number, now: number = Date.now()): LandingJournalRow {
    return this.append(runId, 'ponc', { payload: { cutoffSeq } }, now);
  }

  /** Record "about to attempt `intent.effect`" — always written before that
   * effect's `apply()` call. */
  recordIntent(runId: number, intent: LandingIntent, now: number = Date.now()): LandingJournalRow {
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
  recordResult(runId: number, result: LandingResult, now: number = Date.now()): LandingJournalRow {
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

  /** The PONC cutoff seq for `runId`, or `null` if landing hasn't reached
   * its point of no cancel yet. Thin wrapper over `poncCutoff` (landing.ts)
   * so `RunSettleCoordinator` (an optional consumer — back-compat, see its
   * doc comment) has a one-call read. */
  ponc(runId: number): number | null {
    return poncCutoff(this.views(runId));
  }
}
