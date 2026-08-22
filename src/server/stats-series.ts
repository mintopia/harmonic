import { mergeUsage, type RunUsage } from '../execution/usage.js';
import type { Cost } from '../execution/pricing.js';
import { isExecutionFailure } from '../domain/run-failure.js';

/** One day's bucket in the Stats time series (by run start time). */
export interface DaySeriesEntry {
  /** Epoch ms at local midnight (server timezone) of the bucket's day. */
  day: number;
  /** Cost of runs started that day; null when nothing could be priced. */
  totalUsd: number | null;
  /** True when any of the day's tokens could not be priced (honest numbers: the value is a floor). */
  incomplete: boolean;
  /** Input + output tokens of runs started that day (cache excluded); 0 when no usage was reported. */
  tokens: number;
  /** Count of runs started that day, whatever their state. */
  runs: number;
  /** Execution failures started that day (failed-only, ADR-0028): the reliability
   *  section's fails/day trend. Cancelled and review-rejected Runs are excluded. */
  fails: number;
}

/** The minimum a run needs to be bucketed and aggregated here. */
export interface DaySeriesRun {
  /** Epoch ms the run started. */
  startedAt: number;
  /** JSON-serialized `RunUsage`, or null when the run reported none. */
  usage: string | null;
  /** The run's terminal `state`; omitted rows never count as a failure. */
  state?: string;
  /** The run's review decision ('rejected' keeps it out of the fails count). */
  review?: string | null;
}

/**
 * Bucket runs by local-midnight day (by start time) and aggregate, per day:
 * cost, input+output tokens (cache excluded), and run count — ordered by day.
 *
 * Pricing is injected (`priceRuns`) rather than reached for so this stays a
 * pure, testable seam: the route passes `costOfRuns`,
 * preserving the honest-numbers floor (`incomplete`) exactly as the range total
 * computes it. Tokens are a straight sum of what each run reported, so a day
 * whose runs logged no usage reads as 0 tokens (an honest count, not a price).
 */
export function buildDaySeries<T extends DaySeriesRun>(
  rows: T[],
  priceRuns: (dayRows: T[]) => Cost | null,
): DaySeriesEntry[] {
  const byDay = new Map<number, T[]>();
  for (const run of rows) {
    const d = new Date(run.startedAt);
    d.setHours(0, 0, 0, 0);
    const day = d.getTime();
    const bucket = byDay.get(day);
    if (bucket) bucket.push(run);
    else byDay.set(day, [run]);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => a - b)
    .map(([day, dayRows]) => {
      const cost = priceRuns(dayRows);
      const usages = dayRows
        .map((r) => (r.usage ? (JSON.parse(r.usage) as RunUsage) : null))
        .filter((u): u is RunUsage => u !== null);
      const merged = mergeUsage(usages);
      const tokens = inputPlusOutput(merged);
      const fails = dayRows.filter((r) =>
        r.state === undefined ? false : isExecutionFailure({ state: r.state, review: r.review ?? null }),
      ).length;
      return {
        day,
        totalUsd: cost?.totalUsd ?? null,
        incomplete: cost?.incomplete ?? false,
        tokens,
        runs: dayRows.length,
        fails,
      };
    });
}

/**
 * Input + output tokens of a merged usage, cache excluded. Prefers the reported
 * aggregate `totals` (authoritative, and what the range headline uses — an ACP
 * run may report totals with no per-model split); falls back to summing the
 * per-model buckets when no aggregate was reported (the session-log path).
 */
function inputPlusOutput(merged: RunUsage | null): number {
  if (!merged) return 0;
  if (merged.totals) return merged.totals.inputTokens + merged.totals.outputTokens;
  return Object.values(merged.models).reduce((sum, m) => sum + m.inputTokens + m.outputTokens, 0);
}
