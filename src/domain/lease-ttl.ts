/**
 * Work Context lease TTL budgets (issue #122, ADR-0022, reliability-design
 * §0.5): the pure phase→budget mapping the coordinator-driven heartbeat and
 * the periodic sweep both derive from. Mirrors `guardrail-budget.ts`'s
 * pure-seam style: no database, no clock, no I/O, so the TTL/lapse contract
 * can be exhaustively unit-tested in isolation from the store that persists
 * it (`work-context-leases.ts`) and the Runner timer that drives it.
 */

/** TTL budgets for the two kinds of occupancy a Work Context lease spans. */
export interface LeaseTtl {
  /** TTL budget (ms) for active execution phases (executing/validating/verifying/landing). */
  executionMs: number;
  /** TTL budget (ms) for the review gate — a Run parked awaiting a human holds far longer. */
  reviewMs: number;
}

/**
 * Execution phases get a short budget — several missed coordinator
 * heartbeats' worth, so a Run that is still genuinely alive (heartbeating on
 * its own wall-clock timer, independent of agent/tool output) never lapses,
 * while a Run whose process actually died is swept promptly. The review gate
 * rides the same window as the review SLA (7d, aligned with `runner.ts`'s
 * `REVIEW_SLA_MS`) — a Run parked awaiting a human is not a crash.
 */
export const DEFAULT_LEASE_TTL: LeaseTtl = {
  executionMs: 2 * 60_000,
  reviewMs: 7 * 24 * 60 * 60 * 1000,
};

/**
 * The TTL budget (ms) for `phase` (issue #122 acceptance: TTL is
 * phase-specific — the review gate uses a different budget than the
 * execution phases). `review` maps to `ttl.reviewMs`; every other phase —
 * including the pre-phase-machine literal `'running'`, and `null`/`undefined`
 * (no phase recorded yet) — maps to `ttl.executionMs`. Total over any string:
 * an unrecognized phase falls back to the execution budget rather than
 * throwing, matching `countsTowardExecutionBudget`'s null-counts-as-executing
 * precedent in `guardrail-budget.ts`.
 */
export function leaseTtlMsForPhase(phase: string | null | undefined, ttl: LeaseTtl = DEFAULT_LEASE_TTL): number {
  if (phase === 'review') return ttl.reviewMs;
  return ttl.executionMs;
}

/** `now + leaseTtlMsForPhase(phase, ttl)` — the absolute expiry instant a
 * lease acquire/heartbeat should set for `phase`. */
export function leaseExpiryFor(phase: string | null | undefined, now: number, ttl: LeaseTtl = DEFAULT_LEASE_TTL): number {
  return now + leaseTtlMsForPhase(phase, ttl);
}

/**
 * Whether a lease has lapsed as of `now` (issue #122 acceptance: a lapsed
 * heartbeat transitions the lease `held` → `suspect`).
 *
 * True iff the lease is `held`, has a non-null `expiry`, and `expiry <= now`
 * — the boundary itself lapses (`<=`, not `<`), matching `wallClockTrip`'s
 * boundary-trips convention in `guardrail-budget.ts`. A `null` expiry (a
 * lease that was never heartbeated, or predates the TTL machinery) is NOT
 * lapsed here — boot reconciliation (#123) is that gap's backstop, not this
 * live sweep. A `suspect` lease is already reconciled — it is not re-lapsed
 * by a live sweep passing over it again.
 */
export function isLeaseLapsed(lease: { state: string; expiry: number | null }, now: number): boolean {
  if (lease.state !== 'held') return false;
  if (lease.expiry === null) return false;
  return lease.expiry <= now;
}
