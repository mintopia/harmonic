import { describe, expect, it } from 'vitest';
import {
  cacheHitRate,
  failureRate,
  orderedFailureReasons,
  orderedRunStates,
  reliabilityStates,
  subagentShare,
  usageBars,
} from '../web/src/stats-model.js';
import { formatAvgCostPerRun } from '../web/src/cost.js';
import type { Cost } from '../web/src/types.js';

const u = (input: number, output = 0, cacheRead = 0, cacheWrite = 0) => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadTokens: cacheRead,
  cacheWriteTokens: cacheWrite,
});

describe('usageBars', () => {
  it('sums all four token classes, drops zero rows, and sorts largest-first', () => {
    const bars = usageBars({
      'opus-4-8': u(100, 10, 5, 2),
      'sonnet-5': u(40, 4),
      'haiku-4-5': u(0, 0, 0, 0),
    });
    expect(bars).toEqual([
      { key: 'opus-4-8', tokens: 117 },
      { key: 'sonnet-5', tokens: 44 },
    ]);
  });

  it('breaks ties by key so the order is stable', () => {
    expect(usageBars({ b: u(10), a: u(10) })).toEqual([
      { key: 'a', tokens: 10 },
      { key: 'b', tokens: 10 },
    ]);
  });
});

describe('subagentShare', () => {
  it('is the fraction of tokens spent below the root session', () => {
    expect(subagentShare({ root: u(60), 'code-reviewer': u(30), Explore: u(10) })).toBeCloseTo(0.4, 10);
  });

  it('is 0 when everything ran in the root', () => {
    expect(subagentShare({ root: u(100) })).toBe(0);
  });

  it('is null when there is no per-agent data or no tokens', () => {
    expect(subagentShare(undefined)).toBeNull();
    expect(subagentShare({})).toBeNull();
    expect(subagentShare({ root: u(0) })).toBeNull();
  });
});

describe('cacheHitRate', () => {
  it('is cache-read over all input-side tokens, cache-write included (ADR-0028)', () => {
    // read=30 over input+read+write = 10+30+10 = 50 → 0.6
    expect(cacheHitRate(u(10, 5, 30, 10))).toBeCloseTo(0.6, 10);
  });

  it('is null when there is no usage', () => {
    expect(cacheHitRate(null)).toBeNull();
    expect(cacheHitRate(undefined)).toBeNull();
  });

  it('is null (not 0) when there are no input-side tokens', () => {
    // output-only usage has an empty denominator — "—", never a fake 0%.
    expect(cacheHitRate(u(0, 100, 0, 0))).toBeNull();
  });
});

describe('failureRate', () => {
  it('is failed-only over total Runs', () => {
    expect(failureRate(3, 12)).toBeCloseTo(0.25, 10);
  });

  it('is null (not 0) when there are no Runs', () => {
    expect(failureRate(0, 0)).toBeNull();
  });

  it('is 0 when there are Runs but none failed', () => {
    expect(failureRate(0, 5)).toBe(0);
  });
});

describe('formatAvgCostPerRun', () => {
  const cost = (totalUsd: number | null, incomplete = false): Cost => ({ totalUsd, byModel: {}, incomplete });

  it('divides total Cost by Run count', () => {
    expect(formatAvgCostPerRun(cost(10), 4)).toBe('$2.50');
  });

  it('marks an incomplete aggregate as a floor', () => {
    expect(formatAvgCostPerRun(cost(10, true), 4)).toBe('≥ $2.50');
  });

  it('is null when there is nothing honest to divide', () => {
    expect(formatAvgCostPerRun(null, 4)).toBeNull();
    expect(formatAvgCostPerRun(cost(null), 4)).toBeNull();
    expect(formatAvgCostPerRun(cost(10), 0)).toBeNull();
  });
});

describe('orderedRunStates', () => {
  it('orders known states by the canonical Run-state order, not object-key order', () => {
    const runsByState = { failed: 1, completed: 3, running: 2 };
    expect(orderedRunStates(runsByState)).toEqual([
      { state: 'running', count: 2 },
      { state: 'completed', count: 3 },
      { state: 'failed', count: 1 },
    ]);
  });

  it('drops zero-count states', () => {
    const runsByState = { running: 0, completed: 5, failed: 0, cancelled: 2 };
    expect(orderedRunStates(runsByState)).toEqual([
      { state: 'completed', count: 5 },
      { state: 'cancelled', count: 2 },
    ]);
  });

  it('appends unknown states after the known ones, in input order, dropping zeros', () => {
    const runsByState = { zeta: 4, running: 1, alpha: 0, completed: 2 };
    expect(orderedRunStates(runsByState)).toEqual([
      { state: 'running', count: 1 },
      { state: 'completed', count: 2 },
      { state: 'zeta', count: 4 },
    ]);
  });

  it('returns [] for empty input', () => {
    expect(orderedRunStates({})).toEqual([]);
  });

  it('returns [] when every state has a zero count', () => {
    expect(orderedRunStates({ failed: 0, running: 0 })).toEqual([]);
  });
});

describe('reliabilityStates', () => {
  it('uses the failed-only count for the failed slice, in canonical order, cancelled its own slice', () => {
    const segments = reliabilityStates({ completed: 5, failed: 5, cancelled: 1 }, 3);
    expect(segments).toEqual([
      { state: 'completed', count: 5 },
      { state: 'failed', count: 3 },
      { state: 'cancelled', count: 1 },
    ]);
  });

  it('drops the failed slice when the failed-only count is zero', () => {
    const segments = reliabilityStates({ completed: 2, failed: 1 }, 0);
    expect(segments).toEqual([{ state: 'completed', count: 2 }]);
  });

  it('never invents a rejected slice — a reject is a resumed Attempt, not a run outcome (ADR-0041)', () => {
    const segments = reliabilityStates({ completed: 2, failed: 1 }, 1);
    expect(segments.map((s) => s.state)).toEqual(['completed', 'failed']);
  });
});

describe('orderedFailureReasons', () => {
  it('orders buckets largest-first, ties by reason key, dropping zeros', () => {
    expect(orderedFailureReasons({ failed: 4, escalate: 1, 'guardrail-trip': 1, unknown: 0 })).toEqual([
      { reason: 'failed', count: 4 },
      { reason: 'escalate', count: 1 },
      { reason: 'guardrail-trip', count: 1 },
    ]);
  });

  it('returns [] for an empty breakdown', () => {
    expect(orderedFailureReasons({})).toEqual([]);
  });
});
