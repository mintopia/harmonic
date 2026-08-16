import { describe, expect, it } from 'vitest';
import { costFloor, fillSeries, type DayCost } from '../web/src/components/costChart-model.js';

// Local midnight, matching how fillSeries normalises day keys.
const day = (y: number, m: number, d: number) => {
  const t = new Date(y, m, d);
  t.setHours(0, 0, 0, 0);
  return t.getTime();
};

describe('fillSeries', () => {
  it('zero-fills a quiet day so a gap reads as $0', () => {
    const d1 = day(2026, 0, 10);
    const d2 = day(2026, 0, 11);
    const d3 = day(2026, 0, 12);
    const out = fillSeries(
      [
        { day: d1, totalUsd: 1, incomplete: false },
        { day: d3, totalUsd: 2, incomplete: false },
      ],
      d1,
      d3,
    );
    expect(out).toHaveLength(3);
    expect(out[1]).toEqual({ day: d2, totalUsd: 0, incomplete: false });
  });

  it('preserves an unpriceable day instead of flattening it to $0', () => {
    const d1 = day(2026, 0, 10);
    const d2 = day(2026, 0, 11);
    const d3 = day(2026, 0, 12);
    const out = fillSeries(
      [
        { day: d1, totalUsd: 1, incomplete: false },
        { day: d2, totalUsd: null, incomplete: false },
        { day: d3, totalUsd: 2, incomplete: false },
      ],
      d1,
      d3,
    );
    expect(out).toHaveLength(3);
    expect(out[1]?.totalUsd).toBeNull();
  });

  it('returns the data as-is for an all-time sprawl (> 62 days)', () => {
    const start = day(2020, 0, 1);
    const end = day(2021, 0, 1);
    const series: DayCost[] = [
      { day: start, totalUsd: 1, incomplete: false },
      { day: end, totalUsd: 2, incomplete: false },
    ];
    expect(fillSeries(series, start, end)).toBe(series);
  });
});

describe('costFloor', () => {
  it('sums an exact total when every day is priced and complete', () => {
    const series: DayCost[] = [
      { day: 1, totalUsd: 1.5, incomplete: false },
      { day: 2, totalUsd: 2.5, incomplete: false },
    ];
    expect(costFloor(series)).toEqual({ total: 4, isFloor: false });
  });

  it('flags a floor and excludes the null day from the sum when a day is unpriceable', () => {
    const series: DayCost[] = [
      { day: 1, totalUsd: 3, incomplete: false },
      { day: 2, totalUsd: null, incomplete: false },
    ];
    expect(costFloor(series)).toEqual({ total: 3, isFloor: true });
  });

  it('flags a floor when a day is incomplete but still priced', () => {
    const series: DayCost[] = [
      { day: 1, totalUsd: 3, incomplete: false },
      { day: 2, totalUsd: 1, incomplete: true },
    ];
    expect(costFloor(series)).toEqual({ total: 4, isFloor: true });
  });
});
