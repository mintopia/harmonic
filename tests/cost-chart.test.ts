import { describe, expect, it } from 'vitest';
import { costFloor, cumulative, fillSeries, metricValue, type DayCost } from '../web/src/components/costChart-model.js';

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
        { day: d1, totalUsd: 1, incomplete: false, tokens: 100, attempts: 1 },
        { day: d3, totalUsd: 2, incomplete: false, tokens: 200, attempts: 2 },
      ],
      d1,
      d3,
    );
    expect(out).toHaveLength(3);
    expect(out[1]).toEqual({ day: d2, totalUsd: 0, incomplete: false, tokens: 0, attempts: 0, fails: 0 });
  });

  it('matches a server day key that sits off the client midnight grid', () => {
    const d1 = day(2026, 0, 10);
    const d2 = day(2026, 0, 11);
    const offGrid = d2 + 3 * 3600_000;
    const out = fillSeries(
      [
        { day: d1, totalUsd: 1, incomplete: false, tokens: 100, attempts: 1 },
        { day: offGrid, totalUsd: 2, incomplete: false, tokens: 200, attempts: 2 },
      ],
      d1,
      d2,
    );
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({ totalUsd: 2, tokens: 200, attempts: 2 });
  });

  it('zero-fills leading quiet days so a recent first run still produces a graph', () => {
    const d1 = day(2026, 0, 10);
    const d2 = day(2026, 0, 11);
    const d3 = day(2026, 0, 12);
    const out = fillSeries([{ day: d3, totalUsd: 2, incomplete: false, tokens: 200, attempts: 1 }], d1, d3);

    expect(out).toEqual([
      { day: d1, totalUsd: 0, incomplete: false, tokens: 0, attempts: 0, fails: 0 },
      { day: d2, totalUsd: 0, incomplete: false, tokens: 0, attempts: 0, fails: 0 },
      { day: d3, totalUsd: 2, incomplete: false, tokens: 200, attempts: 1 },
    ]);
  });

  it('preserves an unpriceable day instead of flattening it to $0', () => {
    const d1 = day(2026, 0, 10);
    const d2 = day(2026, 0, 11);
    const d3 = day(2026, 0, 12);
    const out = fillSeries(
      [
        { day: d1, totalUsd: 1, incomplete: false, tokens: 10, attempts: 1 },
        { day: d2, totalUsd: null, incomplete: false, tokens: 5, attempts: 1 },
        { day: d3, totalUsd: 2, incomplete: false, tokens: 20, attempts: 1 },
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
      { day: start, totalUsd: 1, incomplete: false, tokens: 10, attempts: 1 },
      { day: end, totalUsd: 2, incomplete: false, tokens: 20, attempts: 2 },
    ];
    expect(fillSeries(series, start, end)).toBe(series);
  });
});

describe('costFloor', () => {
  it('sums an exact total when every day is priced and complete', () => {
    const series: DayCost[] = [
      { day: 1, totalUsd: 1.5, incomplete: false, tokens: 10, attempts: 1 },
      { day: 2, totalUsd: 2.5, incomplete: false, tokens: 20, attempts: 1 },
    ];
    expect(costFloor(series)).toEqual({ total: 4, isFloor: false });
  });

  it('flags a floor and excludes the null day from the sum when a day is unpriceable', () => {
    const series: DayCost[] = [
      { day: 1, totalUsd: 3, incomplete: false, tokens: 10, attempts: 1 },
      { day: 2, totalUsd: null, incomplete: false, tokens: 5, attempts: 1 },
    ];
    expect(costFloor(series)).toEqual({ total: 3, isFloor: true });
  });

  it('flags a floor when a day is incomplete but still priced', () => {
    const series: DayCost[] = [
      { day: 1, totalUsd: 3, incomplete: false, tokens: 10, attempts: 1 },
      { day: 2, totalUsd: 1, incomplete: true, tokens: 5, attempts: 1 },
    ];
    expect(costFloor(series)).toEqual({ total: 4, isFloor: true });
  });
});

describe('metricValue', () => {
  const d: DayCost = { day: 1, totalUsd: 3.5, incomplete: false, tokens: 1200, attempts: 4 };
  const dNull: DayCost = { day: 2, totalUsd: null, incomplete: false, tokens: 0, attempts: 0 };

  it('reads the usd metric, which may be null', () => {
    expect(metricValue(d, 'usd')).toBe(3.5);
    expect(metricValue(dNull, 'usd')).toBeNull();
  });

  it('reads the tokens metric, always a concrete number', () => {
    expect(metricValue(d, 'tokens')).toBe(1200);
    expect(metricValue(dNull, 'tokens')).toBe(0);
  });

  it('reads the runs metric, always a concrete number', () => {
    expect(metricValue(d, 'attempts')).toBe(4);
    expect(metricValue(dNull, 'attempts')).toBe(0);
  });
});

describe('cumulative', () => {
  it('produces a running total, one point per input day', () => {
    const series: DayCost[] = [
      { day: 1, totalUsd: 1, incomplete: false, tokens: 100, attempts: 1 },
      { day: 2, totalUsd: 2, incomplete: false, tokens: 200, attempts: 2 },
      { day: 3, totalUsd: 3, incomplete: false, tokens: 300, attempts: 3 },
    ];
    expect(cumulative(series, 'usd')).toEqual([
      { day: 1, value: 1, isFloor: false },
      { day: 2, value: 3, isFloor: false },
      { day: 3, value: 6, isFloor: false },
    ]);
    expect(cumulative(series, 'tokens')).toEqual([
      { day: 1, value: 100, isFloor: false },
      { day: 2, value: 300, isFloor: false },
      { day: 3, value: 600, isFloor: false },
    ]);
    expect(cumulative(series, 'attempts')).toEqual([
      { day: 1, value: 1, isFloor: false },
      { day: 2, value: 3, isFloor: false },
      { day: 3, value: 6, isFloor: false },
    ]);
  });

  it('flips isFloor on a null usd day and keeps it flipped for later points, contributing 0 to the sum', () => {
    const series: DayCost[] = [
      { day: 1, totalUsd: 1, incomplete: false, tokens: 100, attempts: 1 },
      { day: 2, totalUsd: null, incomplete: false, tokens: 50, attempts: 1 },
      { day: 3, totalUsd: 3, incomplete: false, tokens: 300, attempts: 3 },
    ];
    expect(cumulative(series, 'usd')).toEqual([
      { day: 1, value: 1, isFloor: false },
      { day: 2, value: 1, isFloor: true },
      { day: 3, value: 4, isFloor: true },
    ]);
  });

  it('flips isFloor on an incomplete usd day (still priced, still adds to the sum)', () => {
    const series: DayCost[] = [
      { day: 1, totalUsd: 1, incomplete: false, tokens: 100, attempts: 1 },
      { day: 2, totalUsd: 2, incomplete: true, tokens: 50, attempts: 1 },
    ];
    expect(cumulative(series, 'usd')).toEqual([
      { day: 1, value: 1, isFloor: false },
      { day: 2, value: 3, isFloor: true },
    ]);
  });

  it('never flags isFloor for the tokens or runs metrics', () => {
    const series: DayCost[] = [
      { day: 1, totalUsd: null, incomplete: false, tokens: 10, attempts: 1 },
      { day: 2, totalUsd: 2, incomplete: true, tokens: 20, attempts: 1 },
    ];
    expect(cumulative(series, 'tokens')).toEqual([
      { day: 1, value: 10, isFloor: false },
      { day: 2, value: 30, isFloor: false },
    ]);
    expect(cumulative(series, 'attempts')).toEqual([
      { day: 1, value: 1, isFloor: false },
      { day: 2, value: 2, isFloor: false },
    ]);
  });
});
