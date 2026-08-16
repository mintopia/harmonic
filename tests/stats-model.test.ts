import { describe, expect, it } from 'vitest';
import { orderedRunStates } from '../web/src/stats-model.js';

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
