import { usd } from '../cost.js';

export interface DayCost {
  day: number;
  totalUsd: number | null;
  incomplete: boolean;
  /** Input + output tokens of that day's runs (cache excluded). Always concrete, never null. */
  tokens: number;
  /** Count of runs started that day. Always concrete, never null. */
  runs: number;
  /** Execution failures started that day (failed-only). The server always sends
   *  it; optional so older cached shapes and count-only test fixtures still fit. */
  fails?: number;
}

/** Zero-fill the gaps between buckets so a quiet day reads as $0, not as
 * a skipped point — but only over ranges small enough to label honestly.
 * A day already present with an unpriceable (null) total is preserved as-is:
 * it is *not* a quiet day, so it must never be flattened to $0. */
export function fillSeries(series: DayCost[], from: number, to: number): DayCost[] {
  const first = series[0];
  if (!first) return [];
  const DAY = 24 * 3600_000;
  const start = new Date(Math.max(from, first.day));
  start.setHours(0, 0, 0, 0);
  const end = new Date(Math.min(to, Date.now()));
  end.setHours(0, 0, 0, 0);
  const span = Math.round((end.getTime() - start.getTime()) / DAY) + 1;
  if (span < 2 || span > 62) return series; // all-time sprawl: plot the data as-is
  const byDay = new Map(series.map((s) => [s.day, s]));
  const out: DayCost[] = [];
  for (let i = 0; i < span; i++) {
    const d = new Date(start.getTime() + i * DAY + DAY / 2); // DST-safe: mid-day, then floor
    d.setHours(0, 0, 0, 0);
    const key = d.getTime();
    out.push(byDay.get(key) ?? { day: key, totalUsd: 0, incomplete: false, tokens: 0, runs: 0, fails: 0 });
  }
  return out;
}

/**
 * Aggregate a day series into a single figure. Unpriceable (null) days
 * contribute nothing to the sum but — like incomplete days — make the total
 * a floor rather than an exact number: the real spend is *at least* this.
 */
export function costFloor(series: DayCost[]): { total: number; isFloor: boolean } {
  let total = 0;
  let isFloor = false;
  for (const s of series) {
    if (s.totalUsd === null || s.incomplete) isFloor = true;
    total += s.totalUsd ?? 0;
  }
  return { total, isFloor };
}

/** The daily-chart metric a day series can be plotted by. The `usd`/`tokens`/`runs`
 *  trio drives the toggle; `fails` is plotted on its own in the reliability section. */
export type StatMetric = 'usd' | 'tokens' | 'runs' | 'fails';

/** The metric's heading label ("Cost per day", the toggle button text). */
export const METRIC_LABEL: Record<StatMetric, string> = { usd: 'Cost', tokens: 'Tokens', runs: 'Runs', fails: 'Fails' };

/** Compact figure formatting for token counts ("21.9k", "1.2M"). */
const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

/** Format one day's value for the selected metric — money for usd, compact
 * counts for tokens, a plain integer for runs. `v` is only ever null for usd. */
export function formatMetric(v: number | null, metric: StatMetric): string {
  if (metric === 'usd') return v === null ? 'unpriced' : usd(v);
  if (metric === 'tokens') return compact.format(v ?? 0);
  return (v ?? 0).toLocaleString();
}

/**
 * Read one day's figure for the selected metric. Only the usd metric can be
 * null (unpriceable); tokens/runs are always concrete numbers.
 */
export function metricValue(d: DayCost, metric: StatMetric): number | null {
  switch (metric) {
    case 'usd':
      return d.totalUsd;
    case 'tokens':
      return d.tokens;
    case 'runs':
      return d.runs;
    case 'fails':
      return d.fails ?? 0;
  }
}

/**
 * A running total of the selected metric, one point per input day. Mirrors
 * costFloor's honesty: for the usd metric, a null or incomplete day
 * contributes 0 to the running sum but flips `isFloor` true — and it stays
 * true for every later point, since a floor early in the range makes every
 * total downstream of it a floor too. tokens/runs are always concrete, so
 * isFloor is always false for them.
 */
export function cumulative(series: DayCost[], metric: StatMetric): { day: number; value: number; isFloor: boolean }[] {
  let running = 0;
  let isFloor = false;
  return series.map((s) => {
    if (metric === 'usd' && (s.totalUsd === null || s.incomplete)) isFloor = true;
    const v = metricValue(s, metric);
    running += v ?? 0;
    return { day: s.day, value: running, isFloor };
  });
}
