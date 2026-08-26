import type { SessionStatus, SessionRetireReason } from '../db/schema.js';

/**
 * Session retirement decision (issue #148, reliability-design Unit C).
 *
 * **Session retirement is the sole owner of builder-worktree removal.** A
 * worktree Session's checkout is retained through the human-rejection window (so
 * a reject-and-continue lands in the same workspace) and its builder worktree is
 * removed **only** at retirement — never at `finalizeWorkspace` / reaching
 * `terminal` (reliability-design §0.2). This module is the pure decision half of
 * that policy: given the cause of a Run's terminal settle it says whether the
 * Run's Session should retire *now* or go *idle* under a retention deadline — no
 * database, no clock, no git, so the deadline policy and the legal state graph
 * can be exhaustively unit-tested (the same seam as `run-disposition.ts`).
 *
 * The Sessions move `active → idle → retiring → retired`: `active` while a live
 * Run owns them; `idle` when no live Run remains but the
 * worktree is retained under a `retireDeadline` (the reject-continuation / warm
 * window); `retiring` while the worktree removal is in flight (so a crash
 * mid-removal is re-driven from `retiring` at boot); `retired` once the worktree
 * is gone. The removal itself, the lease coordination, and the boot sweep live in
 * `SessionRetirementCoordinator`; this file never touches I/O.
 */

/**
 * Tunable retention deadlines (issue #148). Cost/UX estimates, not correctness
 * gates — a retained worktree is only ever *evidence* + a *warm continuation
 * surface*, so these bound how long an idle Session may keep its worktree before
 * the sweep reclaims it, and are deliberately generous.
 */
export interface RetentionConfig {
  /** How long after a human **reject** the worktree is retained for a
   * reject-and-continue to land in the same workspace before the sweep retires
   * the Session (`reject-continuation-timeout`). */
  rejectContinuationMs: number;
  /** Backstop retention for any other non-landing ending (a failed/escalated
   * Run whose git state is evidence): retained this long for diagnosis, then
   * swept (`retention-ttl`) so no idle Session keeps its worktree forever. An
   * operator disposition can retire it sooner. */
  retentionTtlMs: number;
}

/** Default retention windows (issue #148): 30 min for a reject continuation, 24 h
 * as the backstop for a failed/escalated Run's evidence. */
export const DEFAULT_RETENTION: RetentionConfig = {
  rejectContinuationMs: 30 * 60 * 1000,
  retentionTtlMs: 24 * 60 * 60 * 1000,
};

/**
 * The cause of a Run's terminal settle, distilled to exactly what retirement
 * needs from the winning `run_fact`:
 * - `landed` — a successful land + terminal success (native Accept, native
 *   auto-accept, or a mirrored land): the work is banked, retire immediately.
 * - `rejected` — a human rejected the review: retain for a reject-continuation.
 * - `review-sla` — the review SLA lapsed unreviewed: the review is abandoned,
 *   retire.
 * - `operator-cancel` — an operator disposition (cancel): retire.
 * - `other` — any other non-landing ending (generic fail, escalate,
 *   guardrail-trip, branch-violation, process-death): retain as evidence under
 *   the retention-TTL backstop.
 */
export type RetirementCause = 'landed' | 'operator-cancel' | 'other';

/**
 * What the settle-hook should do to the settling Run's Session. `retire` removes
 * the worktree now (via `retiring`); `idle` retains it under `retireDeadline`,
 * carrying the `reason` the sweep will retire it under when the deadline lapses.
 */
export type RetirementAction =
  | { kind: 'retire'; reason: SessionRetireReason }
  | { kind: 'idle'; reason: SessionRetireReason; retireDeadline: number };

/**
 * Decide what a Run's Session should do when the Run settles terminal, from the
 * settle `cause`. Pure and total: a landing/abandonment/cancel retires now; a
 * reject or any other ending goes idle under the matching retention deadline
 * computed from `now`. Recomputing over the same inputs always yields the same
 * action.
 */
export function decideRetirement(
  cause: RetirementCause,
  now: number,
  config: RetentionConfig = DEFAULT_RETENTION,
): RetirementAction {
  switch (cause) {
    case 'landed':
      return { kind: 'retire', reason: 'landed' };
    case 'operator-cancel':
      return { kind: 'retire', reason: 'operator-disposition' };
    case 'other':
      return {
        kind: 'idle',
        reason: 'retention-ttl',
        retireDeadline: now + config.retentionTtlMs,
      };
  }
}

/**
 * The legal `SessionStatus` transitions (issue #148). Retirement always routes
 * through `retiring` so a crash between "worktree removal started" and
 * "`retired` written" leaves the Session in `retiring` for the boot sweep to
 * re-drive — it never jumps `active`/`idle` straight to `retired`. `idle` can
 * return to `active` when a continuation Run reuses the retained worktree.
 * `retired` is terminal.
 */
export const LEGAL_TRANSITIONS: Readonly<Record<SessionStatus, readonly SessionStatus[]>> = {
  active: ['idle', 'retiring'],
  idle: ['active', 'retiring'],
  retiring: ['retired'],
  retired: [],
};

/** Whether `from → to` is a legal Session status transition (a no-op `from ===
 * to` is legal — idempotent re-application). */
export function canTransition(from: SessionStatus, to: SessionStatus): boolean {
  return from === to || LEGAL_TRANSITIONS[from].includes(to);
}

/**
 * Whether an `idle` Session is due for retirement as of `now`: it carries a
 * retention `retireDeadline` that has lapsed. A null deadline never fires (an
 * escalation retained only for an explicit operator disposition). Pure — the
 * store's sweep query and this predicate agree.
 */
export function isRetentionElapsed(
  session: { status: SessionStatus; retireDeadline: number | null },
  now: number,
): boolean {
  return session.status === 'idle' && session.retireDeadline != null && session.retireDeadline <= now;
}
