import type { RunPhase } from './run-phases.js';

/**
 * The Session turn queue's admission planner (issue #116, reliability-design
 * §0.4) — a pure sibling to `run-disposition.ts` and `run-phases.ts`: no
 * database, no clock, no I/O. A Session (the live conversation with a harness
 * process) accepts turns from several producers — the initial prompt, a
 * `continue` after a review edit, an operator `steer`, a `self-heal` or
 * `re-merge` corrective turn, a `crash-recovery` re-entry — but can only ever
 * have **one turn in flight at a time** (single-flight). This module is the
 * decision of *which pending turn, if any, gets dispatched next* and *which
 * pending turns are no longer valid and must be cancelled instead*, as a pure
 * function over a plain snapshot of the queue and the Session's live world
 * state. Nothing here drives a harness, persists a transition, or aborts an
 * in-flight prompt — those are the coordinator's job downstream; this module
 * only owns queue *admission*, the same seam discipline as `computeDisposition`
 * and `detectStall`.
 */

/** The turn producers that enqueue onto a Session's queue (reliability-design §0.4). */
export const TURN_PURPOSES = ['initial', 'continue', 'steer', 'self-heal', 're-merge', 'crash-recovery'] as const;
export type TurnPurpose = (typeof TURN_PURPOSES)[number];

/**
 * Mutating corrective turns — `self-heal` and `re-merge` — are the two
 * purposes that touch the workspace out from under the live agent turn (a
 * self-heal replays a fixup, a re-merge re-merges a stale branch) and then
 * re-enter the pipeline at `validating`. They are the only purposes for which
 * `expectedWorkspaceOID` binding is meaningful in practice: a mutating turn
 * enqueued against one workspace state must never dispatch onto a workspace
 * that has since moved (see `changed-oid` / `changed-fingerprint` below).
 */
export const MUTATING_PURPOSES = ['self-heal', 're-merge'] as const;

/** True iff `purpose` is one of `MUTATING_PURPOSES`. */
export function isMutating(purpose: TurnPurpose): boolean {
  return (MUTATING_PURPOSES as readonly TurnPurpose[]).includes(purpose);
}

/**
 * The turn producers whose *pending* rows are meant to survive a process
 * restart rather than be swept as stale — today just `crash-recovery`, the
 * resume re-entry the boot resume sweep enqueues (issue #146). Unlike an
 * ordinary pending turn (whose live harness is gone after a crash, so the
 * crash-recovery queue sweep cancels it), a resume re-entry is enqueued
 * *precisely so the next running process picks it up*; cancelling it would drop
 * a pending resume. Kept as a named predicate alongside {@link isMutating} so a
 * future restart-durable purpose is added here, not by editing the sweep.
 */
export const RESTART_SURVIVING_PURPOSES = ['crash-recovery'] as const;

/** True iff a *pending* `purpose` turn must survive a restart rather than be
 * cancelled by the crash-recovery queue sweep (`RESTART_SURVIVING_PURPOSES`). */
export function survivesRestart(purpose: TurnPurpose): boolean {
  return (RESTART_SURVIVING_PURPOSES as readonly TurnPurpose[]).includes(purpose);
}

/** A turn's lifecycle: queued → claimed → in_flight → done | failed, plus
 * `cancelled` when its precondition no longer holds before it ever dispatched. */
export const TURN_STATUSES = ['queued', 'claimed', 'in_flight', 'done', 'failed', 'cancelled'] as const;
export type TurnStatus = (typeof TURN_STATUSES)[number];

/**
 * Why a pending turn was cancelled instead of dispatched, **highest precedence
 * first** — see the "Cancel reason precedence" note on `planTurnQueue` below.
 */
export const TURN_CANCEL_PRECEDENCE = [
  'execution-closed',
  'wrong-run',
  'wrong-phase',
  'stale-generation',
  'changed-oid',
  'changed-fingerprint',
] as const;
export type TurnCancelReason = (typeof TURN_CANCEL_PRECEDENCE)[number];

/**
 * The minimal structural shape `planTurnQueue` needs from a queued turn: its
 * identity and FIFO position within the Session's queue, its current status
 * and purpose, the Run it drives, and the preconditions it was enqueued
 * against. Each precondition is validated **only if present** (`| undefined`
 * is spelled out, not just `?:`, so callers building items under this repo's
 * `exactOptionalPropertyTypes` can pass an explicit `undefined` binding — e.g.
 * a read-only `continue` turn that carries no workspace bindings at all — as a
 * real, representable state rather than an absent property). A persisted
 * `TurnQueueRow` satisfies this structurally, so callers pass their own rows
 * directly; the function itself stays free of any concrete row type.
 */
export interface TurnItem {
  /** Stable identity within the Session's queue. */
  id: number;
  /** Per-Session FIFO order; lower dispatches first among survivors. */
  seq: number;
  status: TurnStatus;
  purpose: TurnPurpose;
  /** The Run this turn drives. */
  runId: number;
  // Precondition bindings, each validated ONLY if present (a read-only turn
  // may omit workspace bindings entirely):
  expectedPhase?: RunPhase | undefined;
  expectedGeneration?: number | undefined;
  expectedWorkspaceOID?: string | undefined;
  expectedFingerprint?: string | undefined;
}

/**
 * The Session's live execution state, checked immediately before dispatch —
 * not cached, not a projection of the queue itself.
 */
export interface SessionWorld {
  /** The Run currently live in this Session. */
  runId: number;
  phase: RunPhase;
  generation: number;
  workspaceOID?: string | undefined;
  fingerprint?: string | undefined;
  /** Once true, every outstanding (pending) turn is cancelled. */
  executionClosed: boolean;
}

/** `planTurnQueue`'s verdict: the single turn to dispatch now (single-flight),
 * if any, plus every pending turn that must instead be cancelled. */
export interface TurnQueuePlan {
  /** The single turn to send now, or `null` if nothing should dispatch. */
  dispatch: TurnItem | null;
  cancel: ReadonlyArray<{ item: TurnItem; reason: TurnCancelReason }>;
}

/**
 * Decide a Session's turn queue admission: which pending turn (if any) to
 * dispatch next, and which pending turns must instead be cancelled because
 * their precondition no longer holds (reliability-design §0.4).
 *
 * ## Terminal vs. pending
 * `done`, `failed`, and `cancelled` are terminal — a terminal item is never
 * re-evaluated (it cannot be cancelled again, and it can never dispatch).
 * `queued` and `claimed` are **pending**: only pending items are candidates
 * for cancellation or dispatch. `in_flight` is neither pending nor terminal —
 * it is the one turn already sent; see single-flight below.
 *
 * ## Cancel reason precedence
 * Every pending item is checked against `world` in `TURN_CANCEL_PRECEDENCE`
 * order, and the **first** reason that matches is the one recorded — so when
 * several preconditions fail at once (e.g. the Run has both moved phase and
 * closed execution), the result is deterministic rather than depending on
 * evaluation order at the call site:
 *
 *   execution-closed > wrong-run > wrong-phase > stale-generation >
 *   changed-oid > changed-fingerprint
 *
 * `execution-closed` sits at the top because it is a Session-wide fact, not a
 * per-turn precondition — once the Session is closed, nothing further in this
 * queue can ever dispatch, so there is no reason to let a more specific
 * mismatch (say, `wrong-phase`) shadow the real cause. `wrong-run` and
 * `wrong-phase` are checked next because they are the coarsest per-turn
 * facts (which Run, which phase); `stale-generation` and the workspace
 * bindings (`changed-oid`, `changed-fingerprint`) are finer-grained and only
 * meaningful once the coarser preconditions already hold, which is why they
 * rank below.
 *
 * `cancel` is returned in `item.seq` ascending order — the Session's own FIFO
 * order — so the result is deterministic regardless of input order.
 *
 * ## Single-flight
 * A Session drives at most one turn at a time. If **any** item in `items` has
 * `status === 'in_flight'`, the Session is occupied and `dispatch` is `null`
 * no matter what else is pending — a `steer` or `self-heal` enqueued while a
 * turn is already in flight simply waits for the next turn boundary rather
 * than racing it (ADR-0018). Only when nothing is `in_flight` does this
 * function pick a turn to dispatch: the pending item with the smallest `seq`
 * that was **not** cancelled in the precondition pass above (`null` if no
 * pending item survives). The dispatched item, by construction, never also
 * appears in `cancel`.
 *
 * ## Out of scope
 * Aborting an already-sent prompt when execution closes mid-turn (in-flight
 * abort-on-close) is the coordinator's job downstream, not this planner's —
 * `planTurnQueue` only decides queue *admission* (which pending turns to
 * cancel, which one to dispatch next), never what happens to a turn already
 * in flight.
 *
 * ## Purity
 * Total and pure: the same `items` + `world` always yields a deeply-equal
 * plan, with no clock and no reliance on any state outside its arguments —
 * safe to call repeatedly (e.g. re-planning after every queue mutation)
 * without tracking "have I already decided this".
 */
export function planTurnQueue(items: readonly TurnItem[], world: SessionWorld): TurnQueuePlan {
  let inFlight = false;
  const pending: TurnItem[] = [];
  for (const item of items) {
    if (item.status === 'in_flight') inFlight = true;
    if (item.status === 'queued' || item.status === 'claimed') pending.push(item);
  }

  const cancelledIds = new Set<number>();
  const cancel: Array<{ item: TurnItem; reason: TurnCancelReason }> = [];
  // Evaluate in seq order so `cancel` comes out deterministically ordered.
  const bySeq = [...pending].sort((a, b) => a.seq - b.seq);
  for (const item of bySeq) {
    const reason = cancelReason(item, world);
    if (reason !== null) {
      cancelledIds.add(item.id);
      cancel.push({ item, reason });
    }
  }

  let dispatch: TurnItem | null = null;
  if (!inFlight) {
    for (const item of bySeq) {
      if (cancelledIds.has(item.id)) continue;
      if (dispatch === null || item.seq < dispatch.seq) dispatch = item;
    }
  }

  return { dispatch, cancel };
}

/** The first reason (in `TURN_CANCEL_PRECEDENCE` order) `item`'s precondition
 * no longer holds against `world`, or `null` if it is still admissible. */
function cancelReason(item: TurnItem, world: SessionWorld): TurnCancelReason | null {
  if (world.executionClosed) return 'execution-closed';
  if (item.runId !== world.runId) return 'wrong-run';
  if (item.expectedPhase !== undefined && item.expectedPhase !== world.phase) return 'wrong-phase';
  if (item.expectedGeneration !== undefined && item.expectedGeneration !== world.generation) return 'stale-generation';
  if (item.expectedWorkspaceOID !== undefined && item.expectedWorkspaceOID !== world.workspaceOID) return 'changed-oid';
  if (item.expectedFingerprint !== undefined && item.expectedFingerprint !== world.fingerprint) return 'changed-fingerprint';
  return null;
}
