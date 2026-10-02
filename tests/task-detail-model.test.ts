import { describe, expect, it } from 'vitest';
import { attemptIdentityModel, attemptStepTabs, contentPanel, defaultSelection, defaultStepTab, taskLifecycle, taskStats, verificationOutputTail, type LifecycleStepKey, type LifecycleStepStatus, type StatsAttempt } from '../web/src/task-detail-model.js';
import type { Attempt, AttemptSummary, Cost, ModelUsage, Step, StepState, StepType, Task } from '../web/src/types.js';

const STEP_ORDER: LifecycleStepKey[] = [
  'worktree',
  'implementation',
  'merge',
  'postMergeCheck',
  'closeIssue',
  'retire',
];

type ProgressTask = Pick<Task, 'state' | 'isolationMode' | 'branch' | 'trackerRef' | 'mergeStatus'>;
const progressTask = (overrides: Partial<ProgressTask> = {}): ProgressTask => ({
  state: 'ready', isolationMode: 'worktree', branch: null, trackerRef: null, mergeStatus: null, ...overrides,
});
const stateAttempt = (number: number, state: AttemptSummary['state']): Pick<AttemptSummary, 'number' | 'state'> => ({ number, state });
function statuses(task: ProgressTask, attempts: Pick<AttemptSummary, 'number' | 'state'>[] = [], details: Pick<Attempt, 'number' | 'steps'>[] = [], configured = true): Record<LifecycleStepKey, LifecycleStepStatus> {
  return Object.fromEntries(taskLifecycle(task, attempts, details, configured).steps.map((s) => [s.key, s.status])) as Record<LifecycleStepKey, LifecycleStepStatus>;
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
  it('keeps a ready Task with zero Attempts entirely pending', () => {
    expect(statuses(progressTask())).toEqual({
      worktree: 'pending', implementation: 'pending', merge: 'pending',
      postMergeCheck: 'pending', closeIssue: 'skipped', retire: 'pending',
    });
    expect(taskLifecycle(progressTask(), [], [], true).steps.map((s) => s.key)).toEqual(STEP_ORDER);
  });

  it('shows worktree creation until the branch exists, then the running Attempt', () => {
    const run = [stateAttempt(1, 'running')];
    expect(statuses(progressTask({ state: 'working' }), run).worktree).toBe('current');
    expect(statuses(progressTask({ state: 'working' }), run).implementation).toBe('pending');
    const live = statuses(progressTask({ state: 'working', branch: 'agent/1' }), run);
    expect(live.worktree).toBe('done');
    expect(live.implementation).toBe('current');
    expect(live.merge).toBe('pending');
  });

  it('marks an escalated failed implementation as failed without suggesting merge review', () => {
    const failed = [stateAttempt(1, 'failed')];
    const details = [{ number: 1, steps: [step('implementation', 'failed')] }];
    const result = statuses(progressTask({ state: 'escalated', branch: 'agent/1' }), failed, details);
    expect(result.implementation).toBe('failed');
    expect(result.merge).toBe('pending');
    expect(result.worktree).toBe('done');
  });

  it('does not call a verification failure completed implementation', () => {
    const details = [{ number: 1, steps: [step('implementation', 'passed'), step('verification', 'failed')] }];
    expect(statuses(progressTask({ state: 'escalated', branch: 'agent/1' }), [stateAttempt(1, 'failed')], details).implementation).toBe('failed');
  });

  it('moves to merge only after a completed Attempt, including a live merge', () => {
    const task = progressTask({ state: 'working', branch: 'agent/1', mergeStatus: 'merging' });
    const result = statuses(task, [stateAttempt(1, 'completed')]);
    expect(result.implementation).toBe('done');
    expect(result.merge).toBe('current');
  });

  it('holds merge for review when a failed Attempt has passed every persisted Step', () => {
    const details = [{ number: 1, steps: [step('implementation', 'passed'), step('verification', 'passed')] }];
    const result = statuses(progressTask({ state: 'escalated', branch: 'agent/1' }), [stateAttempt(1, 'failed')], details);
    expect(result.implementation).toBe('done');
    expect(result.merge).toBe('awaiting');
  });

  it('does not count an older completed Attempt when a newer one fails verification', () => {
    const details = [{ number: 2, steps: [step('implementation', 'passed'), step('verification', 'failed')] }];
    const result = statuses(progressTask({ state: 'escalated', branch: 'agent/2' }), [stateAttempt(1, 'completed'), stateAttempt(2, 'failed')], details);
    expect(result.implementation).toBe('failed');
    expect(result.merge).toBe('pending');
  });

  it('does not treat a completed Attempt with a skipped Implementation Step as implemented', () => {
    const details = [{ number: 1, steps: [step('implementation', 'skipped')] }];
    expect(statuses(progressTask({ state: 'escalated', branch: 'agent/1' }), [stateAttempt(1, 'completed')], details).implementation).toBe('pending');
  });

  it('marks only applicable stages done on worktree completion', () => {
    const task = progressTask({ state: 'done', branch: 'agent/1', trackerRef: 17 });
    expect(statuses(task, [stateAttempt(1, 'completed')])).toEqual({
      worktree: 'done', implementation: 'done', merge: 'done',
      postMergeCheck: 'done', closeIssue: 'done', retire: 'done',
    });
    const unconfigured = taskLifecycle(task, [stateAttempt(1, 'completed')], [], false);
    expect(unconfigured.steps.find((s) => s.key === 'postMergeCheck')).toMatchObject({ status: 'skipped', disabled: true });
  });

  it('skips merge, issue closure and worktree operations in direct mode', () => {
    const direct = progressTask({ state: 'done', isolationMode: 'direct' });
    expect(statuses(direct, [stateAttempt(1, 'completed')])).toEqual({
      worktree: 'skipped', implementation: 'done', merge: 'skipped',
      postMergeCheck: 'skipped', closeIssue: 'skipped', retire: 'skipped',
    });
  });

  it('keeps a failed direct-mode Attempt at the build and verification gate', () => {
    const direct = progressTask({ state: 'escalated', isolationMode: 'direct' });
    const details = [{ number: 1, steps: [step('implementation', 'failed')] }];
    const result = statuses(direct, [stateAttempt(1, 'failed')], details);
    expect(result.implementation).toBe('failed');
    expect(result.worktree).toBe('skipped');
    expect(result.merge).toBe('skipped');
  });

  it('leaves implementation unclaimed when a Task is closed without an Attempt', () => {
    const result = statuses(progressTask({ state: 'done' }));
    expect(result.worktree).toBe('pending');
    expect(result.implementation).toBe('skipped');
    expect(result.merge).toBe('pending');
  });

  it('marks a cancelled Attempt failed at implementation', () => {
    const result = statuses(progressTask({ state: 'cancelled', branch: 'agent/1' }), [stateAttempt(1, 'cancelled')]);
    expect(result.implementation).toBe('failed');
    expect(result.merge).toBe('pending');
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
  it('keeps structural tabs first, then one tab for each verification Step', () => {
    const tabs = attemptStepTabs([
      step('review', 'pending'),
      step('rebase', 'passed'),
      step('verification', 'running'),
      step('implementation', 'passed'),
    ]);
    expect(tabs.map((t) => t.type)).toEqual(['rebase', 'implementation', 'verification', 'review']);
    expect(tabs.map((t) => t.label)).toEqual(['Rebase', 'Implementation', 'Verify', 'Critic']);
  });

  it('always shows the structural Rebase and Implementation tabs, even before a Step of them exists', () => {
    expect(attemptStepTabs([]).map((t) => t.type)).toEqual(['rebase', 'implementation']);
    expect(attemptStepTabs([step('implementation', 'running')]).map((t) => t.type)).toEqual(['rebase', 'implementation']);
  });

  it('shows a planned Verify/Review tab before its Step exists, and hides a disabled one', () => {
    const planned = attemptStepTabs(
      [step('implementation', 'running')],
      [
        { mechanism: 'command', state: 'planned', reason: null },
        { mechanism: 'critic', state: 'planned', reason: null },
      ],
    );
    expect(planned.map((t) => t.type)).toEqual(['rebase', 'implementation', 'verification', 'review']);
    expect(planned.find((t) => t.type === 'review')).toMatchObject({ state: 'pending', pending: true });

    const disabled = attemptStepTabs(
      [step('implementation', 'running')],
      [
        { mechanism: 'command', state: 'disabled', reason: null },
        { mechanism: 'critic', state: 'disabled', reason: null },
      ],
    );
    expect(disabled.map((t) => t.type)).toEqual(['rebase', 'implementation']);
  });

  it('keeps several verification command Steps separate', () => {
    const tabs = attemptStepTabs([
      step('verification', 'passed'),
      step('verification', 'running'),
      step('verification', 'pending'),
    ]);
    expect(tabs.filter((t) => t.type === 'verification')).toHaveLength(3);
    expect(tabs.filter((t) => t.type === 'verification').map((tab) => tab.state)).toEqual(['passed', 'running', 'pending']);
  });

  it('keeps a failed verification Step failed without changing a passing sibling', () => {
    const tabs = attemptStepTabs([step('verification', 'passed'), step('verification', 'failed')]);
    expect(tabs.filter((t) => t.type === 'verification').map((tab) => tab.state)).toEqual(['passed', 'failed']);
  });

  it('marks each individual verifier tab pending only while that Step is pending', () => {
    expect(attemptStepTabs([step('review', 'pending')]).find((t) => t.type === 'review')!.pending).toBe(true);
    expect(attemptStepTabs([step('review', 'passed')]).find((t) => t.type === 'review')!.pending).toBe(false);
    expect(attemptStepTabs([step('verification', 'pending'), step('verification', 'passed')]).filter((t) => t.type === 'verification').map((tab) => tab.pending)).toEqual([true, false]);
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
    expect(defaultStepTab(tabs)).toBe(tabs.find((tab) => tab.type === 'verification')!.id);
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

  it('opens a failed Step ahead of Implementation — what an escalated Attempt needs reviewed', () => {
    const tabs = attemptStepTabs([step('implementation', 'passed'), step('verification', 'failed')]);
    expect(defaultStepTab(tabs)).toBe(tabs.find((tab) => tab.type === 'verification')!.id);
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

describe('verificationOutputTail', () => {
  const out = (id: number, mechanism: string, text: string) => ({
    id,
    seq: id,
    ts: id,
    type: 'session_update' as const,
    payload: { sessionUpdate: 'verification_output', mechanism, content: { type: 'text', text } },
  });

  it('joins one mechanism’s streamed chunks and keeps only the tail', () => {
    const events = [out(1, 'command', 'a'), out(2, 'critic', 'X'), out(3, 'command', 'bcdef')];
    expect(verificationOutputTail(events, 'command')).toBe('abcdef');
    expect(verificationOutputTail(events, 'command', 3)).toBe('def');
    expect(verificationOutputTail(events, 'critic')).toBe('X');
  });

  it('is null before anything streamed', () => {
    expect(verificationOutputTail([], 'command')).toBeNull();
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
