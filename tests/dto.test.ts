import { describe, expect, it } from 'vitest';
import {
  summarize,
  firstLineTitle,
  verifiedShaOf,
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
import type { AttemptRow, ConversationRow, TaskRow, VerificationAttemptRow } from '../src/db/schema.js';
import type { TaskWithDeps, TaskOverrides } from '../src/domain/tasks.js';
import type { Ticket } from '../src/tracker/adapter.js';
import type { Cost } from '../src/domain/pricing.js';
import type { AttemptUsage, AttemptUsageSnapshot, ProcessNode } from '../src/execution/usage.js';
import type { OperationSnapshot } from '../src/telemetry/operations.js';

const attemptRow = (over: Partial<AttemptRow> = {}): AttemptRow => ({
  id: 1,
  taskId: 1,
  number: 1,
  state: 'running',
  startedAt: 1_000,
  endedAt: null,
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
  verifiedRef: null,
  usage: null,
  cost: null,
  liveUsage: null,
  guardrailConfig: null,
  priceTable: null,
  detail: null,
  pid: null,
  pgid: null,
  procStartToken: null,
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
  workflow: null,
  wayfinderType: null,
  escalationReason: null,
  mergeStatus: null,
  mapRef: null,
  baseBranch: null,
  trackerState: null,
  trackerParent: null,
  trackerBlockedBy: null,
  trackerLabels: null,
  trackerTitle: null,
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
  agentWorkable: false,
  humanOnly: false,
  isEpic: false,
  overrides,
  ...over,
});

const verificationAttemptRow = (over: Partial<VerificationAttemptRow> = {}): VerificationAttemptRow => ({
  id: 1,
  attemptId: 1,
  seq: 1,
  ts: 1_000,
  mechanism: 'critic',
  inputOid: 'oid-1',
  verdict: 'pass',
  summary: '',
  output: '',
  transcriptPath: null,
  harness: null,
  prompt: null,
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
  sessionId: null,
  usage: null,
  contextTokens: null,
  createdAt: 1_000,
  updatedAt: 1_000,
  endedAt: null,
  ...over,
});

const ticket = (over: Partial<Ticket> = {}): Ticket => ({
  number: 100,
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
  comments: [],
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
  it('takes the first non-empty line, trimmed', () => {
    expect(summarize('  first line  \nsecond line')).toBe('first line');
  });

  it('skips leading blank lines', () => {
    expect(summarize('\n\n   \nreal content\nmore')).toBe('real content');
  });

  it('truncates a line over 200 chars with an ellipsis', () => {
    const long = 'x'.repeat(250);
    const result = summarize(long);
    expect(result.length).toBe(200);
    expect(result.endsWith('…')).toBe(true);
  });
});

describe('firstLineTitle', () => {
  it('returns null for null input', () => {
    expect(firstLineTitle(null)).toBeNull();
  });

  it('returns null for blank input', () => {
    expect(firstLineTitle('   \n  \n')).toBeNull();
  });

  it('takes the first non-empty line, trimmed', () => {
    expect(firstLineTitle('\n  Title here  \nbody')).toBe('Title here');
  });

  it('truncates to 80 chars with an ellipsis', () => {
    const long = 'y'.repeat(120);
    const result = firstLineTitle(long)!;
    expect(result.length).toBe(80);
    expect(result.endsWith('…')).toBe(true);
  });
});

describe('verifiedShaOf', () => {
  it('returns null when nothing passed', () => {
    const attempts = [verificationAttemptRow({ seq: 1, verdict: 'fail' })];
    expect(verifiedShaOf(attempts)).toBeNull();
  });

  it('returns the last passing attempt\'s inputOid', () => {
    const attempts = [
      verificationAttemptRow({ seq: 1, verdict: 'pass', inputOid: 'oid-a' }),
      verificationAttemptRow({ seq: 2, verdict: 'fail', inputOid: 'oid-b' }),
      verificationAttemptRow({ seq: 3, verdict: 'pass', inputOid: 'oid-c' }),
    ];
    expect(verifiedShaOf(attempts)).toBe('oid-c');
  });

  it('returns null for an empty list', () => {
    expect(verifiedShaOf([])).toBeNull();
  });
});

describe('latestVerifiedRef', () => {
  it('returns null when run is undefined', () => {
    expect(latestVerifiedRef(undefined)).toBeNull();
  });

  it('returns verifiedRef when set', () => {
    const run = attemptRow({ verifiedRef: 'refs/harmonic/direct/attempt-1', verifiedHeadOid: null, branch: null });
    expect(latestVerifiedRef(run)).toBe('refs/harmonic/direct/attempt-1');
  });

  it('falls back to branch when verifiedHeadOid and branch are both set', () => {
    const run = attemptRow({ verifiedRef: null, verifiedHeadOid: 'abc123', branch: 'harmonic/task-1' });
    expect(latestVerifiedRef(run)).toBe('harmonic/task-1');
  });

  it('returns null when neither verifiedRef nor a verified branch is available', () => {
    expect(latestVerifiedRef(attemptRow({ verifiedRef: null, verifiedHeadOid: null, branch: 'harmonic/task-1' }))).toBeNull();
    expect(latestVerifiedRef(attemptRow({ verifiedRef: null, verifiedHeadOid: 'abc123', branch: null }))).toBeNull();
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
    const forest = operationsToApi([root, child]);
    expect(forest).toHaveLength(1);
    expect(forest[0]!.spanId).toBe('root-span');
    expect(forest[0]!.children).toHaveLength(1);
    expect(forest[0]!.children[0]!.spanId).toBe('child-span');
  });

  it('treats an orphan (unknown parent) as a root', () => {
    const orphan = operation({
      name: 'orphan',
      spanContext: { traceId: 't', spanId: 'orphan-span', traceFlags: 0 },
      parentSpanContext: { traceId: 't', spanId: 'missing-span', traceFlags: 0 },
    });
    const forest = operationsToApi([orphan]);
    expect(forest).toHaveLength(1);
    expect(forest[0]!.spanId).toBe('orphan-span');
    expect(forest[0]!.children).toHaveLength(0);
  });
});

describe('attemptToApiSummary', () => {
  it('collapses passed -> completed and escalated -> failed', () => {
    expect(attemptToApiSummary(attemptRow({ state: 'passed' }), 0).state).toBe('completed');
    expect(attemptToApiSummary(attemptRow({ state: 'escalated' }), 0).state).toBe('failed');
  });

  it('passes running/cancelled through unchanged', () => {
    expect(attemptToApiSummary(attemptRow({ state: 'running' }), 0).state).toBe('running');
    expect(attemptToApiSummary(attemptRow({ state: 'cancelled' }), 0).state).toBe('cancelled');
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
    const summary = attemptToApiSummary(run, 7);
    expect(summary.finishedAt).toBe(2_000);
    expect(summary.toolCalls).toBe(7);
    expect(summary.usage).toEqual(usage({ toolCalls: { bash: 3 } }));
    expect(summary.cost).toEqual(cost({ totalUsd: 0.5 }));
  });
});

describe('taskToApiDto', () => {
  const resolved = {
    toolCount: 4,
    currentStep: 'implementation' as const,
    hasCandidate: true,
    url: 'https://tracker.example/issues/1',
    mapTitle: 'Some Map',
    skipReason: 'capacity',
    contextWindow: 200_000,
  };

  it('derives summary from prompt and keeps the full prompt (item-GET shape)', () => {
    const task = taskWithDeps({ prompt: '  Fix the widget  \nmore detail' });
    const dto = taskToApiDto(task, [], resolved);
    expect(dto.summary).toBe('Fix the widget');
    expect(dto.prompt).toBe('  Fix the widget  \nmore detail');
  });

  it('passes every resolved field through untouched', () => {
    const dto = taskToApiDto(taskWithDeps(), [], resolved);
    expect(dto.url).toBe(resolved.url);
    expect(dto.mapTitle).toBe(resolved.mapTitle);
    expect(dto.skipReason).toBe(resolved.skipReason);
    expect(dto.contextWindow).toBe(resolved.contextWindow);
    expect(dto.toolCount).toBe(resolved.toolCount);
    expect(dto.currentStep).toBe(resolved.currentStep);
    expect(dto.hasCandidate).toBe(resolved.hasCandidate);
  });

  it('takes attemptId/runStartedAt from the running run', () => {
    const runs = [
      attemptRow({ id: 10, number: 1, state: 'passed', startedAt: 1_000 }),
      attemptRow({ id: 11, number: 2, state: 'running', startedAt: 5_000 }),
    ];
    const dto = taskToApiDto(taskWithDeps(), runs, resolved);
    expect(dto.attemptId).toBe(11);
    expect(dto.runStartedAt).toBe(5_000);
  });

  it('has no attemptId/runStartedAt when no run is running', () => {
    const runs = [attemptRow({ id: 10, number: 1, state: 'passed' })];
    const dto = taskToApiDto(taskWithDeps(), runs, resolved);
    expect(dto.attemptId).toBeNull();
    expect(dto.runStartedAt).toBeNull();
  });

  it('strips the durable tracker-fact columns', () => {
    const task = taskWithDeps({
      trackerState: 'open',
      trackerParent: 5,
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

  it('narrows workspaceId to number', () => {
    const dto = taskToApiDto(taskWithDeps({ workspaceId: 3 }), [], resolved);
    expect(dto.workspaceId).toBe(3);
  });
});

describe('epicToListRow', () => {
  it('projects a Ticket onto a list row with isEpic/humanOnly set and identity fields threaded', () => {
    const row = epicToListRow(ticket({ number: 42, title: 'The Epic', url: 'https://tracker.example/42' }), 9);
    expect(row.isEpic).toBe(true);
    expect(row.humanOnly).toBe(true);
    expect(row.id).toBe(42);
    expect(row.summary).toBe('The Epic');
    expect(row.url).toBe('https://tracker.example/42');
    expect(row.workspaceId).toBe(9);
  });

  it('has no prompt key — it is a list row', () => {
    const row = epicToListRow(ticket(), 1);
    expect(Object.prototype.hasOwnProperty.call(row, 'prompt')).toBe(false);
  });
});

describe('conversationToApiDto', () => {
  const resolved = {
    title: 'Resolved title',
    cost: cost({ totalUsd: 2 }),
    contextWindow: 200_000,
    cacheTtlSeconds: 3600,
  };

  it('parses usage from JSON', () => {
    const conversation = conversationRow({ usage: JSON.stringify(usage({ toolCalls: { grep: 1 } })) });
    const dto = conversationToApiDto(conversation, resolved);
    expect(dto.usage).toEqual(usage({ toolCalls: { grep: 1 } }));
  });

  it('takes title/cost/contextWindow/cacheTtlSeconds from resolved', () => {
    const dto = conversationToApiDto(conversationRow({ title: 'Operator title' }), resolved);
    expect(dto.title).toBe('Resolved title');
    expect(dto.cost).toEqual(resolved.cost);
    expect(dto.contextWindow).toBe(200_000);
    expect(dto.cacheTtlSeconds).toBe(3600);
  });

  it('narrows workspaceId to number', () => {
    const dto = conversationToApiDto(conversationRow({ workspaceId: 6 }), resolved);
    expect(dto.workspaceId).toBe(6);
  });
});

describe('attemptProcessToApi', () => {
  const task = { prompt: '', workspaceId: 2, harness: 'claude', model: 'claude-sonnet-5', isolationMode: 'worktree', trackerRef: null, state: 'working' as const };

  it('is type "attempt" with attemptId/taskId set', () => {
    const result = attemptProcessToApi({
      run: attemptRow({ id: 5, taskId: 8 }),
      task,
      snapshot: null,
      workspaceName: 'Default',
      trackerUrl: null,
      contextWindow: null,
      cost: null,
    });
    expect(result.type).toBe('attempt');
    expect(result.attemptId).toBe(5);
    expect(result.taskId).toBe(8);
    expect(result.conversationId).toBeNull();
  });

  it('falls back the title to "Task N" when the prompt has no title', () => {
    const result = attemptProcessToApi({
      run: attemptRow({ taskId: 8 }),
      task,
      snapshot: null,
      workspaceName: 'Default',
      trackerUrl: null,
      contextWindow: null,
      cost: null,
    });
    expect(result.title).toBe('Task 8');
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
  it('is type "chat" with conversationId set and attempt-only fields null', () => {
    const result = conversationProcessToApi({
      conversation: conversationRow({ id: 9 }),
      title: 'Conversation #9',
      workspaceName: 'Default',
      contextWindow: null,
      cost: null,
    });
    expect(result.type).toBe('chat');
    expect(result.conversationId).toBe(9);
    expect(result.attemptId).toBeNull();
    expect(result.taskId).toBeNull();
    expect(result.trackerRef).toBeNull();
    expect(result.trackerUrl).toBeNull();
    expect(result.escalated).toBe(false);
    expect(result.activity).toBeNull();
    expect(result.tree).toBeNull();
  });

  it('threads the given title straight through', () => {
    const result = conversationProcessToApi({
      conversation: conversationRow(),
      title: 'Conversation #9',
      workspaceName: 'Default',
      contextWindow: null,
      cost: null,
    });
    expect(result.title).toBe('Conversation #9');
  });
});
