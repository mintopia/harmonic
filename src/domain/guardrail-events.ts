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
 * The Guardrail-trip event log store: every Guardrail trip as an immutable row
 * with a per-Attempt monotonic `seq`. Append and read only.
 */
export class GuardrailEventStore {
  constructor(private readonly db: AsyncDbHandle) {}

  /** Append a Guardrail-trip event to `attemptId`'s log, assigning the next monotonic `seq` (1-based). */
  append(attemptId: number, event: GuardrailEventInput, now: number = Date.now()): Promise<GuardrailEventRow> {
    return this.db.write(async (db) => {
      const seq =
        ((
          await db
            .select({ n: sql<number>`coalesce(max(${guardrailEvents.seq}), 0)` })
            .from(guardrailEvents)
            .where(eq(guardrailEvents.attemptId, attemptId))
            .get()
        )?.n ?? 0) + 1;
      return db
        .insert(guardrailEvents)
        .values({
          attemptId,
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

  /** An Attempt's Guardrail-trip event log in `seq` order. */
  list(attemptId: number): Promise<GuardrailEventRow[]> {
    return this.db.read((db) =>
      db
        .select()
        .from(guardrailEvents)
        .where(eq(guardrailEvents.attemptId, attemptId))
        .orderBy(asc(guardrailEvents.seq))
        .all(),
    );
  }
}
