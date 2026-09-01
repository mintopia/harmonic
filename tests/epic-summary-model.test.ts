import { describe, expect, it } from 'vitest';
import { epicUsageSummary, tokenBarEmpty, tokenBarSegments, rowCost, type EpicUsageStats } from '../web/src/epic-summary-model.js';
import type { Cost, ModelUsage } from '../web/src/types.js';

const ZERO_STATS: EpicUsageStats = {
  attemptCount: 0,
  failedAttempts: 0,
  durationMs: null,
  totals: null,
  models: {},
  toolCalls: {},
  cost: null,
};

const usage = (input: number, output: number, cacheRead: number, cacheWrite: number): ModelUsage => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadTokens: cacheRead,
  cacheWriteTokens: cacheWrite,
});

const totals = (input: number, output: number, cacheRead: number, cacheWrite: number): EpicUsageStats['totals'] => ({
  ...usage(input, output, cacheRead, cacheWrite),
  totalTokens: input + output + cacheRead + cacheWrite,
});

const cost = (totalUsd: number | null, incomplete = false): Cost => ({
  totalUsd,
  byModel: {},
  incomplete,
});

describe('epicUsageSummary', () => {
  it('renders the honest empty state for all-zero Stats', () => {
    const summary = epicUsageSummary(ZERO_STATS, 3);
    expect(summary).toEqual({
      hasActivity: false,
      totalCost: '—',
      costIncomplete: false,
      attemptCount: 0,
      avgCostPerTask: '—',
      failureRatePct: '—',
      durationP50: '—',
      durationP95: '—',
      tokensIn: 0,
      tokensOut: 0,
      cacheHitPct: '—',
      subagentSharePct: '—',
      toolCalls: 0,
      modelBars: [],
    });
  });

  it('shapes a populated Stats fixture into formatted headline figures', () => {
    const stats: EpicUsageStats = {
      attemptCount: 10,
      failedAttempts: 2,
      durationMs: { p50: 65_000, p95: 3_725_000 },
      totals: totals(1000, 200, 300, 100),
      models: { 'opus-4.8': usage(700, 150, 250, 80), 'sonnet-4.5': usage(300, 50, 50, 20) },
      agents: { root: usage(1200, 250, 0, 0), 'subagent:reviewer': usage(400, 0, 0, 0) },
      toolCalls: { Edit: 12, Bash: 8, Read: 30 },
      cost: cost(20),
    };
    const summary = epicUsageSummary(stats, 4);
    expect(summary.hasActivity).toBe(true);
    expect(summary.totalCost).toBe('$20.00');
    expect(summary.attemptCount).toBe(10);
    expect(summary.avgCostPerTask).toBe('$5.00');
    expect(summary.failureRatePct).toBe('20%');
    expect(summary.durationP50).toBe('1m 5s');
    expect(summary.durationP95).toBe('1h 2m');
    expect(summary.tokensIn).toBe(1000);
    expect(summary.tokensOut).toBe(200);
    // cacheHitRate = cacheRead / (input + cacheRead + cacheWrite) = 300 / 1400
    expect(summary.cacheHitPct).toBe(`${Math.round((300 / 1400) * 100)}%`);
    // subagentShare = (total - root) / total = 400 / 1850
    expect(summary.subagentSharePct).toBe(`${Math.round((400 / 1850) * 100)}%`);
    expect(summary.toolCalls).toBe(50);
    expect(summary.modelBars).toEqual([
      { key: 'opus-4.8', tokens: 1180 },
      { key: 'sonnet-4.5', tokens: 420 },
    ]);
  });

  it('floors an incomplete cost with the ≥ prefix, mirroring formatAvgCostPerRun', () => {
    const stats: EpicUsageStats = { ...ZERO_STATS, attemptCount: 1, cost: cost(9, true) };
    const summary = epicUsageSummary(stats, 2);
    expect(summary.totalCost).toBe('≥ $9.00');
    expect(summary.avgCostPerTask).toBe('≥ $4.50');
  });

  it('avgCostPerTask is "—" when childCount is 0', () => {
    const stats: EpicUsageStats = { ...ZERO_STATS, cost: cost(10) };
    expect(epicUsageSummary(stats, 0).avgCostPerTask).toBe('—');
  });
});

describe('tokenBarSegments', () => {
  it('splits a populated totals row into four segments with shares summing to 100', () => {
    const segments = tokenBarSegments(usage(60, 20, 15, 5));
    expect(segments).toEqual([
      { key: 'input', label: 'input', fill: 'bg-token-input', value: 60, pct: 60 },
      { key: 'output', label: 'output', fill: 'bg-token-output', value: 20, pct: 20 },
      { key: 'cacheRead', label: 'cache read', fill: 'bg-token-cache-read', value: 15, pct: 15 },
      { key: 'cacheWrite', label: 'cache write', fill: 'bg-token-cache-write', value: 5, pct: 5 },
    ]);
    expect(tokenBarEmpty(segments)).toBe(false);
  });

  it('degrades a null totals row (no usage fetched, or the fetch failed) to an all-zero, empty bar', () => {
    const segments = tokenBarSegments(null);
    expect(segments.every((s) => s.value === 0 && s.pct === 0)).toBe(true);
    expect(tokenBarEmpty(segments)).toBe(true);
  });

  it('degrades an undefined totals row the same way', () => {
    expect(tokenBarEmpty(tokenBarSegments(undefined))).toBe(true);
  });
});

describe('rowCost', () => {
  it('formats a priced Cost', () => {
    expect(rowCost(cost(1.5))).toBe('$1.50');
  });

  it('renders "—" for null', () => {
    expect(rowCost(null)).toBe('—');
  });
});
