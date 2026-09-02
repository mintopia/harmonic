import type { StepType } from '../db/schema.js';
import type { BudgetGuardrail } from '../config.js';

/**
 * The Step types the wall-clock execution budget counts against. The gap
 * between Steps (notably the merge after the last Step passes, which has its
 * own timeout) is not bounded by this budget.
 */
export const EXECUTION_BUDGET_STEPS: ReadonlySet<StepType> = new Set(['rebase', 'implementation', 'verification', 'review']);

/** Whether `stepType` counts toward the wall-clock execution budget; `null` (no Step running) never does. */
export function countsTowardExecutionBudget(stepType: StepType | null): boolean {
  if (stepType === null) return false;
  return EXECUTION_BUDGET_STEPS.has(stepType);
}

/** The wall-clock budget expressed in milliseconds, from the guardrail's minutes. */
export function wallClockBudgetMs(budget: Pick<BudgetGuardrail, 'wallClockMinutes'>): number {
  return budget.wallClockMinutes * 60_000;
}

/** The evidence a wall-clock trip carries: the configured limit and the observed elapsed duration, both in milliseconds. */
export interface WallClockTrip {
  dimension: 'wall-clock';
  limitMs: number;
  observedMs: number;
}

/**
 * Decide whether an elapsed duration trips the wall-clock guardrail, given
 * the Step type currently running. Trips iff `stepType` counts toward the
 * execution budget AND `elapsedMs >= wallClockBudgetMs(budget)` (the boundary
 * itself trips). Returns `null` otherwise.
 */
export function wallClockTrip(args: {
  elapsedMs: number;
  stepType: StepType | null;
  budget: Pick<BudgetGuardrail, 'wallClockMinutes'>;
}): WallClockTrip | null {
  if (!countsTowardExecutionBudget(args.stepType)) return null;
  const limitMs = wallClockBudgetMs(args.budget);
  if (args.elapsedMs < limitMs) return null;
  return { dimension: 'wall-clock', limitMs, observedMs: args.elapsedMs };
}

/** Render a millisecond duration at whichever unit keeps the number small: minutes, seconds, or raw milliseconds. */
export function humanizeMs(ms: number): string {
  if (ms >= 60_000) return `${Math.round(ms / 60_000)}m`;
  if (ms >= 1_000) return `${Math.round(ms / 1_000)}s`;
  return `${ms}ms`;
}

/** The evidence a token-budget trip carries: the configured cap and the cumulative count that reached it. */
export interface TokenTrip {
  dimension: 'tokens';
  limitTokens: number;
  observedTokens: number;
}

/**
 * The evidence a cost-budget trip carries: the configured USD cap and the
 * priced spend floor that reached it. `observedUsd` is a lower bound when
 * some tokens went unpriced; a floor already over the cap is still a trip.
 */
export interface CostTrip {
  dimension: 'cost';
  limitUsd: number;
  observedUsd: number;
}

/**
 * Result of evaluating the live token/cost spend guards this poll.
 * `unmeasurable` means the guard is configured but telemetry is missing —
 * distinct from `ok`, so a configured cap never silently degrades to a no-op.
 */
export type SpendOutcome =
  | { kind: 'trip'; trip: TokenTrip | CostTrip }
  | { kind: 'unmeasurable'; dimension: 'tokens' | 'cost' }
  | { kind: 'ok' };

function tokenOutcome(limitTokens: number, observedTokens: number | null): SpendOutcome {
  if (observedTokens === null) return { kind: 'unmeasurable', dimension: 'tokens' };
  if (observedTokens >= limitTokens) {
    return { kind: 'trip', trip: { dimension: 'tokens', limitTokens, observedTokens } };
  }
  return { kind: 'ok' };
}

/**
 * Decide whether the live token/cost spend guards trip, given the Step type
 * currently running and this poll's observed usage. Step-scoped like
 * `wallClockTrip`. A priced floor already over the cost cap trips even when
 * `costIncomplete`; an unpriced or partially-priced cost cap falls back to
 * enforcing the token cap; once cost is fully priced and under the cap, the
 * token cap (if configured) still applies independently.
 */
export function spendTrip(args: {
  stepType: StepType | null;
  budget: Pick<BudgetGuardrail, 'tokens' | 'costUsd'>;
  observedTokens: number | null;
  observedUsd: number | null;
  costIncomplete: boolean;
}): SpendOutcome {
  if (!countsTowardExecutionBudget(args.stepType)) return { kind: 'ok' };

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
  }

  if (tokens !== null) return tokenOutcome(tokens, observedTokens);
  return { kind: 'ok' };
}

/**
 * The human-readable card reason for a guardrail trip. Names the configured
 * bound, never the overshoot: "budget: 45m", "budget: 2M tokens", "budget: $10".
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

/** Render a token count at whichever unit keeps the number small, to at most one decimal: `1_500_000` -> "1.5M". */
export function humanizeCount(n: number): string {
  const trim = (x: number): number => Number(x.toFixed(1));
  if (n >= 1_000_000) return `${trim(n / 1_000_000)}M`;
  if (n >= 1_000) return `${trim(n / 1_000)}K`;
  return `${n}`;
}

/** Render a USD amount rounded to at most two decimals with trailing zeroes dropped: `10.5` -> "$10.5". */
export function formatUsd(usd: number): string {
  return `$${Number(usd.toFixed(2))}`;
}

/** USD → micro-dollars: the integer scale the `guardrail_events` limit/observed columns store a cost trip in. */
export function toMicroUsd(usd: number): number {
  return Math.round(usd * 1_000_000);
}

/** The card reason when a configured spend guard cannot be measured because usage telemetry is missing. */
export function formatUnmeasurableReason(dimension: 'tokens' | 'cost'): string {
  return `budget: ${dimension} unmeasurable`;
}
