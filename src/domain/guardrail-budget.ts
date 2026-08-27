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
 * (issue #114's `review-sla-expiry`), and `merging` is a short mechanical
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
 * mid-`merging` can be arbitrarily far past `wallClockBudgetMs(budget)` in
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
 * it's at least a second, otherwise raw milliseconds. Exported (issue #131) so
 * `guardrail-tool-timeout.ts` can reuse the same rendering for its own
 * card reason rather than duplicating it.
 */
export function humanizeMs(ms: number): string {
  if (ms >= 60_000) return `${Math.round(ms / 60_000)}m`;
  if (ms >= 1_000) return `${Math.round(ms / 1_000)}s`;
  return `${ms}ms`;
}

/**
 * The evidence a token-budget trip carries (issue #128): the configured
 * token cap and the cumulative token count that reached or crossed it. Mirrors
 * `WallClockTrip`'s shape so `formatBudgetReason` can dispatch on `dimension`
 * uniformly across all three budget dimensions.
 */
export interface TokenTrip {
  dimension: 'tokens';
  limitTokens: number;
  observedTokens: number;
}

/**
 * The evidence a cost-budget trip carries (issue #128): the configured USD
 * cap and the priced spend floor that reached or crossed it. "Floor" because
 * `observedUsd` is only ever a lower bound when some tokens went unpriced
 * (see `costIncomplete` on `spendTrip`) — a floor already over the cap is
 * still a definite trip, which is why `spendTrip` checks it before deciding
 * whether the cost figure can be trusted as complete.
 */
export interface CostTrip {
  dimension: 'cost';
  limitUsd: number;
  observedUsd: number;
}

/**
 * Result of evaluating the live token/cost spend guards this poll (issue
 * #128). Three outcomes, not two, because "the guard is configured but we
 * can't measure it" is a materially different situation from "the guard is
 * configured and satisfied" — a `null`/`ok`-only signature would collapse
 * "no telemetry" into "no trip", silently degrading a configured cap into a
 * no-op. Callers (the Runner's drive loop) are expected to treat sustained
 * `unmeasurable` as its own concern (issue #128's grace-period-then-Escalate
 * behaviour lives there, not in this pure decision layer).
 */
export type SpendOutcome =
  | { kind: 'trip'; trip: TokenTrip | CostTrip }
  | { kind: 'unmeasurable'; dimension: 'tokens' | 'cost' }
  | { kind: 'ok' };

/**
 * The token-cap decision shared by `spendTrip`'s direct token check and its
 * cost-cap-falls-back-to-tokens path (see `spendTrip` step 3b). Kept private
 * because both call sites need the identical boundary/telemetry rule and
 * duplicating it would risk the two copies drifting.
 *
 * `observedTokens === null` means no token telemetry is available at all
 * (distinct from `0`, which is a real, trustworthy reading) — that maps to
 * `unmeasurable`, not `ok`, so a configured cap with no usage feed doesn't
 * silently behave as if it were unset. The trip boundary is `>=`, matching
 * `wallClockTrip`: a Run that has used exactly its full budget has no budget
 * left, not one instant of grace.
 */
function tokenOutcome(limitTokens: number, observedTokens: number | null): SpendOutcome {
  if (observedTokens === null) return { kind: 'unmeasurable', dimension: 'tokens' };
  if (observedTokens >= limitTokens) {
    return { kind: 'trip', trip: { dimension: 'tokens', limitTokens, observedTokens } };
  }
  return { kind: 'ok' };
}

/**
 * Decide whether the live token/cost spend guards trip, given the phase the
 * Run is currently in and this poll's observed usage (issue #128, extending
 * #127's wall-clock dimension to the other two `BudgetGuardrail` bounds).
 *
 * Phase-scoped identically to `wallClockTrip`: only the execution phases
 * (`countsTowardExecutionBudget`) are governed, and a `null` phase counts as
 * executing for the same pre-phase-window reason.
 *
 * The cost cap and token cap are not fully independent, because cost is
 * frequently *unknowable* in a way tokens are not (a provider that doesn't
 * price a given model, or a response still missing a pricing entry). Rather
 * than let a configured cost cap silently go unenforced whenever pricing is
 * incomplete, an unpriced (or partially-priced) cost cap falls back to
 * enforcing the token cap instead — "govern spend by tokens when you can't
 * govern it by dollars" is a strictly safer default than "don't govern it at
 * all". A priced floor that is *already* over the cap still trips on cost
 * even when `costIncomplete` is set: incompleteness only ever means the true
 * cost is >= the observed floor, so a floor over the cap is trustworthy
 * evidence of a trip regardless of what's still unpriced. Once cost is fully
 * priced and under the cap, the token cap (if configured) still applies
 * independently underneath it — the two caps are ANDed together, not an
 * either/or, once cost can be trusted.
 */
export function spendTrip(args: {
  phase: RunPhase | null;
  budget: Pick<BudgetGuardrail, 'tokens' | 'costUsd'>;
  observedTokens: number | null;
  observedUsd: number | null;
  costIncomplete: boolean;
}): SpendOutcome {
  if (!countsTowardExecutionBudget(args.phase)) return { kind: 'ok' };

  const { tokens, costUsd } = args.budget;
  const { observedTokens, observedUsd, costIncomplete } = args;

  if (costUsd !== null) {
    if (observedUsd !== null && observedUsd >= costUsd) {
      return { kind: 'trip', trip: { dimension: 'cost', limitUsd: costUsd, observedUsd } };
    }
    const fullyPriced = observedUsd !== null && !costIncomplete;
    if (!fullyPriced) {
      if (tokens !== null) return tokenOutcome(tokens, observedTokens);
      return { kind: 'unmeasurable', dimension: 'cost' };
    }
    // Fully priced and under the cap: fall through to the independent token cap.
  }

  if (tokens !== null) return tokenOutcome(tokens, observedTokens);
  return { kind: 'ok' };
}

/**
 * The human-readable card reason for a guardrail trip (issue #127, widened
 * for #128's token/cost dimensions): the reason string derives from the trip
 * evidence itself rather than being composed ad hoc at the call site, so
 * every guardrail-trip card reads the same regardless of which caller
 * produced the trip.
 *
 * Only takes `dimension` plus the *limit* field for that dimension (never
 * the observed value) because the card names the *bound that was
 * configured*, not the exact overshoot — matching ADR-0019's example
 * ("budget: 45m" for a 45-minute wall-clock guardrail), extended to
 * "budget: 2M tokens" and "budget: $10" for the other two dimensions.
 */
export function formatBudgetReason(
  trip:
    | Pick<WallClockTrip, 'dimension' | 'limitMs'>
    | Pick<TokenTrip, 'dimension' | 'limitTokens'>
    | Pick<CostTrip, 'dimension' | 'limitUsd'>,
): string {
  switch (trip.dimension) {
    case 'wall-clock':
      return `budget: ${humanizeMs(trip.limitMs)}`;
    case 'tokens':
      return `budget: ${humanizeCount(trip.limitTokens)} tokens`;
    case 'cost':
      return `budget: ${formatUsd(trip.limitUsd)}`;
  }
}

/**
 * Render a token count the way a human reads it, at whichever unit keeps the
 * number small: millions once it's at least a million, thousands once it's
 * at least a thousand, otherwise the raw count. Mirrors `humanizeMs`'s
 * shrink-to-the-largest-sensible-unit approach for the token dimension.
 * Trimmed to at most one decimal place (`2_000_000` -> "2M", `1_500_000` ->
 * "1.5M") so the card stays short without inventing false precision.
 */
export function humanizeCount(n: number): string {
  const trim = (x: number): number => Number(x.toFixed(1));
  if (n >= 1_000_000) return `${trim(n / 1_000_000)}M`;
  if (n >= 1_000) return `${trim(n / 1_000)}K`;
  return `${n}`;
}

/**
 * Render a USD amount the way a human reads it: dollars rounded to at most
 * two decimal places, with trailing zeroes dropped (`10` -> "$10", `10.5` ->
 * "$10.5", not "$10.00"/"$10.50") so the card stays as short as
 * `humanizeMs`/`humanizeCount`'s renderings for the other two dimensions.
 */
export function formatUsd(usd: number): string {
  return `$${Number(usd.toFixed(2))}`;
}

/**
 * USD → micro-dollars (issue #128): the `guardrail_events` `limit_value` /
 * `observed_value` columns are integers (they hold milliseconds for
 * wall-clock, token counts for tokens), so a cost trip stores its dollars as
 * an integer number of micro-dollars (USD × 1e6) — lossless to the
 * micro-dollar, with the human USD floats carried alongside in the row's
 * `payload`. The single definition keeps every call site on the same scale;
 * a stray `1e3`-vs-`1e6` at one site would silently corrupt stored spend.
 */
export function toMicroUsd(usd: number): number {
  return Math.round(usd * 1_000_000);
}

/**
 * The card reason when a configured spend guard cannot be measured (issue
 * #128): usage telemetry is missing (no token feed, or a cost cap with no
 * pricing at all and no token fallback), so this is surfaced distinctly from
 * both "ok" and "trip" rather than silently treated as either. The Runner's
 * drive loop is expected to tolerate this for a grace period and then
 * Escalate rather than let a configured budget silently degrade to
 * wall-clock-only enforcement for the life of the Run.
 */
export function formatUnmeasurableReason(dimension: 'tokens' | 'cost'): string {
  return `budget: ${dimension} unmeasurable`;
}
