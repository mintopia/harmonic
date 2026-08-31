import { describe, expect, it } from 'vitest';
import { attemptStepTabs, contentPanel, defaultStepTab, taskLifecycle, taskStats, type LifecycleStepKey, type LifecycleStepStatus, type StatsAttempt } from '../web/src/task-detail-model.js';
import type { AttemptSummary, Cost, ModelUsage, Step, StepState, StepType, TaskState } from '../web/src/types.js';

const STEP_ORDER: LifecycleStepKey[] = [
  'worktree',
  'implementation',
  'merge',
  'postMergeCheck',
  'closeIssue',
  'retire',
];

const stateAttempt = (state: AttemptSummary['state']): Pick<AttemptSummary, 'state'> => ({ state });

/** The step statuses keyed by step, so a state's expectation reads as a map. */
function statuses(state: TaskState, attempts: Pick<AttemptSummary, 'state'>[] = []): Record<LifecycleStepKey, LifecycleStepStatus> {
  const { steps } = taskLifecycle(state, attempts);
  return Object.fromEntries(steps.map((s) => [s.key, s.status])) as Record<LifecycleStepKey, LifecycleStepStatus>;
}

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

describe('taskLifecycle', () => {
  it('always returns the six lifecycle steps in order', () => {
    for (const state of ['draft', 'ready', 'working', 'escalated', 'done', 'cancelled'] as TaskState[]) {
      expect(taskLifecycle(state, []).steps.map((s) => s.key)).toEqual(STEP_ORDER);
    }
  });

  it('labels each step for the progress bar', () => {
    expect(taskLifecycle('working', []).steps.map((s) => s.label)).toEqual([
      'Worktree',
      'Implementation',
      'Merge',
      'Post-merge check',
      'Close issue',
      'Retire',
    ]);
  });

  it('has exactly one highlighted node matching `current`, in every state', () => {
    for (const state of ['draft', 'ready', 'working', 'escalated', 'done', 'cancelled'] as TaskState[]) {
      const { steps, current } = taskLifecycle(state, [stateAttempt('running')]);
      const highlighted = steps.filter((s) => s.status === 'current' || s.status === 'failed' || s.status === 'awaiting');
      // `done` settles every node, so it has no lone highlight — it is the one exception.
      if (state === 'done') {
        expect(steps.every((s) => s.status === 'done')).toBe(true);
      } else {
        expect(highlighted).toHaveLength(1);
        expect(highlighted[0]?.key).toBe(current);
      }
    }
  });

  it('points a draft Task at the imminent Worktree node', () => {
    expect(taskLifecycle('draft', []).current).toBe('worktree');
    expect(statuses('draft')).toEqual({
      worktree: 'current',
      implementation: 'pending',
      merge: 'pending',
      postMergeCheck: 'pending',
      closeIssue: 'pending',
      retire: 'pending',
    });
  });

  it('points a ready Task at the imminent Worktree node', () => {
    expect(statuses('ready')).toEqual({
      worktree: 'current',
      implementation: 'pending',
      merge: 'pending',
      postMergeCheck: 'pending',
      closeIssue: 'pending',
      retire: 'pending',
    });
  });

  it('sits a working Task on Implementation while an Attempt runs', () => {
    expect(taskLifecycle('working', [stateAttempt('running')]).current).toBe('implementation');
    expect(statuses('working', [stateAttempt('running')])).toEqual({
      worktree: 'done',
      implementation: 'current',
      merge: 'pending',
      postMergeCheck: 'pending',
      closeIssue: 'pending',
      retire: 'pending',
    });
  });

  it('treats a working Task with only failed Attempts as still on Implementation', () => {
    expect(statuses('working', [stateAttempt('failed'), stateAttempt('running')]).implementation).toBe('current');
  });

  it('advances a working Task to Merge once an Attempt has passed', () => {
    expect(taskLifecycle('working', [stateAttempt('failed'), stateAttempt('completed')]).current).toBe('merge');
    expect(statuses('working', [stateAttempt('completed')])).toEqual({
      worktree: 'done',
      implementation: 'done',
      merge: 'current',
      postMergeCheck: 'pending',
      closeIssue: 'pending',
      retire: 'pending',
    });
  });

  it('sits an escalated Task at the Merge gate, awaiting review', () => {
    // A passed Attempt at the review gate: Implementation is done and Merge is
    // the highlighted `awaiting` node (the indigo needs-you voice), not a failure.
    expect(taskLifecycle('escalated', [stateAttempt('completed')]).current).toBe('merge');
    expect(statuses('escalated', [stateAttempt('completed')])).toEqual({
      worktree: 'done',
      implementation: 'done',
      merge: 'awaiting',
      postMergeCheck: 'pending',
      closeIssue: 'pending',
      retire: 'pending',
    });
  });

  it('settles every node when the Task is done', () => {
    expect(taskLifecycle('done', [stateAttempt('completed')]).current).toBe('retire');
    expect(statuses('done', [stateAttempt('completed')])).toEqual({
      worktree: 'done',
      implementation: 'done',
      merge: 'done',
      postMergeCheck: 'done',
      closeIssue: 'done',
      retire: 'done',
    });
  });

  it('halts a cancelled Task at Implementation once it has run an Attempt', () => {
    expect(statuses('cancelled', [stateAttempt('cancelled')])).toEqual({
      worktree: 'done',
      implementation: 'failed',
      merge: 'pending',
      postMergeCheck: 'pending',
      closeIssue: 'pending',
      retire: 'pending',
    });
  });

  it('halts a cancelled Task at Worktree when it never ran an Attempt', () => {
    expect(taskLifecycle('cancelled', []).current).toBe('worktree');
    expect(statuses('cancelled', [])).toEqual({
      worktree: 'failed',
      implementation: 'pending',
      merge: 'pending',
      postMergeCheck: 'pending',
      closeIssue: 'pending',
      retire: 'pending',
    });
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
    // No total-token scalar anywhere in the shape (cost and billable I/O are the
    // honest headlines; the summary-card counts carry no token total).
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
    // Cost carries a role-qualified subagent slice and a critic slice that have
    // no token-usage bucket of their own; each must still show as its own slice,
    // and the total cost sums them all.
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
    // Two distinct subagent names (reviewer, tester) across the Attempts.
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
    // Tokens sum; cost is dropped for good — an honest floor, not a fabricated total.
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

let stepId = 0;
const step = (type: StepType, state: StepState): Step => ({
  id: ++stepId,
  attemptId: 1,
  type,
  position: stepId,
  state,
  command: null,
  verdict: null,
  logLocator: null,
  startedAt: null,
  endedAt: null,
});

describe('attemptStepTabs', () => {
  it('keeps one tab per Step type in canonical lifecycle order', () => {
    const tabs = attemptStepTabs([
      step('review', 'pending'),
      step('rebase', 'passed'),
      step('verification', 'running'),
      step('implementation', 'passed'),
    ]);
    expect(tabs.map((t) => t.type)).toEqual(['rebase', 'implementation', 'verification', 'review']);
    expect(tabs.map((t) => t.label)).toEqual(['Rebase', 'Implementation', 'Verify', 'Review']);
  });

  it('only lists tabs for the Step types the Attempt actually has', () => {
    expect(attemptStepTabs([step('implementation', 'running')]).map((t) => t.type)).toEqual(['implementation']);
    expect(attemptStepTabs([])).toEqual([]);
  });

  it('folds several verification command Steps into a single Verify tab', () => {
    const tabs = attemptStepTabs([
      step('verification', 'passed'),
      step('verification', 'running'),
      step('verification', 'pending'),
    ]);
    expect(tabs).toHaveLength(1);
    // A live command wins the roll-up even beside a passed and a pending sibling.
    expect(tabs[0]).toMatchObject({ type: 'verification', state: 'running', pending: false });
  });

  it('rolls a type up to failed when any of its Steps failed', () => {
    const tabs = attemptStepTabs([step('verification', 'passed'), step('verification', 'failed')]);
    expect(tabs[0]!.state).toBe('failed');
  });

  it('marks a tab pending only when every Step of the type is pending', () => {
    expect(attemptStepTabs([step('review', 'pending')])[0]!.pending).toBe(true);
    expect(attemptStepTabs([step('review', 'passed')])[0]!.pending).toBe(false);
    expect(attemptStepTabs([step('verification', 'pending'), step('verification', 'passed')])[0]!.pending).toBe(false);
  });

  it('carries the verification command as tab detail; the other tabs carry none', () => {
    const tabs = attemptStepTabs([
      step('rebase', 'passed'),
      step('implementation', 'passed'),
      { ...step('verification', 'passed'), command: 'pnpm test' },
      step('review', 'passed'),
    ]);
    expect(tabs.find((t) => t.type === 'verification')?.detail).toBe('pnpm test');
    expect(tabs.find((t) => t.type === 'review')?.detail).toBeNull();
    expect(tabs.find((t) => t.type === 'rebase')?.detail).toBeNull();
    expect(tabs.find((t) => t.type === 'implementation')?.detail).toBeNull();
  });
});

describe('defaultStepTab', () => {
  it('opens the live Step when one is running', () => {
    const tabs = attemptStepTabs([step('implementation', 'passed'), step('verification', 'running')]);
    expect(defaultStepTab(tabs)).toBe('verification');
  });

  it('opens Implementation once it has content and nothing is running', () => {
    const tabs = attemptStepTabs([step('rebase', 'passed'), step('implementation', 'passed'), step('review', 'pending')]);
    expect(defaultStepTab(tabs)).toBe('implementation');
  });

  it('falls back to the furthest-progressed tab when Implementation is still pending', () => {
    const tabs = attemptStepTabs([step('rebase', 'passed'), step('implementation', 'pending')]);
    expect(defaultStepTab(tabs)).toBe('rebase');
  });

  it('returns null for an Attempt with no Steps', () => {
    expect(defaultStepTab([])).toBeNull();
  });
});
