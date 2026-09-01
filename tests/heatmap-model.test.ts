import { describe, expect, it } from 'vitest';
import { buildHeatmap, heatLevel, HEATMAP_WEEKS } from '../web/src/components/heatmap-model';
import type { DayCost } from '../web/src/components/costChart-model';

const day = (iso: string): number => {
  const d = new Date(iso);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

const cell = (iso: string, attempts: number): DayCost => ({
  day: day(iso),
  totalUsd: 0,
  incomplete: false,
  tokens: 0,
  attempts,
});

describe('heatLevel', () => {
  it('maps zero attempts to the empty level', () => {
    expect(heatLevel(0, 10)).toBe(0);
  });

  it('scales 1–4 against the busiest day, floor 1 and ceil 4', () => {
    expect(heatLevel(1, 10)).toBe(1);
    expect(heatLevel(5, 10)).toBe(2);
    expect(heatLevel(6, 10)).toBe(3);
    expect(heatLevel(10, 10)).toBe(4);
  });

  it('puts the busiest day at the top even when the max is tiny', () => {
    expect(heatLevel(1, 1)).toBe(4);
  });

  it('never divides by a zero or negative max', () => {
    expect(heatLevel(3, 0)).toBe(0);
  });
});

describe('buildHeatmap', () => {
  // 2026-08-31 is a Monday (getDay 1).
  const now = new Date('2026-08-31T12:00:00').getTime();

  it('produces a fixed weeks × 7 grid', () => {
    const hm = buildHeatmap([], now);
    expect(hm.weeks).toHaveLength(HEATMAP_WEEKS);
    for (const col of hm.weeks) expect(col).toHaveLength(7);
  });

  it('anchors the window to a Sunday and ends on today', () => {
    const hm = buildHeatmap([], now);
    expect(new Date(hm.from).getDay()).toBe(0);
    expect(hm.to).toBe(day('2026-08-31'));
  });

  it('places a day at its correct week column and weekday row', () => {
    const hm = buildHeatmap([cell('2026-08-31', 4)], now);
    // Today (Monday) sits in the last column, row 1 (Monday).
    const last = hm.weeks[HEATMAP_WEEKS - 1]!;
    expect(last[1]).toMatchObject({ attempts: 4, level: 4 });
    expect(last[0]).toMatchObject({ attempts: 0, level: 0 }); // Sunday, quiet
  });

  it('fills quiet days as empty cells rather than omitting them', () => {
    const hm = buildHeatmap([cell('2026-08-31', 4)], now);
    const filled = hm.weeks.flat().filter((c) => c !== null);
    // Every past day in the window is present; none are dropped for being quiet.
    expect(filled.every((c) => c!.attempts >= 0)).toBe(true);
    expect(filled.some((c) => c!.attempts === 0 && c!.level === 0)).toBe(true);
  });

  it('leaves days after today null in the trailing week', () => {
    const hm = buildHeatmap([], now);
    const last = hm.weeks[HEATMAP_WEEKS - 1]!;
    // Monday is today; Tue–Sat are the future and must be gaps, not empty cells.
    expect(last.slice(2)).toEqual([null, null, null, null, null]);
  });

  it('re-keys server day keys that fall off the client midnight grid', () => {
    // The /stats series carries day keys at the *server's* local midnight; a
    // viewer in another timezone (UTC server, a BST/EDT browser) sees each key
    // offset from its own midnight. The count must still land in that calendar
    // day, not vanish — the regression behind the blank live-instance heatmap.
    const offGrid: DayCost = { ...cell('2026-08-31', 4), day: day('2026-08-31') + 3 * 3600_000 };
    const hm = buildHeatmap([offGrid], now);
    expect(hm.total).toBe(4);
    const last = hm.weeks[HEATMAP_WEEKS - 1]!;
    expect(last[1]).toMatchObject({ attempts: 4, level: 4 });
  });

  it('scales levels to the busiest day and totals only in-window attempts', () => {
    const hm = buildHeatmap(
      [cell('2026-08-31', 10), cell('2026-08-30', 5), cell('2020-01-01', 99)],
      now,
    );
    expect(hm.max).toBe(10);
    expect(hm.total).toBe(15); // the 2020 day is outside the window
    const last = hm.weeks[HEATMAP_WEEKS - 1]!;
    expect(last[1]!.level).toBe(4); // 10/10
    expect(last[0]!.level).toBe(2); // 5/10 → ceil(2)
  });
});
