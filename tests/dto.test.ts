import { describe, expect, it } from 'vitest';
import { trackerRef } from '../src/tracker/adapter.js';
import { epicListRowSchema, taskListRowSchema } from '../src/server/routes/tasks.js';
import {
  summarize,
  firstLineTitle,
  stepRunState,
  stepRunToApi,
  latestVerifiedRef,
  costOfAttempts,
  operationsToApi,
  attemptToApiSummary,
  taskToApiDto,
  epicToListRow,
  conversationToApiDto,
  attemptProcessToApi,
  conversationProcessToApi,
} from '../src/server/dto.js';
import type { ConversationRow, TaskAttemptRow, TaskRow, WorkflowStepRunRow } from '../src/db/schema.js';
import type { TaskWithDeps, TaskOverrides } from '../src/domain/tasks.js';
import type { Ticket } from '../src/tracker/adapter.js';
import type { Cost } from '../src/domain/pricing.js';
import type { AttemptUsage, AttemptUsageSnapshot, ProcessNode } from '../src/execution/usage.js';
import type { OperationSnapshot } from '../src/telemetry/operations.js';

const attemptRow = (over: Partial<TaskAttemptRow> = {}): TaskAttemptRow => ({
  id: 1,
  taskId: 1,
  workspaceId: null,
  epicRef: null,
  number: 1,
  state: 'running',
  startedAt: 1_000,
  endedAt: null,
  agentDurationMs: 0,
  feedback: null,
  continuation: null,
  reason: null,
  stopReason: null,
  sessionId: null,
  sessionRowId: null,
  prompt: null,
  branch: null,
  baseBranch: null,
  diffBaseOid: null,
  diffHeadOid: null,
  stat: null,
  verifiedHeadOid: null,
  pullRequestUrl: null,
  startOid: null,
  usage: null,
  cost: null,
  routingUsage: null,
  routingCost: null,
  routeKind: null,
  routeOption: null,
  routeReason: null,
  routeOptionPosition: null,
  routeOptionCount: null,
  liveUsage: null,
  guardrailConfig: null,
  priceTable: null,
  harness: null,
  model: null,
  detail: null,
  ...over,
});

const overrides: TaskOverrides = {
  harness: null, model: null, isolationMode: null, priority: null, conflictResolveTurns: null,
};

const taskRow = (over: Partial<TaskRow> = {}): TaskRow => ({
  id: 1,
  prompt: 'Do the thing',
  harness: 'claude',
  model: 'claude-sonnet-5',
  workingDir: '/repo',
  isolationMode: 'worktree',
  priority: 'normal',
  conflictResolveTurns: 3,
  state: 'ready',
  workspaceId: 1,
  feedback: null,
  continuationChoice: null,
  origin: 'native',
  trackerRef: null,
  issueWorkflow: null,
  wayfinderType: null,
  escalationReason: null,
  escalationCause: null,
  ticketClosePending: false, workflowRef: null, workflowRequested: null, workflowChosen: null, workflowLabel: null, execution: null, workflowReason: null, workflowRoutingUsage: null, workflowRoutingCost: null, workflowVarOverrides: null, workflowVars: null,
  mapRef: null,
  baseBranch: null,
  trackerState: null,
  trackerParent: null,
  trackerBlockedBy: null,
  trackerLabels: null,
  modelOptionOverrides: null,
  trackerTitle: null,
  archiveId: null,
  trackerBody: null,
  trackerUrl: null,
  trackerCreatedAt: null,
  createdAt: 1_000,
  updatedAt: 1_000,
  ...over,
});

const taskWithDeps = (over: Partial<TaskWithDeps> = {}): TaskWithDeps => ({
  ...taskRow(),
  dependsOn: [],
  dependents: [],
  blockedOnFailed: false,
  openBlockerCount: 0,
  epicBlockers: [],
  agentWorkable: false,
  humanOnly: false,
  isEpic: false,
  overrides,
  routing: null,
  classifierEnabled: false,
  ...over,
});

const conversationRow = (over: Partial<ConversationRow> = {}): ConversationRow => ({
  id: 1,
  title: null,
  harness: 'claude',
  model: 'claude-sonnet-5',
  workingDir: '/repo',
  workspaceId: 1,
  state: 'active',
  permissionMode: 'ask',
  sessionId: null,
  usage: null,
  contextTokens: null,
  createdAt: 1_000,
  updatedAt: 1_000,
  endedAt: null,
  ...over,
});

const ticket = (over: Partial<Ticket> = {}): Ticket => ({
  ref: trackerRef(100),
  title: 'A ticket',
  state: 'open',
  labels: [],
  parent: null,
  blockedBy: [],
  body: '',
  createdAt: '2026-08-07T00:00:00Z',
  closedAt: null,
  assignees: [],
  blocking: [],
  isMap: false,
  url: 'https://tracker.example/issues/100',
  ...over,
});

const cost = (over: Partial<Cost> = {}): Cost => ({ totalUsd: 1, byModel: {}, incomplete: false, ...over });

const usage = (over: Partial<AttemptUsage> = {}): AttemptUsage => ({
  models: {},
  totals: null,
  toolCalls: {},
  source: null,
  ...over,
});

const modelUsage = () => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });

const processTree = (over: Partial<ProcessNode> = {}): ProcessNode => ({
  id: 'sess-1',
  name: 'root',
  model: 'claude-sonnet-5',
  usage: modelUsage(),
  contextTokens: null,
  lastTool: null,
  status: 'active',
  depth: 0,
  toolUseId: null,
  children: [],
  ...over,
});

const operation = (over: Partial<OperationSnapshot> = {}): OperationSnapshot => ({
  type: 'tool',
  name: 'op',
  spanContext: { traceId: 'trace-1', spanId: 'span-1', traceFlags: 0 },
  parentSpanContext: undefined,
  attributes: {},
  startedAt: 1_000,
  status: { code: 0 },
  ...over,
});

describe('summarize', () => {
  it.each([
    { name: 'takes the first non-empty line, trimmed', input: '  first line  \nsecond line', expected: 'first line' },
    { name: 'skips leading blank lines', input: '\n\n   \nreal content\nmore', expected: 'real content' },
  ])('$name', ({ input, expected }) => {
    expect(summarize(input)).toBe(expected);
  });

  it('truncates a line over 200 chars with an ellipsis', () => {
    const long = 'x'.repeat(250);
    const result = summarize(long);
    expect(result.length).toBe(200);
    expect(result.endsWith('…')).toBe(true);
  });
});

describe('firstLineTitle', () => {
  it.each<{ name: string; input: string | null; expected: string | null }>([
    { name: 'returns null for null input', input: null, expected: null },
    { name: 'returns null for blank input', input: '   \n  \n', expected: null },
    { name: 'takes the first non-empty line, trimmed', input: '\n  Title here  \nbody', expected: 'Title here' },
  ])('$name', ({ input, expected }) => {
    expect(firstLineTitle(input)).toBe(expected);
  });

  it('truncates to 80 chars with an ellipsis', () => {
    const long = 'y'.repeat(120);
    const result = firstLineTitle(long)!;
    expect(result.length).toBe(80);
    expect(result.endsWith('…')).toBe(true);
  });
});

describe('stepRunToApi', () => {
  const row = (over: Partial<WorkflowStepRunRow> = {}): WorkflowStepRunRow => ({
    id: 5, taskId: 1, workspaceId: null, epicRef: null, workflowRef: 'implement@1', stepId: 'verify', position: 2, action: 'run',
    outcome: null, outputs: null, summary: null, resolvedPrompt: null, attempt: 2, startedAt: 100, endedAt: null,
    attemptId: 9, sessionRowId: null, harness: null, model: null, usage: null, ...over,
  });

  it('derives state: running, interrupted, or the outcome', () => {
    expect(stepRunState(row())).toBe('running');
    expect(stepRunState(row({ endedAt: 200 }))).toBe('interrupted');
    expect(stepRunState(row({ endedAt: 200, outcome: 'fail' }))).toBe('fail');
  });

  it('maps kind, pass, prompt flag, outputs and outline info', () => {
    const api = stepRunToApi(row({ action: 'critic', resolvedPrompt: 'p', sessionRowId: 3, harness: 'claude', model: 'm', outputs: JSON.stringify({ stdout: '', exitCode: null, verdict: 'pass' }) }), {
      info: { detail: 'opus', condition: 'x' },
      cost: cost({ totalUsd: 0.1 }),
    });
    expect(api).toMatchObject({ kind: 'critic', pass: 2, hasPrompt: true, sessionRowId: 3, detail: 'opus', condition: 'x', state: 'running', outputs: { verdict: 'pass' } });
    expect(api.cost).toEqual(cost({ totalUsd: 0.1 }));
  });

  it('defaults outputs and detail when none were recorded', () => {
    expect(stepRunToApi(row(), { cost: null })).toMatchObject({ outputs: { stdout: '', exitCode: null }, detail: null, condition: null, hasPrompt: false });
  });
});

describe('latestVerifiedRef', () => {
  it.each<{ name: string; run: TaskAttemptRow | undefined; expected: string | null }>([
    { name: 'returns null when run is undefined', run: undefined, expected: null },
    {
      name: 'falls back to branch when verifiedHeadOid and branch are both set',
      run: attemptRow({ verifiedHeadOid: 'abc123', branch: 'harmonic/task-1' }),
      expected: 'harmonic/task-1',
    },
    { name: 'returns null when verifiedHeadOid is null', run: attemptRow({ verifiedHeadOid: null, branch: 'harmonic/task-1' }), expected: null },
    { name: 'returns null when branch is null', run: attemptRow({ verifiedHeadOid: 'abc123', branch: null }), expected: null },
  ])('$name', ({ run, expected }) => {
    expect(latestVerifiedRef(run)).toBe(expected);
  });
});

describe('costOfAttempts', () => {
  it('sums frozen cost JSON across runs', () => {
    const runs = [
      attemptRow({ cost: JSON.stringify(cost({ totalUsd: 1.5, byModel: { 'claude-sonnet-5': 1.5 } })) }),
      attemptRow({ cost: JSON.stringify(cost({ totalUsd: 2.5, byModel: { 'claude-sonnet-5': 2.5 } })) }),
    ];
    expect(costOfAttempts(runs)).toEqual({ totalUsd: 4, byModel: { 'claude-sonnet-5': 4 }, incomplete: false });
  });

  it('ignores runs with a null cost', () => {
    const runs = [
      attemptRow({ cost: JSON.stringify(cost({ totalUsd: 1, byModel: { 'claude-sonnet-5': 1 } })) }),
      attemptRow({ cost: null }),
    ];
    expect(costOfAttempts(runs)).toEqual({ totalUsd: 1, byModel: { 'claude-sonnet-5': 1 }, incomplete: false });
  });

  it('returns null when every run has a null cost', () => {
    expect(costOfAttempts([attemptRow({ cost: null })])).toBeNull();
  });
});

describe('operationsToApi', () => {
  it('nests a child under its parent by spanId/parentSpanId', () => {
    const root = operation({ name: 'root', spanContext: { traceId: 't', spanId: 'root-span', traceFlags: 0 } });
    const child = operation({
      name: 'child',
      spanContext: { traceId: 't', spanId: 'child-span', traceFlags: 0 },
      parentSpanContext: { traceId: 't', spanId: 'root-span', traceFlags: 0 },
    });
    expect(operationsToApi([root, child])).toMatchObject([{ spanId: 'root-span', children: [{ spanId: 'child-span' }] }]);
  });

  it('treats an orphan (unknown parent) as a root', () => {
    const orphan = operation({
      name: 'orphan',
      spanContext: { traceId: 't', spanId: 'orphan-span', traceFlags: 0 },
      parentSpanContext: { traceId: 't', spanId: 'missing-span', traceFlags: 0 },
    });
    expect(operationsToApi([orphan])).toMatchObject([{ spanId: 'orphan-span', children: [] }]);
  });
});

describe('attemptToApiSummary', () => {
  it('exposes the PR/MR URL the Attempt opened, null when none', () => {
    expect(attemptToApiSummary(attemptRow({ pullRequestUrl: 'https://github.com/o/r/pull/9' }), 0).pullRequestUrl).toBe('https://github.com/o/r/pull/9');
    expect(attemptToApiSummary(attemptRow(), 0).pullRequestUrl).toBeNull();
  });

  it.each<{ name: string; state: TaskAttemptRow['state']; expected: string }>([
    { name: 'collapses passed -> completed', state: 'passed', expected: 'completed' },
    { name: 'collapses escalated -> failed', state: 'escalated', expected: 'failed' },
    { name: 'passes running through unchanged', state: 'running', expected: 'running' },
    { name: 'passes cancelled through unchanged', state: 'cancelled', expected: 'cancelled' },
  ])('$name', ({ state, expected }) => {
    expect(attemptToApiSummary(attemptRow({ state }), 0).state).toBe(expected);
  });

  it('reason falls back from detail to the disposition kind', () => {
    expect(attemptToApiSummary(attemptRow({ detail: 'a git error', reason: 'process-death' }), 0).reason).toBe('a git error');
    expect(attemptToApiSummary(attemptRow({ detail: null, reason: 'process-death' }), 0).reason).toBe('process-death');
  });

  it('finishedAt mirrors endedAt, toolCalls and usage/cost parse from JSON', () => {
    const run = attemptRow({
      endedAt: 2_000,
      usage: JSON.stringify(usage({ toolCalls: { bash: 3 } })),
      cost: JSON.stringify(cost({ totalUsd: 0.5 })),
    });
    expect(attemptToApiSummary(run, 7)).toMatchObject({
      finishedAt: 2_000,
      toolCalls: 7,
      usage: usage({ toolCalls: { bash: 3 } }),
      cost: cost({ totalUsd: 0.5 }),
    });
  });
});

describe('taskToApiDto', () => {
  const resolved = {
    toolCount: 4,
    currentStep: { stepId: 'build', action: 'agent', kind: 'agent' as const },
    hasCandidate: true,
    url: 'https://tracker.example/issues/1',
    mapTitle: 'Some Map',
    trackerLabel: 'GitHub',
    skipReason: 'capacity',
    targetWait: null,
    contextWindow: 200_000,
  };

  it('derives summary, keeps the full prompt (item-GET shape), narrows workspaceId and passes every resolved field through untouched', () => {
    const task = taskWithDeps({ prompt: '  Fix the widget  \nmore detail', workspaceId: 3 });
    const dto = taskToApiDto(task, [], resolved);
    expect(dto).toMatchObject({
      summary: 'Fix the widget',
      prompt: '  Fix the widget  \nmore detail',
      workspaceId: 3,
      url: resolved.url,
      mapTitle: resolved.mapTitle,
      trackerLabel: resolved.trackerLabel,
      skipReason: resolved.skipReason,
      contextWindow: resolved.contextWindow,
      toolCount: resolved.toolCount,
      hasCandidate: resolved.hasCandidate,
    });
    expect(dto.currentStep).toBe(resolved.currentStep);
  });

  it.each<{ name: string; currentStep: Parameters<typeof taskToApiDto>[2]['currentStep']; expected: string | null }>([
    { name: 'merging from a running merge step', currentStep: { stepId: 'merge', action: 'merge', kind: 'publish' }, expected: 'merging' },
    { name: 'null for a non-merge step', currentStep: resolved.currentStep, expected: null },
    { name: 'null with no current step', currentStep: null, expected: null },
  ])('derives mergeStatus: $name', ({ currentStep, expected }) => {
    expect(taskToApiDto(taskWithDeps(), [], { ...resolved, currentStep }).mergeStatus).toBe(expected);
  });

  it('adds critic cost to the Task cost', () => {
    const runs = [attemptRow({ id: 10, number: 1, state: 'passed', cost: JSON.stringify(cost({ totalUsd: 1 })) })];
    expect(taskToApiDto(taskWithDeps(), runs, { ...resolved, criticCost: cost({ totalUsd: 0.25 }) }).cost?.totalUsd).toBe(1.25);
  });

  it.each<{ name: string; runs: TaskAttemptRow[]; expected: { attemptId: number | null; runStartedAt: number | null } }>([
    {
      name: 'takes attemptId/runStartedAt from the running run',
      runs: [
        attemptRow({ id: 10, number: 1, state: 'passed', startedAt: 1_000 }),
        attemptRow({ id: 11, number: 2, state: 'running', startedAt: 5_000 }),
      ],
      expected: { attemptId: 11, runStartedAt: 5_000 },
    },
    {
      name: 'has no attemptId/runStartedAt when no run is running',
      runs: [attemptRow({ id: 10, number: 1, state: 'passed' })],
      expected: { attemptId: null, runStartedAt: null },
    },
  ])('$name', ({ runs, expected }) => {
    expect(taskToApiDto(taskWithDeps(), runs, resolved)).toMatchObject(expected);
  });

  it('strips the durable tracker-fact columns', () => {
    const task = taskWithDeps({
      trackerState: 'open',
      trackerParent: trackerRef(5),
      trackerBlockedBy: [],
      trackerLabels: ['x'],
      trackerTitle: 'raw title',
      trackerBody: 'raw body',
      trackerUrl: 'https://tracker.example/1',
      trackerCreatedAt: '2026-01-01T00:00:00Z',
    });
    const dto = taskToApiDto(task, [], resolved);
    for (const key of ['trackerState', 'trackerParent', 'trackerBlockedBy', 'trackerLabels', 'trackerTitle', 'trackerBody', 'trackerUrl', 'trackerCreatedAt']) {
      expect(Object.prototype.hasOwnProperty.call(dto, key)).toBe(false);
    }
  });

  describe('wallClockDeadline', () => {
    const guardrailConfig = JSON.stringify({
      budget: { wallClockMinutes: 60 },
      progress: false,
      toolTimeoutMinutes: 10,
    });

    it.each<{ name: string; taskState: TaskWithDeps['state']; runs: TaskAttemptRow[]; expected: number | null }>([
      {
        name: 'is the running Attempt startedAt plus its wall-clock budget, while the task is working',
        taskState: 'working',
        runs: [attemptRow({ id: 11, number: 1, state: 'running', startedAt: 5_000, guardrailConfig })],
        expected: 5_000 + 60 * 60_000,
      },
      {
        name: 'is null when the task is not working, even with a running-shaped Attempt row',
        taskState: 'ready',
        runs: [attemptRow({ id: 11, number: 1, state: 'running', startedAt: 5_000, guardrailConfig })],
        expected: null,
      },
      {
        name: 'is null when working with no running Attempt',
        taskState: 'working',
        runs: [attemptRow({ id: 10, number: 1, state: 'passed', guardrailConfig })],
        expected: null,
      },
      {
        name: 'is null when the running Attempt carries no guardrail budget',
        taskState: 'working',
        runs: [attemptRow({ id: 11, number: 1, state: 'running', startedAt: 5_000, guardrailConfig: null })],
        expected: null,
      },
    ])('$name', ({ taskState, runs, expected }) => {
      expect(taskToApiDto(taskWithDeps({ state: taskState }), runs, resolved).wallClockDeadline).toBe(expected);
    });

    it('moves forward by N minutes after an extend rewrites the persisted guardrailConfig', () => {
      const runs = [attemptRow({ id: 11, number: 1, state: 'running', startedAt: 5_000, guardrailConfig })];
      const before = taskToApiDto(taskWithDeps({ state: 'working' }), runs, resolved).wallClockDeadline!;
      const extendedConfig = JSON.stringify({ budget: { wallClockMinutes: 90 }, progress: false, toolTimeoutMinutes: 10 });
      const extendedRuns = [attemptRow({ id: 11, number: 1, state: 'running', startedAt: 5_000, guardrailConfig: extendedConfig })];
      const after = taskToApiDto(taskWithDeps({ state: 'working' }), extendedRuns, resolved).wallClockDeadline!;
      expect(after - before).toBe(30 * 60_000);
    });
  });
});

describe('epicToListRow', () => {
  it('projects a Ticket onto a list row with isEpic/humanOnly set and identity fields threaded; no id, no prompt key', () => {
    const row = epicToListRow(ticket({ ref: trackerRef(42), title: 'The Epic', url: 'https://tracker.example/42' }), 9);
    expect(row).toMatchObject({
      isEpic: true,
      humanOnly: true,
      trackerRef: '42',
      summary: 'The Epic',
      url: 'https://tracker.example/42',
      workspaceId: 9,
    });
    expect(row).not.toHaveProperty('id');
    expect(Object.prototype.hasOwnProperty.call(row, 'prompt')).toBe(false);
  });

  it('gives no two Epic rows the same id', () => {
    const rows = [epicToListRow(ticket({ ref: trackerRef(1) }), 1), epicToListRow(ticket({ ref: trackerRef(2) }), 1)];
    const ids = rows.map((r) => (r as { id?: number }).id).filter((id) => id !== undefined);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([]);
  });

  it('validates against epicListRowSchema, which rejects a row carrying id', () => {
    const row = epicToListRow(ticket(), 1);
    expect(epicListRowSchema.safeParse(row).success).toBe(true);
    expect(epicListRowSchema.safeParse({ ...row, id: 0 }).success).toBe(false);
    expect(taskListRowSchema.safeParse(row).success).toBe(false);
  });
});

describe('conversationToApiDto', () => {
  const resolved = {
    title: 'Resolved title',
    cost: cost({ totalUsd: 2 }),
    contextWindow: 200_000,
    cacheWarmSeconds: 3600,
    commandPrefix: '$',
  };

  it('parses usage from JSON, takes title/cost/contextWindow/cacheWarmSeconds/commandPrefix from resolved and narrows workspaceId', () => {
    const conversation = conversationRow({
      title: 'Operator title',
      workspaceId: 6,
      usage: JSON.stringify(usage({ toolCalls: { grep: 1 } })),
    });
    expect(conversationToApiDto(conversation, resolved)).toMatchObject({
      usage: usage({ toolCalls: { grep: 1 } }),
      title: 'Resolved title',
      cost: resolved.cost,
      contextWindow: 200_000,
      cacheWarmSeconds: 3600,
      commandPrefix: '$',
      workspaceId: 6,
    });
  });
});

describe('attemptProcessToApi', () => {
  const task = { prompt: '', workspaceId: 2, harness: 'claude', model: 'claude-sonnet-5', isolationMode: 'worktree', trackerRef: null, state: 'working' as const };

  it('is type "attempt" with attemptId/taskId set, falling back the title to "Task N" when the prompt has no title', () => {
    const result = attemptProcessToApi({
      run: attemptRow({ id: 5, taskId: 8 }),
      task,
      snapshot: null,
      workspaceName: 'Default',
      trackerUrl: null,
      contextWindow: null,
      cost: null,
    });
    expect(result).toMatchObject({ type: 'attempt', attemptId: 5, taskId: 8, conversationId: null, title: 'Task 8' });
  });

  it('threads the live snapshot\'s usage/contextTokens/activity/tree', () => {
    const snapshot: AttemptUsageSnapshot = {
      usage: usage({ toolCalls: { bash: 2 } }),
      contextTokens: 1_234,
      activity: 'Running tests',
      tree: processTree(),
    };
    const result = attemptProcessToApi({
      run: attemptRow(),
      task: { ...task, prompt: 'Fix the bug' },
      snapshot,
      workspaceName: 'Default',
      trackerUrl: null,
      contextWindow: 200_000,
      cost: cost({ totalUsd: 3 }),
    });
    expect(result.title).toBe('Fix the bug');
    expect(result.usage).toEqual(snapshot.usage);
    expect(result.contextTokens).toBe(1_234);
    expect(result.activity).toBe('Running tests');
    expect(result.tree).toEqual(snapshot.tree);
    expect(result.contextWindow).toBe(200_000);
    expect(result.cost).toEqual(cost({ totalUsd: 3 }));
  });
});

describe('conversationProcessToApi', () => {
  it('is type "chat" with conversationId set, attempt-only fields null and the given title threaded straight through', () => {
    const result = conversationProcessToApi({
      conversation: conversationRow({ id: 9 }),
      title: 'Conversation #9',
      workspaceName: 'Default',
      contextWindow: null,
      cost: null,
    });
    expect(result).toMatchObject({
      type: 'chat',
      conversationId: 9,
      attemptId: null,
      taskId: null,
      trackerRef: null,
      trackerUrl: null,
      escalated: false,
      activity: null,
      tree: null,
      title: 'Conversation #9',
    });
  });
});
