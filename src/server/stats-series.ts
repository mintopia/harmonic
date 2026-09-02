import { mergeUsage, type AttemptUsage } from '../execution/usage.js';
import type { Cost } from '../domain/pricing.js';
import { isExecutionFailure } from '../domain/attempt-failure.js';

/** One day's bucket in the Stats time series (by run start time). */
export interface DaySeriesEntry {
  /** Epoch ms at local midnight (server timezone) of the bucket's day. */
  day: number;
  /** Cost of attempts started that day; null when nothing could be priced. */
  totalUsd: number | null;
  /** True when any of the day's tokens could not be priced (honest numbers: the value is a floor). */
  incomplete: boolean;
  /** Input + output tokens of attempts started that day (cache excluded); 0 when no usage was reported. */
  tokens: number;
  /** Count of attempts started that day, whatever their state. */
  attempts: number;
  /** Execution failures started that day (failed-only); cancelled Attempts are excluded. */
  fails: number;
}

/** The minimum a run needs to be bucketed and aggregated here. */
export interface DaySeriesRun {
  /** Epoch ms the run started. */
  startedAt: number;
  /** JSON-serialized `AttemptUsage`, or null when the run reported none. */
  usage: string | null;
  /** The run's terminal `state`; omitted rows never count as a failure. */
  state?: string;
}

/** Bucket attempts by local-midnight start day and aggregate cost, input+output tokens (cache excluded), and counts, ordered by day. Pricing is injected via `priceRuns`. */
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
        .map((r) => (r.usage ? (JSON.parse(r.usage) as AttemptUsage) : null))
        .filter((u): u is AttemptUsage => u !== null);
      const merged = mergeUsage(usages);
      const tokens = inputPlusOutput(merged);
      const fails = dayRows.filter((r) =>
        r.state === undefined ? false : isExecutionFailure({ state: r.state }),
      ).length;
      return {
        day,
        totalUsd: cost?.totalUsd ?? null,
        incomplete: cost?.incomplete ?? false,
        tokens,
        attempts: dayRows.length,
        fails,
      };
    });
}

function inputPlusOutput(merged: AttemptUsage | null): number {
  if (!merged) return 0;
  if (merged.totals) return merged.totals.inputTokens + merged.totals.outputTokens;
  return Object.values(merged.models).reduce((sum, m) => sum + m.inputTokens + m.outputTokens, 0);
}
