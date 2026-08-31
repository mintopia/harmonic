import { describe, expect, it } from 'vitest';
import {
  attemptsPerTaskBars,
  attemptsPerTaskTotal,
  costPerMergedTaskFigure,
  costSplit,
  mergedDaySeries,
  mergedPerDayAverage,
  totalMerged,
} from '../web/src/components/flow-throughput-model';
import type { AttemptsPerTask, CostPerMergedTask, MergedDay } from '../web/src/components/flow-throughput-model';
import type { Cost } from '../web/src/types';

const day = (iso: string): number => {
  const d = new Date(iso);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

const cost = (totalUsd: number | null, incomplete = false): Cost => ({ totalUsd, byModel: {}, incomplete });

describe('totalMerged', () => {
  it('sums counts across days', () => {
    const days: MergedDay[] = [{ day: day('2026-08-01'), count: 4 }, { day: day('2026-08-02'), count: 2 }];
    expect(totalMerged(days)).toBe(6);
  });

  it('returns 0 for an empty range', () => {
    expect(totalMerged([])).toBe(0);
  });
});

describe('mergedPerDayAverage', () => {
  it('returns null when the range held no merge', () => {
    expect(mergedPerDayAverage([])).toBeNull();
  });

  it('averages over the days that actually held a merge', () => {
    const days: MergedDay[] = [{ day: day('2026-08-01'), count: 4 }, { day: day('2026-08-02'), count: 2 }];
    expect(mergedPerDayAverage(days)).toBe(3);
  });

  it('reads a single merge day as its own count', () => {
    expect(mergedPerDayAverage([{ day: day('2026-08-01'), count: 5 }])).toBe(5);
  });
});

describe('mergedDaySeries', () => {
  it('gap-fills a bounded range so a quiet middle day reads as 0, preserving order', () => {
    const days: MergedDay[] = [
      { day: day('2026-08-01'), count: 3 },
      { day: day('2026-08-03'), count: 7 },
    ];
    const series = mergedDaySeries(days, day('2026-08-01'), day('2026-08-03'));
    expect(series).toEqual([
      { day: day('2026-08-01'), count: 3 },
      { day: day('2026-08-02'), count: 0 },
      { day: day('2026-08-03'), count: 7 },
    ]);
  });

  it('returns the raw days as-is for an all-time sprawl (span > 62)', () => {
    const days: MergedDay[] = [{ day: day('2020-01-01'), count: 1 }, { day: day('2026-08-31'), count: 9 }];
    const series = mergedDaySeries(days, 0, Date.now());
    expect(series).toBe(days);
  });

  it('returns the raw days as-is for a sub-two-day range (span < 2)', () => {
    const days: MergedDay[] = [{ day: day('2026-08-01'), count: 3 }];
    expect(mergedDaySeries(days, day('2026-08-01'), day('2026-08-01'))).toBe(days);
  });

  it('returns an empty array when there are no merge days', () => {
    expect(mergedDaySeries([], day('2026-08-01'), day('2026-08-03'))).toEqual([]);
  });
});

describe('attemptsPerTaskBars / attemptsPerTaskTotal', () => {
  const hist: AttemptsPerTask = { '1': 18, '2': 5, '3': 2, '4+': 1 };

  it('produces ordered bars with the fixed 1×,2×,3×,4+ labels and counts', () => {
    expect(attemptsPerTaskBars(hist)).toEqual([
      { bucket: '1', label: '1×', count: 18 },
      { bucket: '2', label: '2×', count: 5 },
      { bucket: '3', label: '3×', count: 2 },
      { bucket: '4+', label: '4+', count: 1 },
    ]);
  });

  it('sums all four buckets', () => {
    expect(attemptsPerTaskTotal(hist)).toBe(26);
  });

  it('reads the 1× bucket as tallest for a healthy fleet', () => {
    const bars = attemptsPerTaskBars(hist);
    const maxCount = Math.max(...bars.map((b) => b.count));
    expect(bars.find((b) => b.bucket === '1')!.count).toBe(maxCount);
  });
});

describe('costPerMergedTaskFigure', () => {
  it('divides merged cost by merged tasks', () => {
    const cpm: CostPerMergedTask = { mergedTasks: 26, mergedCost: cost(41.2), wastedCost: null };
    const figure = costPerMergedTaskFigure(cpm);
    expect(figure).not.toBeNull();
    expect(figure!.value).toBeCloseTo(1.5846, 4);
    expect(figure!.isFloor).toBe(false);
  });

  it('returns null when mergedCost is null', () => {
    expect(costPerMergedTaskFigure({ mergedTasks: 26, mergedCost: null, wastedCost: null })).toBeNull();
  });

  it('returns null when there are no merged tasks', () => {
    expect(costPerMergedTaskFigure({ mergedTasks: 0, mergedCost: cost(41.2), wastedCost: null })).toBeNull();
  });

  it('returns null when nothing in the merged cost was priceable', () => {
    expect(costPerMergedTaskFigure({ mergedTasks: 26, mergedCost: cost(null), wastedCost: null })).toBeNull();
  });

  it('flags the figure as a floor when the merged cost is incomplete', () => {
    const cpm: CostPerMergedTask = { mergedTasks: 26, mergedCost: cost(41.2, true), wastedCost: null };
    expect(costPerMergedTaskFigure(cpm)!.isFloor).toBe(true);
  });
});

describe('costSplit', () => {
  it('splits merged vs wasted spend, summing to ~100% with merged the larger share', () => {
    const cpm: CostPerMergedTask = { mergedTasks: 26, mergedCost: cost(41.2), wastedCost: cost(6.4) };
    const split = costSplit(cpm)!;
    expect(split.mergedPct + split.wastedPct).toBeCloseTo(100, 5);
    expect(split.mergedPct).toBeGreaterThan(split.wastedPct);
  });

  it('returns null when neither side is priceable', () => {
    expect(costSplit({ mergedTasks: 0, mergedCost: null, wastedCost: null })).toBeNull();
  });

  it('reads an all-merged split as 100/0 when wasted is null', () => {
    const cpm: CostPerMergedTask = { mergedTasks: 26, mergedCost: cost(41.2), wastedCost: null };
    const split = costSplit(cpm)!;
    expect(split.mergedPct).toBe(100);
    expect(split.wastedPct).toBe(0);
  });

  it('reads an all-wasted split as 0/100 when merged is null', () => {
    const cpm: CostPerMergedTask = { mergedTasks: 0, mergedCost: null, wastedCost: cost(6.4) };
    const split = costSplit(cpm)!;
    expect(split.mergedPct).toBe(0);
    expect(split.wastedPct).toBe(100);
  });

  it('reads a priceable-but-zero total as an all-zero split', () => {
    const cpm: CostPerMergedTask = { mergedTasks: 0, mergedCost: cost(0), wastedCost: cost(0) };
    const split = costSplit(cpm)!;
    expect(split.mergedPct).toBe(0);
    expect(split.wastedPct).toBe(0);
  });

  it('flags the split as a floor when either side is incomplete', () => {
    const cpm: CostPerMergedTask = { mergedTasks: 26, mergedCost: cost(41.2), wastedCost: cost(6.4, true) };
    expect(costSplit(cpm)!.isFloor).toBe(true);
  });
});
