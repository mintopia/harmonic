import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { turnQueue, type TurnQueueRow } from '../db/schema.js';
import { isMutating, type TurnCancelReason, type TurnItem, type TurnPurpose } from './turn-queue.js';

/**
 * The Session turn queue's persisted substrate (issue #116, reliability-design
 * §0.4): appends and mutates `turn_queue` rows for the pure `planTurnQueue`
 * (domain/turn-queue.ts) to decide over. Scope is deliberately narrow — this
 * is the persisted substrate only. Nothing here calls `planTurnQueue`, drives
 * a harness, or dispatches/aborts a turn; those are later, downstream units.
 *
 * The `turn_queue_single_flight` partial unique index (schema.ts) is the
 * integrity backstop for the planner's single-flight rule: a second
 * concurrent `markInFlight` for the same `sessionId` is rejected loudly (a
 * raw UNIQUE violation) rather than silently letting two turns race onto the
 * same live harness process — mirroring `RunFactStore`'s `(run_id, seq)`
 * index comment, but guarding "at most one live turn" instead of "a single
 * total order".
 */
export class TurnQueueStore {
  constructor(private readonly db: Db) {}

  /**
   * Enqueue a new turn onto `sessionId`'s queue, assigning the next monotonic
   * `seq` as `max(seq)+1` (1-based) — the same read-then-insert idiom as
   * `RunFactStore.append`, safe under the same single-owner assumption. The
   * new row starts `queued`, stamped `enqueuedAt` at `now`.
   *
   * A mutating `purpose` (`self-heal` / `re-merge`, `isMutating`) is rejected
   * unless `binding` carries **both** `expectedWorkspaceOID` and
   * `expectedFingerprint`: `planTurnQueue`'s `changed-oid`/`changed-fingerprint`
   * cancellation only protects a mutating turn that actually bound the
   * workspace state it was enqueued against, so an unbound mutating turn would
   * silently dispatch onto whatever workspace state happens to be live —
   * exactly the corruption the workspace preconditions exist to prevent. This
   * is enforced here, at the write path, rather than left to the planner,
   * because the planner treats an absent binding as "not applicable" by
   * design (see turn-queue.ts) and so cannot itself distinguish a mutating
   * turn's missing binding from a read-only turn's legitimately absent one.
   */
  enqueue(
    sessionId: string,
    runId: number,
    purpose: TurnPurpose,
    binding: {
      expectedPhase?: TurnQueueRow['expectedPhase'] | undefined;
      expectedGeneration?: number | undefined;
      expectedWorkspaceOID?: string | undefined;
      expectedFingerprint?: string | undefined;
    } = {},
    now: number = Date.now(),
  ): TurnQueueRow {
    if (isMutating(purpose) && (binding.expectedWorkspaceOID === undefined || binding.expectedFingerprint === undefined)) {
      throw new Error(`mutating turn "${purpose}" must bind expectedWorkspaceOID and expectedFingerprint`);
    }
    const seq =
      (this.db
        .select({ n: sql<number>`coalesce(max(${turnQueue.seq}), 0)` })
        .from(turnQueue)
        .where(eq(turnQueue.sessionId, sessionId))
        .get()?.n ?? 0) + 1;
    return this.db
      .insert(turnQueue)
      .values({
        sessionId,
        runId,
        seq,
        status: 'queued',
        purpose,
        expectedPhase: binding.expectedPhase,
        expectedGeneration: binding.expectedGeneration,
        expectedWorkspaceOid: binding.expectedWorkspaceOID,
        expectedFingerprint: binding.expectedFingerprint,
        enqueuedAt: now,
      })
      .returning()
      .get();
  }

  /** A Session's queue in `seq` order — the input to `planTurnQueue` (via `rowToItem`). */
  listForSession(sessionId: string): TurnQueueRow[] {
    return this.db
      .select()
      .from(turnQueue)
      .where(eq(turnQueue.sessionId, sessionId))
      .orderBy(asc(turnQueue.seq))
      .all();
  }

  /**
   * Transition a `queued` turn to `claimed`, stamping `claimedAt`. Guarded by
   * `status = 'queued'` (optimistic concurrency, see the module doc comment
   * for why the mutators below all carry the same guard) — a turn that has
   * already moved on (claimed twice, or claimed after settling) leaves this
   * update matching no row rather than silently stomping the row's state.
   */
  claim(id: number, now: number = Date.now()): TurnQueueRow {
    const row = this.db
      .update(turnQueue)
      .set({ status: 'claimed', claimedAt: now })
      .where(and(eq(turnQueue.id, id), eq(turnQueue.status, 'queued')))
      .returning()
      .get();
    if (row === undefined) throw new Error(`turn ${id} not in expected state for claim`);
    return row;
  }

  /**
   * Transition a `claimed` turn to `in_flight`, recording `idempotencyKey`
   * and `sentAt`. Guarded by `status = 'claimed'`. `turn_queue_single_flight`
   * additionally rejects a second concurrent `in_flight` row for the same
   * Session regardless of this turn's own prior status — see the module doc
   * comment.
   */
  markInFlight(id: number, idempotencyKey: string, now: number = Date.now()): TurnQueueRow {
    const row = this.db
      .update(turnQueue)
      .set({ status: 'in_flight', idempotencyKey, sentAt: now })
      .where(and(eq(turnQueue.id, id), eq(turnQueue.status, 'claimed')))
      .returning()
      .get();
    if (row === undefined) throw new Error(`turn ${id} not in expected state for markInFlight`);
    return row;
  }

  /** Settle an `in_flight` turn to its terminal outcome, stamping
   * `settledAt`. Guarded by `status = 'in_flight'`. */
  settle(id: number, status: 'done' | 'failed', now: number = Date.now()): TurnQueueRow {
    const row = this.db
      .update(turnQueue)
      .set({ status, settledAt: now })
      .where(and(eq(turnQueue.id, id), eq(turnQueue.status, 'in_flight')))
      .returning()
      .get();
    if (row === undefined) throw new Error(`turn ${id} not in expected state for settle`);
    return row;
  }

  /**
   * Cancel a pending turn whose precondition no longer holds (`planTurnQueue`'s
   * verdict). Guarded by `status IN ('queued', 'claimed')` — cancel only ever
   * applies to a turn that hasn't dispatched yet; aborting an already-sent
   * (`in_flight`) prompt is the coordinator's job, out of this store's scope
   * (see turn-queue.ts's module doc comment).
   */
  cancel(id: number, reason: TurnCancelReason, now: number = Date.now()): TurnQueueRow {
    const row = this.db
      .update(turnQueue)
      .set({ status: 'cancelled', cancelReason: reason, settledAt: now })
      .where(and(eq(turnQueue.id, id), inArray(turnQueue.status, ['queued', 'claimed'])))
      .returning()
      .get();
    if (row === undefined) throw new Error(`turn ${id} not in expected state for cancel`);
    return row;
  }
}

/**
 * Project a persisted `TurnQueueRow` down to the structural `TurnItem` shape
 * `planTurnQueue` consumes — the planner stays free of any concrete row type
 * (see turn-queue.ts), so this mapping lives on the store side instead.
 */
export function rowToItem(row: TurnQueueRow): TurnItem {
  return {
    id: row.id,
    seq: row.seq,
    status: row.status,
    purpose: row.purpose,
    runId: row.runId,
    expectedPhase: row.expectedPhase ?? undefined,
    expectedGeneration: row.expectedGeneration ?? undefined,
    expectedWorkspaceOID: row.expectedWorkspaceOid ?? undefined,
    expectedFingerprint: row.expectedFingerprint ?? undefined,
  };
}
