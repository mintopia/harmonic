import { describe, expect, it } from 'vitest';
import { orderedRunStates, subagentShare, usageBars } from '../web/src/stats-model.js';

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

describe('orderedRunStates', () => {
  it('orders known states by TASK_STATES canonical order, not object-key order', () => {
    const runsByState = { completed: 3, draft: 1, running: 2 };
    expect(orderedRunStates(runsByState)).toEqual([
      { state: 'draft', count: 1 },
      { state: 'running', count: 2 },
      { state: 'completed', count: 3 },
    ]);
  });

  it('drops zero-count states', () => {
    const runsByState = { draft: 0, ready: 5, running: 0, completed: 2 };
    expect(orderedRunStates(runsByState)).toEqual([
      { state: 'ready', count: 5 },
      { state: 'completed', count: 2 },
    ]);
  });

  it('appends unknown states after the known ones, in input order, dropping zeros', () => {
    const runsByState = { zeta: 4, draft: 1, alpha: 0, completed: 2 };
    expect(orderedRunStates(runsByState)).toEqual([
      { state: 'draft', count: 1 },
      { state: 'completed', count: 2 },
      { state: 'zeta', count: 4 },
    ]);
  });

  it('returns [] for empty input', () => {
    expect(orderedRunStates({})).toEqual([]);
  });

  it('returns [] when every state has a zero count', () => {
    expect(orderedRunStates({ draft: 0, running: 0 })).toEqual([]);
  });
});
