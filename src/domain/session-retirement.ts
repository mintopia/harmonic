import type { SessionStatus, SessionRetireReason } from '../db/schema.js';

/** Tunable retention deadlines: how long an idle Session may keep its worktree before the sweep reclaims it. */
export interface RetentionConfig {
  /** Optional time-boxed backstop for a non-merge ending. `null` (the default)
   * retains the idle Session's worktree until the Task reaches a terminal
   * disposition; a number reinstates a TTL sweep. */
  retentionTtlMs: number | null;
}

/** Default retention: no TTL. */
export const DEFAULT_RETENTION: RetentionConfig = {
  retentionTtlMs: null,
};

/**
 * The cause of an Attempt's terminal settle, distilled to what retirement needs:
 * - `merged` — a successful merge (Harmonic's own or an operator Accept): retire.
 * - `operator-cancel` — an operator disposition (cancel / Close): retire.
 * - `other` — any other non-merge ending: retain the Task's worktree until its
 *   terminal disposition (no deadline by default; a configured TTL can still sweep it).
 */
export type RetirementCause = 'merged' | 'operator-cancel' | 'other';

/**
 * What the settle-hook should do to the settling Attempt's Session. `retire`
 * removes the worktree now (via `retiring`); `idle` retains it under
 * `retireDeadline`, carrying the `reason` the sweep will retire it under.
 */
export type RetirementAction =
  | { kind: 'retire'; reason: SessionRetireReason }
  | { kind: 'idle'; reason: SessionRetireReason; retireDeadline: number | null };

/**
 * Decide what an Attempt's Session should do when it settles terminal: a merge
 * or cancel retires now; any other ending goes idle, with no deadline by default
 * or under `now + config.retentionTtlMs` when a TTL is configured.
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
 * The legal `SessionStatus` transitions. Retirement always routes through
 * `retiring` so a crash mid-removal is re-driven by the boot sweep; `idle` can
 * return to `active` when a continuation reuses the retained worktree;
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

/** Whether an `idle` Session's retention `retireDeadline` has lapsed as of `now`. A null deadline never fires. */
export function isRetentionElapsed(
  session: { status: SessionStatus; retireDeadline: number | null },
  now: number,
): boolean {
  return session.status === 'idle' && session.retireDeadline != null && session.retireDeadline <= now;
}
