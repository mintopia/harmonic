import { describe, expect, it } from 'vitest';
import { pullRequestLink, attemptIdentityModel, contentPanel, defaultSelection, taskStats, type StatsAttempt } from '../web/src/task-detail-model.js';
import type { AttemptSummary, Cost, ModelUsage } from '../web/src/types.js';

const tok = (input: number, output: number, cacheReadTokens = 0, cacheWriteTokens = 0): ModelUsage => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadTokens,
  cacheWriteTokens,
});

const attempt = (
  models: Record<string, ModelUsage>,
  byModel: Record<string, number | null>,
  agents?: Record<string, ModelUsage>,
  attribution?: Pick<NonNullable<AttemptSummary['usage']>, 'toolTokens' | 'reasoning'>,
): StatsAttempt => ({
  usage: {
    totals: null,
    models,
    ...(agents ? { agents } : {}),
    ...(attribution ?? {}),
    toolCalls: {},
    source: 'session-log',
  } satisfies AttemptSummary['usage'],
  cost: { totalUsd: 0, byModel, incomplete: false } satisfies Cost,
});

describe('contentPanel', () => {
  it('shows Stats when nothing is selected', () => {
    expect(contentPanel({ kind: 'none' })).toEqual({ kind: 'stats', title: 'Stats' });
  });

  it('titles an Attempt by its display number', () => {
    expect(contentPanel({ kind: 'attempt', attemptNumber: 1 })).toEqual({ kind: 'attempt', title: 'Attempt 1' });
    expect(contentPanel({ kind: 'attempt', attemptNumber: 3 })).toEqual({ kind: 'attempt', title: 'Attempt 3' });
  });

  it('titles a changed file by its filename, not its full path', () => {
    expect(contentPanel({ kind: 'file', path: 'web/src/components/TicketPage.tsx' })).toEqual({
      kind: 'diff',
      title: 'TicketPage.tsx',
    });
  });

  it('keeps a root-level file whole as its own title', () => {
    expect(contentPanel({ kind: 'file', path: 'README.md' })).toEqual({ kind: 'diff', title: 'README.md' });
  });

  it('opens the Timeline as its own panel', () => {
    expect(contentPanel({ kind: 'timeline' })).toEqual({ kind: 'timeline', title: 'Timeline' });
  });
});

describe('taskStats', () => {
  it('combines one model used across roles and Attempts into a single row', () => {
    const stats = taskStats([
      attempt(
        { 'opus-4.8': tok(100, 20, 5, 2), 'sonnet-4.5': tok(50, 10) },
        { 'opus-4.8': 0.3, 'sonnet-4.5': 0.05 },
        { root: tok(80, 16, 5, 2), 'code-reviewer': tok(20, 4) },
      ),
      attempt({ 'opus-4.8': tok(40, 8) }, { 'opus-4.8': 0.12 }),
    ]);

    expect(stats.byModel).toEqual([
      { model: 'opus-4.8', input: 140, output: 28, cachedIn: 5, cachedOut: 2, cost: 0.42 },
      { model: 'sonnet-4.5', input: 50, output: 10, cachedIn: 0, cachedOut: 0, cost: 0.05 },
    ]);
    expect(stats.byModel.filter((m) => m.model === 'opus-4.8')).toHaveLength(1);
    expect(stats.costByModel).toEqual([
      { model: 'opus-4.8', cost: 0.42 },
      { model: 'sonnet-4.5', cost: 0.05 },
    ]);
    expect(stats.agentVsSubagent).toEqual({ agentTokens: 103, subagentTokens: 24 });
    expect(stats.billableIO).toBe(228);
  });

  it('reports billable I/O as input+output only when cache dominates, and leaks no total scalar', () => {
    const stats = taskStats([attempt({ 'opus-4.8': tok(10, 5, 100_000, 5_000) }, { 'opus-4.8': 2 })]);

    expect(stats.billableIO).toBe(15);
    expect(stats.byModel).toEqual([
      { model: 'opus-4.8', input: 10, output: 5, cachedIn: 100_000, cachedOut: 5_000, cost: 2 },
    ]);
    expect(Object.keys(stats).sort()).toEqual([
      'agentVsSubagent',
      'agents',
      'billableIO',
      'byModel',
      'cost',
      'costByModel',
      'subagents',
      'toolCalls',
      'toolTokens',
    ]);
    expect(stats).not.toHaveProperty('totalTokens');
    expect(stats.byModel[0]).not.toHaveProperty('totalTokens');
    expect(stats.byModel[0]).not.toHaveProperty('total');
  });

  it('keeps an unpriced model as a null-cost row, out of the cost donut', () => {
    const stats = taskStats([attempt({ 'mystery-model': tok(30, 6) }, { 'mystery-model': null })]);

    expect(stats.byModel).toEqual([
      { model: 'mystery-model', input: 30, output: 6, cachedIn: 0, cachedOut: 0, cost: null },
    ]);
    expect(stats.costByModel).toEqual([]);
    expect(stats.billableIO).toBe(36);
  });

  it('is null-sticky on cost: a model seen unpriced once contributes no dollars', () => {
    const stats = taskStats([
      attempt({ 'opus-4.8': tok(10, 2) }, { 'opus-4.8': 0.1 }),
      attempt({ 'opus-4.8': tok(10, 2) }, { 'opus-4.8': null }),
    ]);
    expect(stats.byModel[0]!.cost).toBeNull();
    expect(stats.costByModel).toEqual([]);
  });

  it('sorts models by total token magnitude, largest first', () => {
    const stats = taskStats([
      attempt({ small: tok(1, 1), big: tok(500, 500), mid: tok(50, 50) }, { small: 0.01, big: 5, mid: 0.5 }),
    ]);
    expect(stats.byModel.map((m) => m.model)).toEqual(['big', 'mid', 'small']);
  });

  it('splits agent vs subagent tokens, zero when no per-agent data is present', () => {
    const withAgents = taskStats([
      attempt({ 'opus-4.8': tok(100, 20) }, { 'opus-4.8': 0.3 }, { root: tok(60, 10), helper: tok(40, 10) }),
    ]);
    expect(withAgents.agentVsSubagent).toEqual({ agentTokens: 70, subagentTokens: 50 });

    const withoutAgents = taskStats([attempt({ 'opus-4.8': tok(100, 20) }, { 'opus-4.8': 0.3 })]);
    expect(withoutAgents.agentVsSubagent).toEqual({ agentTokens: 0, subagentTokens: 0 });
  });

  it('handles an empty set and Attempts with no settled usage', () => {
    const empty = {
      byModel: [],
      agentVsSubagent: { agentTokens: 0, subagentTokens: 0 },
      costByModel: [],
      billableIO: 0,
      cost: 0,
      subagents: 0,
      agents: 0,
      toolCalls: 0,
      toolTokens: [],
    };
    expect(taskStats([])).toEqual(empty);
    expect(taskStats([{ usage: null, cost: null }])).toEqual(empty);
  });

  it('keys the cost donut by the server cost.byModel keys, so a role-qualified or critic slice stands alone', () => {
    const stats = taskStats([
      attempt(
        { 'opus-4.8': tok(100, 20) },
        { 'opus-4.8': 14.72, 'sonnet-4.5 · sub': 2.14, critic: 0.96 },
      ),
    ]);
    expect(stats.costByModel).toEqual([
      { model: 'opus-4.8', cost: 14.72 },
      { model: 'sonnet-4.5 · sub', cost: 2.14 },
      { model: 'critic', cost: 0.96 },
    ]);
    expect(stats.cost).toBeCloseTo(17.82);
  });

  it('counts primary/subagent sessions and sums tool calls for the summary card', () => {
    const stats = taskStats([
      { ...attempt({ 'opus-4.8': tok(10, 2) }, { 'opus-4.8': 0.1 }, { root: tok(8, 1), reviewer: tok(2, 1) }), toolCalls: 40 },
      { ...attempt({ 'opus-4.8': tok(10, 2) }, { 'opus-4.8': 0.1 }, { root: tok(8, 1), tester: tok(2, 1) }), toolCalls: 23 },
    ]);
    expect(stats.agents).toBe(1);
    expect(stats.subagents).toBe(2);
    expect(stats.toolCalls).toBe(63);
  });

  it('ranks tool output tokens largest first, with the reasoning bucket last', () => {
    const stats = taskStats([
      attempt({ 'opus-4.8': tok(100, 20) }, { 'opus-4.8': 0.3 }, undefined, {
        toolTokens: { Edit: { outputTokens: 50, cost: 0.2 }, Read: { outputTokens: 200, cost: 0.8 } },
        reasoning: { outputTokens: 90, cost: 0.4 },
      }),
    ]);
    expect(stats.toolTokens).toEqual([
      { key: 'Read', label: 'Read', outputTokens: 200, cost: 0.8 },
      { key: 'Edit', label: 'Edit', outputTokens: 50, cost: 0.2 },
      { key: 'reasoning', label: 'Reasoning', outputTokens: 90, cost: 0.4 },
    ]);
  });

  it('sums a tool across Attempts and floors it to tokens-only once seen unpriced', () => {
    const stats = taskStats([
      attempt({ 'opus-4.8': tok(10, 2) }, { 'opus-4.8': 0.1 }, undefined, {
        toolTokens: { Bash: { outputTokens: 30, cost: 0.15 } },
      }),
      attempt({ 'opus-4.8': tok(10, 2) }, { 'opus-4.8': 0.1 }, undefined, {
        toolTokens: { Bash: { outputTokens: 20 } },
      }),
    ]);
    expect(stats.toolTokens).toEqual([{ key: 'Bash', label: 'Bash', outputTokens: 50 }]);
    expect(stats.toolTokens[0]).not.toHaveProperty('cost');
  });

  it('drops the reasoning bucket when it carries no output tokens', () => {
    const stats = taskStats([
      attempt({ 'opus-4.8': tok(10, 2) }, { 'opus-4.8': 0.1 }, undefined, {
        toolTokens: { Read: { outputTokens: 12, cost: 0.05 } },
        reasoning: { outputTokens: 0 },
      }),
    ]);
    expect(stats.toolTokens).toEqual([{ key: 'Read', label: 'Read', outputTokens: 12, cost: 0.05 }]);
  });

  it('has no tool tokens when the harness reported no attribution', () => {
    const stats = taskStats([attempt({ 'opus-4.8': tok(10, 2) }, { 'opus-4.8': 0.1 })]);
    expect(stats.toolTokens).toEqual([]);
  });
});

describe('defaultSelection', () => {
  const attempts = [
    { number: 1, state: 'failed' as const },
    { number: 2, state: 'running' as const },
  ];

  it('opens a working Task on its live Attempt', () => {
    expect(defaultSelection('working', attempts)).toEqual({ kind: 'attempt', attemptNumber: 2 });
    expect(defaultSelection('working', [{ number: 1, state: 'completed' }])).toEqual({ kind: 'attempt', attemptNumber: 1 });
  });

  it('opens an escalated Task on its latest Attempt', () => {
    expect(defaultSelection('escalated', [{ number: 1, state: 'failed' }, { number: 2, state: 'failed' }])).toEqual({ kind: 'attempt', attemptNumber: 2 });
  });

  it('opens a waiting, finished or cancelled Task on Stats', () => {
    for (const state of ['draft', 'ready', 'done', 'cancelled'] as const) {
      expect(defaultSelection(state, attempts)).toEqual({ kind: 'stats' });
    }
    expect(defaultSelection('working', [])).toEqual({ kind: 'stats' });
  });
});

describe('attemptIdentityModel', () => {
  it('stays pinned to the primary model even when a subagent out-spends it', () => {
    expect(attemptIdentityModel('sonnet-5', [{ model: 'sonnet-4.5' }, { model: 'sonnet-5' }])).toBe('sonnet-5');
  });

  it('falls back to the token-dominant model when the task is pinned to auto', () => {
    expect(attemptIdentityModel('auto', [{ model: 'sonnet-4.5' }, { model: 'sonnet-5' }])).toBe('sonnet-4.5');
  });

  it('falls back to the token-dominant model when no primary model is set', () => {
    expect(attemptIdentityModel('', [{ model: 'sonnet-4.5' }])).toBe('sonnet-4.5');
  });
});

describe('pullRequestLink', () => {
  it('is the newest Attempt that opened a PR/MR, or null when none did', () => {
    expect(pullRequestLink([])).toBeNull();
    expect(pullRequestLink([{ number: 1, pullRequestUrl: null }])).toBeNull();
    expect(
      pullRequestLink([
        { number: 1, pullRequestUrl: 'https://github.com/o/r/pull/1' },
        { number: 2, pullRequestUrl: 'https://github.com/o/r/pull/2' },
        { number: 3, pullRequestUrl: null },
      ]),
    ).toBe('https://github.com/o/r/pull/2');
  });
});
