import { describe, expect, it } from 'vitest';
import {
  cacheHitRate,
  criticVerdictSlices,
  criticVerdictTotal,
  failureRate,
  gateOutcomeBars,
  guardrailTripBars,
  orderedFailureReasons,
  orderedAttemptStates,
  reliabilityStates,
  settledTaskTotal,
  subagentShare,
  usageBars,
  verificationCardEmpty,
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
  it('is cache-read over all input-side tokens, cache-write included', () => {
    expect(cacheHitRate(u(10, 5, 30, 10))).toBeCloseTo(0.6, 10);
  });

  it('is null when there is no usage', () => {
    expect(cacheHitRate(null)).toBeNull();
    expect(cacheHitRate(undefined)).toBeNull();
  });

  it('is null (not 0) when there are no input-side tokens', () => {
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

describe('orderedAttemptStates', () => {
  it('orders known states by the canonical Run-state order, not object-key order', () => {
    const attemptsByState = { failed: 1, completed: 3, running: 2 };
    expect(orderedAttemptStates(attemptsByState)).toEqual([
      { state: 'running', count: 2 },
      { state: 'completed', count: 3 },
      { state: 'failed', count: 1 },
    ]);
  });

  it('drops zero-count states', () => {
    const attemptsByState = { running: 0, completed: 5, failed: 0, cancelled: 2 };
    expect(orderedAttemptStates(attemptsByState)).toEqual([
      { state: 'completed', count: 5 },
      { state: 'cancelled', count: 2 },
    ]);
  });

  it('appends unknown states after the known ones, in input order, dropping zeros', () => {
    const attemptsByState = { zeta: 4, running: 1, alpha: 0, completed: 2 };
    expect(orderedAttemptStates(attemptsByState)).toEqual([
      { state: 'running', count: 1 },
      { state: 'completed', count: 2 },
      { state: 'zeta', count: 4 },
    ]);
  });

  it('returns [] for empty input', () => {
    expect(orderedAttemptStates({})).toEqual([]);
  });

  it('returns [] when every state has a zero count', () => {
    expect(orderedAttemptStates({ failed: 0, running: 0 })).toEqual([]);
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

  it('never invents a rejected slice — a reject is a resumed Attempt, not a run outcome', () => {
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

describe('criticVerdictSlices', () => {
  it('keeps a fixed pass / block / inconclusive order, zeros included, for a stable legend', () => {
    expect(criticVerdictSlices({ pass: 24, block: 5, inconclusive: 0 })).toEqual([
      { key: 'pass', count: 24 },
      { key: 'block', count: 5 },
      { key: 'inconclusive', count: 0 },
    ]);
  });

  it('sums to the critic verdict total, command never folded in', () => {
    expect(criticVerdictTotal({ pass: 24, block: 5, inconclusive: 2 })).toBe(31);
  });
});

describe('gateOutcomeBars', () => {
  const gate = { autoMerged: 26, escalated: 4, revertedOnRed: 1 };

  it('keeps a fixed auto-merged / escalated / reverted-on-red order', () => {
    expect(gateOutcomeBars(gate)).toEqual([
      { key: 'autoMerged', count: 26 },
      { key: 'escalated', count: 4 },
      { key: 'revertedOnRed', count: 1 },
    ]);
  });

  it('sums the outcomes to the settled-Task total the bars reconcile against', () => {
    expect(settledTaskTotal(gate)).toBe(31);
    expect(gateOutcomeBars(gate).reduce((sum, b) => sum + b.count, 0)).toBe(settledTaskTotal(gate));
  });
});

describe('guardrailTripBars', () => {
  it('ranks by trip count largest-first, ties by dimension key, dropping zeros', () => {
    expect(guardrailTripBars({ 'wall-clock': 3, tokens: 3, cost: 1, progress: 0 })).toEqual([
      { key: 'tokens', count: 3 },
      { key: 'wall-clock', count: 3 },
      { key: 'cost', count: 1 },
    ]);
  });

  it('returns [] when no dimension tripped', () => {
    expect(guardrailTripBars({})).toEqual([]);
  });
});

describe('verificationCardEmpty', () => {
  const noVerdicts = { pass: 0, block: 0, inconclusive: 0 };
  const noGate = { autoMerged: 0, escalated: 0, revertedOnRed: 0 };

  it('is empty only when there is no verdict, gate, or guardrail activity', () => {
    expect(verificationCardEmpty(noVerdicts, noGate, {})).toBe(true);
  });

  it('is not empty when any panel has data', () => {
    expect(verificationCardEmpty({ pass: 1, block: 0, inconclusive: 0 }, noGate, {})).toBe(false);
    expect(verificationCardEmpty(noVerdicts, { autoMerged: 1, escalated: 0, revertedOnRed: 0 }, {})).toBe(false);
    expect(verificationCardEmpty(noVerdicts, noGate, { tokens: 1 })).toBe(false);
  });
});
