import type { Cost } from '../types.js';

export interface MergedDay {
  day: number;
  count: number;
}

export type AttemptsPerTask = { '1': number; '2': number; '3': number; '4+': number };

export interface CostPerMergedTask {
  mergedTasks: number;
  mergedCost: Cost | null;
  wastedCost: Cost | null;
}

export interface HistoBar {
  bucket: keyof AttemptsPerTask;
  label: string;
  count: number;
}

export interface CostSplit {
  mergedUsd: number;
  wastedUsd: number;
  mergedPct: number;
  wastedPct: number;
  isFloor: boolean;
}

/** Total merges across the range. 0 is the honest empty state, not hidden. */
export function totalMerged(days: MergedDay[]): number {
  return days.reduce((sum, d) => sum + d.count, 0);
}

/**
 * Merged-per-day average over days that actually held a merge (the server
 * only sends those days, so `days.length` is the true denominator). null —
 * never a fabricated 0 — when the range held no merge at all.
 */
export function mergedPerDayAverage(days: MergedDay[]): number | null {
  if (days.length === 0) return null;
  return totalMerged(days) / days.length;
}

/**
 * Gap-fill the requested [from,to] range for the sparkline so quiet days read
 * as 0 merges, not skipped points. Mirrors costChart-model's fillSeries bounds
 * exactly: outside the 2–62 day span it returns the raw days as-is (all-time
 * sprawl isn't zero-filled), and uses the same DST-safe mid-day-then-floor
 * stepping.
 */
export function mergedDaySeries(days: MergedDay[], from: number, to: number): MergedDay[] {
  if (days.length === 0) return [];
  const DAY = 24 * 3600_000;
  const start = new Date(from);
  start.setHours(0, 0, 0, 0);
  const end = new Date(Math.min(to, Date.now()));
  end.setHours(0, 0, 0, 0);
  const span = Math.round((end.getTime() - start.getTime()) / DAY) + 1;
  if (span < 2 || span > 62) return days;
  const byDay = new Map(days.map((d) => [d.day, d]));
  const out: MergedDay[] = [];
  for (let i = 0; i < span; i++) {
    const d = new Date(start.getTime() + i * DAY + DAY / 2);
    d.setHours(0, 0, 0, 0);
    const key = d.getTime();
    out.push(byDay.get(key) ?? { day: key, count: 0 });
  }
  return out;
}

const BUCKET_LABELS: Record<keyof AttemptsPerTask, string> = { '1': '1×', '2': '2×', '3': '3×', '4+': '4+' };
const BUCKET_ORDER: (keyof AttemptsPerTask)[] = ['1', '2', '3', '4+'];

/** Ordered histogram bars (1×,2×,3×,4+) — a fixed, honest bucket order so the
 * shape of the fleet's attempts-to-settle distribution reads consistently. */
export function attemptsPerTaskBars(hist: AttemptsPerTask): HistoBar[] {
  return BUCKET_ORDER.map((bucket) => ({ bucket, label: BUCKET_LABELS[bucket], count: hist[bucket] }));
}

/** Total merged Tasks represented by the histogram. 0 is the empty state. */
export function attemptsPerTaskTotal(hist: AttemptsPerTask): number {
  return BUCKET_ORDER.reduce((sum, bucket) => sum + hist[bucket], 0);
}

/**
 * $ per merged Task = mergedCost ÷ mergedTasks. null — never a fabricated
 * number — when there is no merged cost, nothing in it was priceable, or
 * there are no merged Tasks to divide by. isFloor mirrors mergedCost's own
 * incomplete flag: some tokens were unpriced, so the per-task figure is a
 * floor, not an exact number.
 */
export function costPerMergedTaskFigure(cpm: CostPerMergedTask): { value: number; isFloor: boolean } | null {
  const { mergedCost, mergedTasks } = cpm;
  if (!mergedCost || mergedCost.totalUsd === null || mergedTasks <= 0) return null;
  return { value: mergedCost.totalUsd / mergedTasks, isFloor: mergedCost.incomplete };
}

/**
 * Merged vs wasted spend as a reconciling split. A null-or-unpriceable side
 * counts as 0 usd; the split is null only when neither side is priceable at
 * all (nothing honest to show, not a fake 50/50). isFloor propagates from
 * either side's incomplete flag, since a floor on either half makes the split
 * itself a floor.
 */
export function costSplit(cpm: CostPerMergedTask): CostSplit | null {
  const { mergedCost, wastedCost } = cpm;
  const mergedPriceable = mergedCost != null && mergedCost.totalUsd !== null;
  const wastedPriceable = wastedCost != null && wastedCost.totalUsd !== null;
  if (!mergedPriceable && !wastedPriceable) return null;

  const mergedUsd = mergedPriceable ? mergedCost.totalUsd! : 0;
  const wastedUsd = wastedPriceable ? wastedCost.totalUsd! : 0;
  const isFloor = Boolean(mergedCost?.incomplete) || Boolean(wastedCost?.incomplete);
  const total = mergedUsd + wastedUsd;
  if (total === 0) return { mergedUsd, wastedUsd, mergedPct: 0, wastedPct: 0, isFloor };
  return { mergedUsd, wastedUsd, mergedPct: (mergedUsd / total) * 100, wastedPct: (wastedUsd / total) * 100, isFloor };
}
