import { describe, expect, it } from 'vitest';
import { contentPanel, taskStats, type StatsAttempt } from '../web/src/task-detail-model.js';
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
): StatsAttempt => ({
  usage: {
    totals: null,
    models,
    ...(agents ? { agents } : {}),
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
    // Attempt 1: opus serves the root agent AND a code-reviewer subagent, plus a
    // sonnet helper. Attempt 2: opus again, this time as the critic model. The
    // same model across agent/subagent/critic roles must fold into one opus row.
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
    // Roles combined: exactly one opus row despite root + subagent + critic usage.
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

    // Cache is 105,000 tokens; the honest headline counts only the 15 billable.
    expect(stats.billableIO).toBe(15);
    expect(stats.byModel).toEqual([
      { model: 'opus-4.8', input: 10, output: 5, cachedIn: 100_000, cachedOut: 5_000, cost: 2 },
    ]);
    // No total-token scalar anywhere in the shape.
    expect(Object.keys(stats).sort()).toEqual(['agentVsSubagent', 'billableIO', 'byModel', 'costByModel']);
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
    expect(taskStats([])).toEqual({
      byModel: [],
      agentVsSubagent: { agentTokens: 0, subagentTokens: 0 },
      costByModel: [],
      billableIO: 0,
    });
    expect(taskStats([{ usage: null, cost: null }])).toEqual({
      byModel: [],
      agentVsSubagent: { agentTokens: 0, subagentTokens: 0 },
      costByModel: [],
      billableIO: 0,
    });
  });
});
