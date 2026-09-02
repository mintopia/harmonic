import { describe, expect, it } from 'vitest';
import { buildDaySeries, type DaySeriesRun } from '../src/server/stats-series.js';
import type { AttemptUsage } from '../src/execution/usage.js';
import type { Cost } from '../src/domain/pricing.js';

const midnight = (y: number, m: number, d: number) => {
  const t = new Date(y, m, d);
  t.setHours(0, 0, 0, 0);
  return t.getTime();
};
const at = (y: number, m: number, d: number, h = 12) => new Date(y, m, d, h).getTime();

const usageJson = (input: number, output: number, cacheRead = 0, cacheWrite = 0): string =>
  JSON.stringify({
    models: {
      m1: { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite },
    },
    totals: null,
    toolCalls: {},
    source: 'session-log',
  } satisfies AttemptUsage);

const run = (startedAt: number, usage: string | null): DaySeriesRun => ({ startedAt, usage });
const outcome = (startedAt: number, state: string): DaySeriesRun => ({
  startedAt,
  usage: null,
  state,
});

const perRunDollar = (dayRows: DaySeriesRun[]): Cost => ({
  totalUsd: dayRows.length,
  byModel: {},
  incomplete: false,
});

describe('buildDaySeries', () => {
  it('buckets runs by local-midnight day, ordered ascending, with per-day run counts', () => {
    const series = buildDaySeries(
      [
        run(at(2026, 0, 12, 9), usageJson(10, 1)),
        run(at(2026, 0, 10, 23), usageJson(10, 1)),
        run(at(2026, 0, 12, 14), usageJson(10, 1)),
      ],
      perRunDollar,
    );
    expect(series.map((s) => s.day)).toEqual([midnight(2026, 0, 10), midnight(2026, 0, 12)]);
    expect(series.map((s) => s.attempts)).toEqual([1, 2]);
  });

  it('sums input + output tokens per day and excludes cache read/write', () => {
    const series = buildDaySeries(
      [
        run(at(2026, 0, 10, 8), usageJson(100, 10, 500, 20)),
        run(at(2026, 0, 10, 18), usageJson(40, 4, 999, 999)),
      ],
      perRunDollar,
    );
    expect(series).toHaveLength(1);
    expect(series[0]?.tokens).toBe(154);
    expect(series[0]?.attempts).toBe(2);
  });

  it('reports 0 tokens for a day whose runs reported no usage', () => {
    const series = buildDaySeries([run(at(2026, 0, 10, 8), null), run(at(2026, 0, 10, 9), null)], perRunDollar);
    expect(series).toHaveLength(1);
    expect(series[0]?.tokens).toBe(0);
    expect(series[0]?.attempts).toBe(2);
  });

  it('carries cost and the incomplete floor straight from the injected pricer', () => {
    const series = buildDaySeries(
      [run(at(2026, 0, 10, 8), usageJson(10, 1)), run(at(2026, 0, 11, 8), usageJson(10, 1))],
      (dayRows) => ({ totalUsd: dayRows.length * 2, byModel: {}, incomplete: true }),
    );
    expect(series.map((s) => s.totalUsd)).toEqual([2, 2]);
    expect(series.every((s) => s.incomplete)).toBe(true);
  });

  it('reports totalUsd null (and incomplete false) when a day cannot be priced at all', () => {
    const series = buildDaySeries([run(at(2026, 0, 10, 8), usageJson(10, 1))], () => null);
    expect(series[0]?.totalUsd).toBeNull();
    expect(series[0]?.incomplete).toBe(false);
    expect(series[0]?.tokens).toBe(11);
  });

  it('returns an empty series for no runs', () => {
    expect(buildDaySeries([], perRunDollar)).toEqual([]);
  });

  it('counts failed-only runs per day, excluding cancelled/completed (ADR-0028)', () => {
    const series = buildDaySeries(
      [
        outcome(at(2026, 0, 10, 8), 'failed'),
        outcome(at(2026, 0, 10, 10), 'cancelled'),
        outcome(at(2026, 0, 10, 11), 'completed'),
        outcome(at(2026, 0, 11, 8), 'failed'),
        outcome(at(2026, 0, 11, 9), 'failed'),
      ],
      perRunDollar,
    );
    expect(series.map((s) => s.day)).toEqual([midnight(2026, 0, 10), midnight(2026, 0, 11)]);
    expect(series.map((s) => s.fails)).toEqual([1, 2]);
    expect(series.map((s) => s.attempts)).toEqual([3, 2]);
  });

  it('reports 0 fails for a day whose rows omit state (usage-only callers)', () => {
    const series = buildDaySeries([run(at(2026, 0, 10, 8), usageJson(10, 1))], perRunDollar);
    expect(series[0]?.fails).toBe(0);
  });
});
