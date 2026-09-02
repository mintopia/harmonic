export interface RunTimings {
  /** Attempt start (epoch ms). */
  startedAt: number;
  /** Attempt finish (epoch ms), or null while it has not settled. */
  finishedAt: number | null;
  /** The `agent-finish/unresolved` timestamp (epoch ms), or null when the Attempt recorded none. */
  agentFinishTs: number | null;
}

/**
 * The Attempt's active-execution duration in ms — start to `agent-finish`,
 * falling back to `finished − started` — or null when it can't be measured
 * (no end timestamp, or a negative span). Never a fabricated 0.
 */
export function activeExecutionDurationMs({ startedAt, finishedAt, agentFinishTs }: RunTimings): number | null {
  const end = agentFinishTs ?? finishedAt;
  if (end === null) return null;
  const ms = end - startedAt;
  return ms >= 0 ? ms : null;
}

/**
 * The p-th percentile (0..100) of a non-empty set, by linear interpolation
 * between the two closest ranks — so the median of an even-length set is the
 * average of its two middle values. Input order is irrelevant.
 */
export function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const loVal = sorted[lo] as number;
  const hiVal = sorted[hi] as number;
  if (lo === hi) return loVal;
  return loVal + (hiVal - loVal) * (rank - lo);
}

/**
 * p50 / p95 of a set of active-execution durations, or null when the set is
 * empty — the headline has nothing honest to report rather than a fake zero.
 */
export function durationPercentiles(durations: number[]): { p50: number; p95: number } | null {
  if (durations.length === 0) return null;
  return { p50: percentile(durations, 50), p95: percentile(durations, 95) };
}
