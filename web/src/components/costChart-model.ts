export interface DayCost {
  day: number;
  totalUsd: number | null;
  incomplete: boolean;
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
    out.push(byDay.get(key) ?? { day: key, totalUsd: 0, incomplete: false });
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
