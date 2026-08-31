import type { DayCost } from './costChart-model';

/** Weeks in the heatmap's fixed trailing window. Deliberately independent of the
 *  Stats page's KPI range toggle: the calendar always shows the same span so the
 *  rhythm of attempt activity reads the same whatever range the KPIs are on. */
export const HEATMAP_WEEKS = 26;

/** 0 = no attempts (empty tone); 1–4 = teal intensity, scaled to the busiest day. */
export type HeatLevel = 0 | 1 | 2 | 3 | 4;

export interface HeatCell {
  /** Local-midnight epoch ms of this day, matching DayCost.day. The window is
   *  anchored in the viewer's local time, which tracks the server's day keys as
   *  fillSeries already assumes; a viewer in a far-off timezone can shift a
   *  count by a day at the midnight boundary. */
  day: number;
  attempts: number;
  level: HeatLevel;
}

export interface Heatmap {
  /** Columns oldest → newest. Each holds 7 slots, index 0 = Sunday … 6 = Saturday;
   *  a slot is null only when its day falls after today in the trailing partial
   *  week (a future day), so it renders as a gap rather than an empty cell. */
  weeks: (HeatCell | null)[][];
  /** The busiest day's attempt count in the window — the top of the ramp. */
  max: number;
  /** Total attempts across the window. */
  total: number;
  /** Window bounds, local-midnight ms, inclusive. `from` is always a Sunday. */
  from: number;
  to: number;
}

function midnight(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Step whole calendar days off a local-midnight ms and re-floor — DST-safe, so
 *  a spring-forward day still advances by exactly one weekday. */
function addDays(ms: number, n: number): number {
  const d = new Date(ms);
  d.setDate(d.getDate() + n);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Bucket a day's attempt count into a 0–4 level, scaled to the window's busiest
 *  day: 0 attempts is empty, the busiest day is always 4, and a single attempt is
 *  always at least 1 so a quiet day is never lost to rounding. */
export function heatLevel(attempts: number, max: number): HeatLevel {
  if (attempts <= 0 || max <= 0) return 0;
  return Math.min(4, Math.max(1, Math.ceil((attempts / max) * 4))) as HeatLevel;
}

/** Build a GitHub-style weeks × weekdays grid of attempts/day over a fixed
 *  trailing window ending on `now`'s day. The window is anchored to whole weeks
 *  (Sunday-start), quiet days are filled with zero-attempt cells so gaps read as
 *  empty rather than vanishing, and days after today are left null. */
export function buildHeatmap(series: DayCost[], now: number, weeks = HEATMAP_WEEKS): Heatmap {
  const today = midnight(now);
  const lastSunday = addDays(today, -new Date(today).getDay());
  const from = addDays(lastSunday, -(weeks - 1) * 7);
  const byDay = new Map(series.map((s) => [s.day, s.attempts]));

  const grid: (HeatCell | null)[][] = [];
  let max = 0;
  let total = 0;
  for (let w = 0; w < weeks; w++) {
    const col: (HeatCell | null)[] = [];
    for (let r = 0; r < 7; r++) {
      const day = addDays(from, w * 7 + r);
      if (day > today) {
        col.push(null);
        continue;
      }
      const attempts = byDay.get(day) ?? 0;
      total += attempts;
      if (attempts > max) max = attempts;
      col.push({ day, attempts, level: 0 });
    }
    grid.push(col);
  }
  for (const col of grid) for (const cell of col) if (cell) cell.level = heatLevel(cell.attempts, max);

  return { weeks: grid, max, total, from, to: today };
}
