import type { SessionStatus, SessionRetireReason } from '../db/schema.js';

/**
 * Session retirement decision (issue #148, reliability-design Unit C).
 *
 * **Session retirement is the sole owner of builder-worktree removal**, and the
 * builder worktree is per-Task (ADR-0046): one checkout, reused by every Attempt,
 * removed **only** when the Task reaches a terminal disposition — merge or cancel
 * — never at `finalizeWorkspace` / reaching `terminal`, and never on a timer by
 * default. A non-merge ending (fail / escalate / reject) leaves the Session idle
 * with no deadline so the next Attempt resumes in the same working copy. This
 * module is the pure decision half of
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
 * the sweep reclaims it.
 */
export interface RetentionConfig {
  /** Optional time-boxed backstop for a non-merge ending. `null` (the default)
   * means the idle Session's worktree is **retained until the Task reaches a
   * terminal disposition** (ADR-0046: the builder worktree is per-Task and lives
   * across every Attempt) — merge or cancel is what removes it, never a timer. A
   * number reinstates a TTL sweep, so an idle Session past that many ms is
   * reclaimed even without a disposition. */
  retentionTtlMs: number | null;
}

/** Default retention (ADR-0046): no TTL — a failed/escalated Run's worktree is
 * retained until its Task is merged or cancelled, so every Attempt reuses it. */
export const DEFAULT_RETENTION: RetentionConfig = {
  retentionTtlMs: null,
};

/**
 * The cause of a Run's terminal settle, distilled to exactly what retirement
 * needs from the winning `run_fact`:
 * - `merged` — a successful merge + terminal success (Harmonic's own merge or
 *   an operator Accept): the work is banked, retire immediately.
 * - `operator-cancel` — an operator disposition (cancel / Close): retire.
 * - `other` — any other non-merge ending (generic fail, escalate,
 *   guardrail-trip, process-death): retain the Task's worktree until its terminal
 *   disposition (no deadline by default; a configured TTL can still sweep it).
 */
export type RetirementCause = 'merged' | 'operator-cancel' | 'other';

/**
 * What the settle-hook should do to the settling Run's Session. `retire` removes
 * the worktree now (via `retiring`); `idle` retains it under `retireDeadline`,
 * carrying the `reason` the sweep will retire it under when the deadline lapses.
 */
export type RetirementAction =
  | { kind: 'retire'; reason: SessionRetireReason }
  | { kind: 'idle'; reason: SessionRetireReason; retireDeadline: number | null };

/**
 * Decide what a Run's Session should do when the Run settles terminal, from the
 * settle `cause`. Pure and total: a merge or cancel retires now; any other ending
 * goes idle, with no deadline by default (retained until the Task's disposition)
 * or under `now + config.retentionTtlMs` when a TTL is configured. Recomputing
 * over the same inputs always yields the same action.
 */
export function decideRetirement(
  cause: RetirementCause,
  now: number,
  config: RetentionConfig = DEFAULT_RETENTION,
): RetirementAction {
  switch (cause) {
    case 'merged':
      return { kind: 'retire', reason: 'merged' };
    case 'operator-cancel':
      return { kind: 'retire', reason: 'operator-disposition' };
    case 'other': {
      const ttl = config.retentionTtlMs;
      return ttl === null
        ? { kind: 'idle', reason: 'task-active', retireDeadline: null }
        : { kind: 'idle', reason: 'retention-ttl', retireDeadline: now + ttl };
    }
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
