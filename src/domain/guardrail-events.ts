import { asc, eq, sql } from 'drizzle-orm';
import type { AsyncDbHandle } from '../db/async.js';
import {
  guardrailEvents,
  type GuardrailEventRow,
  type GuardrailDimension,
  type GuardrailConfigSource,
} from '../db/schema.js';

/** What `append` needs to persist one Guardrail-trip event — everything on
 * `GuardrailEventRow` except the store-assigned `id`/`runId`/`seq`/`ts`.
 * `payload` is accepted as a plain object (not a pre-stringified string) and
 * is JSON.stringify'd by `append`, defaulting to `{}` when omitted. */
export interface GuardrailEventInput {
  dimension: GuardrailDimension;
  limitValue: number;
  observedValue: number;
  configSource: GuardrailConfigSource;
  payload?: unknown;
}

/**
 * The Guardrail-trip event log store (issue #127, ADR-0019, reliability-design
 * Unit A line 104): persists every Guardrail trip — today only the
 * Step-scoped wall-clock Guardrail — as an immutable row with a per-Run
 * monotonic `seq`. Mirrors `VerificationAttemptStore`
 * (`domain/verification-attempts.ts`) exactly, down to the `seq`-assignment
 * recipe and its rationale: this is the persisted substrate only. Nothing
 * here decides anything, trips a Run to Escalation, or touches the Run/settle
 * path — a caller (the Runner, out of scope here) invokes `append` when its
 * own pure trip-detection logic fires, and a later reader derives the
 * Escalation card's reason from `list(runId)` itself. Events are only ever
 * appended and read; there is no update or delete path, by design.
 */
export class GuardrailEventStore {
  constructor(private readonly db: AsyncDbHandle) {}

  /**
   * Append a Guardrail-trip event to `runId`'s log, assigning the next
   * monotonic `seq` as `max(seq)+1` (1-based) — same recipe, and the same
   * cross-process integrity backstop (the `(run_id, seq)` unique index
   * rejects a racing duplicate `seq` with a raw UNIQUE violation rather than
   * corrupting the log's total order), as `VerificationAttemptStore.append`.
   *
   * The `max(seq)` read and the insert run as one write-queue unit (ADR-0029 §3):
   * the async single-writer queue now stands in for better-sqlite3's synchrony,
   * so no concurrent append can interleave between the read and the insert and
   * steal the `seq` — mirroring `VerificationAttemptStore.append`.
   */
  append(runId: number, event: GuardrailEventInput, now: number = Date.now()): Promise<GuardrailEventRow> {
    return this.db.write(async (db) => {
      const seq =
        ((
          await db
            .select({ n: sql<number>`coalesce(max(${guardrailEvents.seq}), 0)` })
            .from(guardrailEvents)
            .where(eq(guardrailEvents.runId, runId))
            .get()
        )?.n ?? 0) + 1;
      return db
        .insert(guardrailEvents)
        .values({
          runId,
          seq,
          ts: now,
          dimension: event.dimension,
          limitValue: event.limitValue,
          observedValue: event.observedValue,
          configSource: event.configSource,
          payload: JSON.stringify(event.payload ?? {}),
        })
        .returning()
        .get();
    });
  }

  /** A Run's Guardrail-trip event log in `seq` order. */
  list(runId: number): Promise<GuardrailEventRow[]> {
    return this.db.read((db) =>
      db
        .select()
        .from(guardrailEvents)
        .where(eq(guardrailEvents.runId, runId))
        .orderBy(asc(guardrailEvents.seq))
        .all(),
    );
  }
}
