/**
 * The budget Guardrail's wall-clock trip decision (issue #127, ADR-0019,
 * reliability-design Unit A).
 *
 * `config.ts`'s `budgetGuardrailSchema` (issue #108/#126) defines the
 * mandatory wall-clock bound (plus optional token/cost caps, out of scope
 * here) that every afk Run is snapshotted with at start. This module is the
 * brain that decides *whether* a given elapsed duration trips that bound —
 * as a pure function: no database, no clock, no I/O — the same seam as
 * `work-context-key.ts` and `run-disposition.ts`, so the trip contract can
 * be exhaustively unit-tested in isolation. Nothing calls this from the live
 * drive loop yet; that wiring (reading the wall clock, appending the
 * `guardrail-trip` run_fact) is later spine work. This unit only has to get
 * the *decision* right.
 */

import type { RunPhase } from './run-phases.js';
import type { BudgetGuardrail } from '../config.js';

/**
 * The only phases the wall-clock execution budget counts against
 * (reliability-design Unit A, locked).
 *
 * A Run's total wall-clock time includes phases the budget deliberately does
 * NOT bound: `review` is a human-paced wait gated by its own review SLA
 * (issue #114's `review-sla-expiry`), and `landing` is a short mechanical
 * step with its own timeout. Counting either against the execution budget
 * would either trip a Run that is legitimately waiting on a human, or double
 * -govern a step that already has its own guard. So only the phases where an
 * agent harness is actually doing (or about to do) work — `executing`,
 * `validating`, `verifying` — count toward this budget. `terminal` never
 * counts (the Run is already done).
 *
 * This is the single source of truth for the scoping decision:
 * `countsTowardExecutionBudget` and `wallClockTrip` both derive from it, so
 * a future phase is a conscious addition here rather than an implicit
 * default.
 */
export const EXECUTION_BUDGET_PHASES: ReadonlySet<RunPhase> = new Set(['executing', 'validating', 'verifying']);

/**
 * Whether `phase` counts toward the wall-clock execution budget.
 *
 * `null` — a Run that has not yet recorded a phase — counts as executing:
 * the harness has been claimed and is presumed to be doing execution work
 * from the moment it starts, before the first phase transition is ever
 * persisted. Treating the pre-phase window as unguarded would open a gap at
 * exactly the point a runaway process is most likely to burn wall clock
 * unnoticed, so `null` maps to `true` rather than `false`.
 */
export function countsTowardExecutionBudget(phase: RunPhase | null): boolean {
  if (phase === null) return true;
  return EXECUTION_BUDGET_PHASES.has(phase);
}

/** The wall-clock budget expressed in milliseconds, from the guardrail's minutes. */
export function wallClockBudgetMs(budget: Pick<BudgetGuardrail, 'wallClockMinutes'>): number {
  return budget.wallClockMinutes * 60_000;
}

/**
 * The evidence a wall-clock trip carries: the dimension it tripped on, the
 * configured limit, and the observed elapsed duration that crossed it — all
 * in milliseconds so the numbers are unambiguous without a caller needing to
 * know the guardrail's minutes-vs-milliseconds convention.
 */
export interface WallClockTrip {
  dimension: 'wall-clock';
  limitMs: number;
  observedMs: number;
}

/**
 * Decide whether an elapsed duration trips the wall-clock guardrail, given
 * the phase the Run is currently in.
 *
 * This is THE phase-scoping decision (issue #127 acceptance: the clock
 * advances only during `executing`/`validating`/`verifying`) expressed as a
 * pure, exhaustively unit-testable function. A Run parked in `review` or
 * mid-`landing` can be arbitrarily far past `wallClockBudgetMs(budget)` in
 * raw elapsed time and this must still return `null` — the elapsed clock
 * itself is scoped to the execution phases by `countsTowardExecutionBudget`,
 * not by the caller pre-filtering what it measures, so this function is the
 * one place that rule lives regardless of how `elapsedMs` was accumulated
 * upstream.
 *
 * Trips (returns non-null) iff `phase` counts toward the execution budget
 * AND `elapsedMs >= wallClockBudgetMs(budget)` — the boundary itself trips
 * (>=, not >): a Run that has used exactly its full budget has no budget
 * left, not one instant of grace. Returns `null` in every other case: below
 * budget, or in a phase the budget doesn't scope.
 */
export function wallClockTrip(args: {
  elapsedMs: number;
  phase: RunPhase | null;
  budget: Pick<BudgetGuardrail, 'wallClockMinutes'>;
}): WallClockTrip | null {
  if (!countsTowardExecutionBudget(args.phase)) return null;
  const limitMs = wallClockBudgetMs(args.budget);
  if (args.elapsedMs < limitMs) return null;
  return { dimension: 'wall-clock', limitMs, observedMs: args.elapsedMs };
}

/**
 * Render a millisecond duration the way a human reads it, at whichever unit
 * keeps the number small: minutes once it's at least a minute, seconds once
 * it's at least a second, otherwise raw milliseconds. Not exported — this is
 * a rendering detail of `formatBudgetReason`, not a general-purpose duration
 * formatter the rest of the app should depend on.
 */
function humanizeMs(ms: number): string {
  if (ms >= 60_000) return `${Math.round(ms / 60_000)}m`;
  if (ms >= 1_000) return `${Math.round(ms / 1_000)}s`;
  return `${ms}ms`;
}

/**
 * The human-readable card reason for a guardrail trip (issue #127): the
 * reason string derives from the trip evidence itself rather than being
 * composed ad hoc at the call site, so every guardrail-trip card reads the
 * same regardless of which caller produced the trip.
 *
 * Only takes `dimension` and `limitMs` (not the full `WallClockTrip`,
 * `observedMs` included) because the card names the *bound that was
 * configured*, not the exact overshoot — matching ADR-0019's example
 * ("budget: 45m" for a 45-minute wall-clock guardrail).
 */
export function formatBudgetReason(trip: Pick<WallClockTrip, 'dimension' | 'limitMs'>): string {
  switch (trip.dimension) {
    case 'wall-clock':
      return `budget: ${humanizeMs(trip.limitMs)}`;
  }
}
