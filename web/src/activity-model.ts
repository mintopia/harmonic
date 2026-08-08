// Explicit .js extensions: this module is shared with the node-side test
// project, whose nodenext resolution requires them (Vite maps .js → .ts).
import type { ActivityProcess, Cost, RunUsage, RunUsageEvent } from './types.js';

/**
 * The Activity view's attention model (issue #52). Every in-flight process is
 * sorted into one of three tiers so the fleet re-ranks by what the operator
 * should look at first — the view holds no state of its own (CONTEXT.md:
 * Activity), so the ranking is a pure function of the snapshot + live deltas.
 *
 * - **Needs you**: an afk Run that escalated to a human (issue #33), or any
 *   process past its context window (degrading — a human should intervene).
 *   These are the only rows that genuinely block on the operator; #55 adds the
 *   resolve action, #54 the pin.
 * - **High load**: a process running hot — context fill at or above
 *   `HIGH_LOAD_FILL` but still under the window. The "watch this one" tier.
 * - **Steady**: everything else, including any process whose window is
 *   unconfigured (no threshold to judge it against — honest, never a fake %).
 */
export const ATTENTION_TIERS = ['needs-you', 'high-load', 'steady'] as const;
export type AttentionTier = (typeof ATTENTION_TIERS)[number];

/** Context fill (fraction of the configured window) that marks a process "running hot". */
export const HIGH_LOAD_FILL = 0.75;

const TIER_LABELS: Record<AttentionTier, string> = {
  'needs-you': 'Needs you',
  'high-load': 'High load',
  steady: 'Steady',
};
export function tierLabel(tier: AttentionTier): string {
  return TIER_LABELS[tier];
}

/**
 * Context-window fill as a fraction, or null when it can't be known honestly:
 * an unknown token count, or a known count with no configured window (the
 * gauge shows raw tokens instead). Deliberately unclamped past 1 — a process
 * can genuinely exceed its window, and that over-fill is exactly the "Needs
 * you" signal below (mirrors conversation-telemetry-model's `computeContextUsage`).
 */
export function contextFillFraction(process: ActivityProcess): number | null {
  const { contextTokens, contextWindow } = process;
  if (contextTokens === null || contextWindow === null) return null;
  return contextTokens / contextWindow;
}

export function attentionTier(process: ActivityProcess): AttentionTier {
  if (process.escalated) return 'needs-you';
  const fill = contextFillFraction(process);
  if (fill === null) return 'steady';
  if (fill >= 1) return 'needs-you';
  if (fill >= HIGH_LOAD_FILL) return 'high-load';
  return 'steady';
}

const TIER_RANK: Record<AttentionTier, number> = { 'needs-you': 0, 'high-load': 1, steady: 2 };

/**
 * Re-rank the fleet by attention: tier first, then context fill (fullest
 * first, unknown-fill last), then the longest-running process (oldest
 * `startedAt`) first. Pure — returns a new array, never mutates the input.
 */
export function rankActivity(processes: ActivityProcess[]): ActivityProcess[] {
  return [...processes].sort((a, b) => {
    const tier = TIER_RANK[attentionTier(a)] - TIER_RANK[attentionTier(b)];
    if (tier !== 0) return tier;
    // Fuller context first; a null fill sorts after any known fill.
    const fa = contextFillFraction(a);
    const fb = contextFillFraction(b);
    if (fa !== fb) {
      if (fa === null) return 1;
      if (fb === null) return -1;
      return fb - fa;
    }
    return a.startedAt - b.startedAt; // longest-running leads
  });
}

/**
 * Accumulated tokens for a process: the harness's own `totalTokens` when it
 * reports one, else the sum of the four counters it always reports. Null usage
 * (no tokens yet) stays null — never a fake zero (the honest-incomplete rule).
 */
export function usageTotalTokens(usage: RunUsage | null): number | null {
  const totals = usage?.totals;
  if (!totals) return null;
  if (totals.totalTokens !== null) return totals.totalTokens;
  return totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheWriteTokens;
}

/** Elapsed run time in ms, floored at 0 so clock skew never shows a negative age. */
export function elapsedMs(process: ActivityProcess, now: number): number {
  return Math.max(0, now - process.startedAt);
}

/**
 * Average token throughput since the process started (tokens ÷ elapsed
 * seconds). 0 before any tokens or before any elapsed time — an average rate,
 * summed across the fleet for the summary strip's "tok/s".
 */
export function tokensPerSecond(process: ActivityProcess, now: number): number {
  const tokens = usageTotalTokens(process.usage);
  const seconds = elapsedMs(process, now) / 1000;
  if (tokens === null || seconds <= 0) return 0;
  return tokens / seconds;
}

/**
 * Aggregate a set of Costs into one honest floor (the fleet's live Cost).
 * Null when nothing is priceable; otherwise the sum of priced totals, flagged
 * `incomplete` (a "≥" floor) if any member was incomplete or could not be
 * priced — mirrors `Task.cost` and `formatCost`'s honest-incomplete contract.
 */
export function sumCosts(costs: (Cost | null | undefined)[]): Cost | null {
  const present = costs.filter((c): c is Cost => !!c);
  if (present.length === 0) return null;
  let total: number | null = null;
  let incomplete = false;
  const modelSums: Record<string, number> = {};
  const modelNull = new Set<string>();
  for (const c of present) {
    if (c.incomplete) incomplete = true;
    if (c.totalUsd === null) incomplete = true; // usage existed but none priced
    else total = (total ?? 0) + c.totalUsd;
    for (const [model, v] of Object.entries(c.byModel)) {
      if (v === null) {
        modelNull.add(model);
        incomplete = true;
      } else {
        modelSums[model] = (modelSums[model] ?? 0) + v;
      }
    }
  }
  const byModel: Record<string, number | null> = {};
  for (const model of new Set([...Object.keys(modelSums), ...modelNull])) {
    byModel[model] = modelSums[model] ?? null;
  }
  return { totalUsd: total, byModel, incomplete };
}

/**
 * Merge a live `run_usage` delta into the matching Run row (by `runId`),
 * refreshing its Usage, context fill, activity line, Process Tree, and Cost.
 * Returns the same array reference when nothing matches — a Conversation is
 * never touched (it has no `runId`), and a no-op skips a needless re-render.
 */
export function mergeRunUsage(processes: ActivityProcess[], event: RunUsageEvent): ActivityProcess[] {
  if (!processes.some((p) => p.type === 'run' && p.runId === event.runId)) return processes;
  return processes.map((p) =>
    p.type === 'run' && p.runId === event.runId
      ? {
          ...p,
          usage: event.usage,
          contextTokens: event.contextTokens,
          activity: event.activity,
          tree: event.tree,
          cost: event.cost,
        }
      : p,
  );
}

/** The summary strip's figures (issue #52): the one-glance fleet readout above the rows. */
export interface ActivitySummary {
  /** In-flight Runs (afk work) — the machine-ceiling numerator. */
  runningCount: number;
  /** Rows in the "Needs you" tier — the count that should pull the eye. */
  needsYouCount: number;
  /** Fleet Cost as an honest floor across every process; null when nothing is priceable. */
  cost: Cost | null;
  /** Summed average token throughput across the fleet. */
  tokensPerSecond: number;
  /** Runs in flight against the Machine Ceiling (the global concurrent-Run cap). */
  ceiling: { running: number; max: number };
}

export function activitySummary(
  processes: ActivityProcess[],
  machineCeiling: number,
  now: number,
): ActivitySummary {
  const runningCount = processes.filter((p) => p.type === 'run').length;
  return {
    runningCount,
    needsYouCount: processes.filter((p) => attentionTier(p) === 'needs-you').length,
    cost: sumCosts(processes.map((p) => p.cost)),
    tokensPerSecond: processes.reduce((sum, p) => sum + tokensPerSecond(p, now), 0),
    ceiling: { running: runningCount, max: machineCeiling },
  };
}
