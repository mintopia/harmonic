import { describe, it, expect } from 'vitest';
import { buildLeaseDiagnostics } from '../src/domain/lease-diagnostics.js';
import type { RunRow, TaskRow, WorkContextLeaseRow } from '../src/db/schema.js';
import { workContextKey } from '../src/domain/work-context-key.js';

/** Minimal fixture builders — only the fields `buildLeaseDiagnostics` reads
 * are meaningful; the rest are filler so the object satisfies the row shape. */
function lease(overrides: Partial<WorkContextLeaseRow> & Pick<WorkContextLeaseRow, 'key' | 'ownerRunId'>): WorkContextLeaseRow {
  return {
    id: 1,
    phase: 'executing',
    heartbeat: 1_000,
    expiry: 2_000,
    state: 'held',
    acquiredAt: 500,
    ...overrides,
  };
}

function run(overrides: Partial<RunRow> & Pick<RunRow, 'id' | 'taskId'>): RunRow {
  return {
    attempt: 1,
    state: 'running',
    phase: 'executing',
    reviewDeadline: null,
    reason: null,
    stopReason: null,
    sessionId: null,
    sessionRowId: null,
    chainId: null,
    prompt: null,
    branch: null,
    baseBranch: null,
    stat: null,
    candidateOid: null,
    candidateRef: null,
    usage: null,
    cost: null,
    liveUsage: null,
    guardrailConfig: null,
    priceTable: null,
    review: null,
    reviewFeedback: null,
    reviewedAt: null,
    startedAt: 0,
    finishedAt: null,
    ...overrides,
  };
}

function task(overrides: Partial<TaskRow> & Pick<TaskRow, 'id'>): TaskRow {
  return {
    prompt: 'a task',
    harness: 'claude',
    model: 'sonnet-5',
    workingDir: '/tmp/repo',
    isolationMode: 'direct',
    priority: 'normal',
    baseBranch: null,
    state: 'running',
    workspaceId: 1,
    feedback: null,
    continuationChoice: null,
    origin: 'native',
    trackerRef: null,
    workflow: null,
    wayfinderType: null,
    drive: 'afk',
    escalated: false,
    mapRef: null,
    trackerState: null,
    trackerParent: null,
    trackerBlockedBy: null,
    trackerLabels: null,
    trackerTitle: null,
    trackerBody: null,
    trackerUrl: null,
    trackerCreatedAt: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

const DIRECT_KEY = workContextKey({ isolationMode: 'direct', workingDir: '/tmp/repo' });

/**
 * `buildLeaseDiagnostics` (issue #125): pure, no clock/I-O — every input
 * (leases/runs/tasks/waitingSince/now) is passed in, so the join/waiter logic
 * is exhaustively unit-testable without a database.
 */
describe('buildLeaseDiagnostics (issue #125)', () => {
  it('joins a held lease to its owner Run/Task and reports its waiters', () => {
    const ownerTask = task({ id: 1, workingDir: '/tmp/repo', state: 'running' });
    const ownerRun = run({ id: 10, taskId: 1 });
    const waiter = task({ id: 2, workingDir: '/tmp/repo', state: 'ready' });
    const l = lease({ key: DIRECT_KEY, ownerRunId: 10 });

    const now = 100_000;
    const diagnostics = buildLeaseDiagnostics({
      leases: [l],
      runs: [ownerRun],
      tasks: [ownerTask, waiter],
      waitingSince: (id) => (id === 2 ? 40_000 : undefined),
      now,
    });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      key: DIRECT_KEY,
      state: 'held',
      ownerRunId: 10,
      ownerTaskId: 1,
      ownerTaskTitle: ownerTask.prompt,
      ownerTaskState: 'running',
      waitingTaskCount: 1,
      longestWaitMs: 60_000,
    });
  });

  it('reports a suspect lease the same way, state carried through verbatim', () => {
    const ownerTask = task({ id: 1, workingDir: '/tmp/repo' });
    const ownerRun = run({ id: 10, taskId: 1 });
    const l = lease({ key: DIRECT_KEY, ownerRunId: 10, state: 'suspect' });

    const [d] = buildLeaseDiagnostics({
      leases: [l],
      runs: [ownerRun],
      tasks: [ownerTask],
      waitingSince: () => undefined,
      now: 0,
    });

    expect(d!.state).toBe('suspect');
  });

  it('nulls the owner fields when the owning Run row is missing', () => {
    const l = lease({ key: DIRECT_KEY, ownerRunId: 999 });

    const [d] = buildLeaseDiagnostics({ leases: [l], runs: [], tasks: [], waitingSince: () => undefined, now: 0 });

    expect(d).toMatchObject({
      ownerRunId: 999,
      ownerTaskId: null,
      ownerTaskTitle: null,
      ownerTaskState: null,
    });
  });

  it('reports no waiters (null wait, zero count) when nothing ready is blocked on the key', () => {
    const ownerTask = task({ id: 1, workingDir: '/tmp/repo' });
    const ownerRun = run({ id: 10, taskId: 1 });
    const l = lease({ key: DIRECT_KEY, ownerRunId: 10 });

    const [d] = buildLeaseDiagnostics({
      leases: [l],
      runs: [ownerRun],
      tasks: [ownerTask],
      waitingSince: () => undefined,
      now: 0,
    });

    expect(d).toMatchObject({ waitingTaskCount: 0, longestWaitMs: null });
  });

  it('a waiter with no tracked wait-start is counted but does not contribute a wait time', () => {
    const ownerTask = task({ id: 1, workingDir: '/tmp/repo' });
    const ownerRun = run({ id: 10, taskId: 1 });
    const waiter = task({ id: 2, workingDir: '/tmp/repo', state: 'ready' });
    const l = lease({ key: DIRECT_KEY, ownerRunId: 10 });

    const [d] = buildLeaseDiagnostics({
      leases: [l],
      runs: [ownerRun],
      tasks: [ownerTask, waiter],
      waitingSince: () => undefined,
      now: 100_000,
    });

    expect(d).toMatchObject({ waitingTaskCount: 1, longestWaitMs: null });
  });

  it('picks the longest wait among multiple waiters', () => {
    const ownerTask = task({ id: 1, workingDir: '/tmp/repo' });
    const ownerRun = run({ id: 10, taskId: 1 });
    const waiterA = task({ id: 2, workingDir: '/tmp/repo', state: 'ready' });
    const waiterB = task({ id: 3, workingDir: '/tmp/repo', state: 'ready' });
    const l = lease({ key: DIRECT_KEY, ownerRunId: 10 });

    const now = 100_000;
    const [d] = buildLeaseDiagnostics({
      leases: [l],
      runs: [ownerRun],
      tasks: [ownerTask, waiterA, waiterB],
      waitingSince: (id) => (id === 2 ? 90_000 : id === 3 ? 10_000 : undefined),
      now,
    });

    expect(d).toMatchObject({ waitingTaskCount: 2, longestWaitMs: 90_000 });
  });

  it('a worktree-keyed lease has no direct-mode waiters, even with ready direct Tasks present', () => {
    const worktreeKey = workContextKey({ isolationMode: 'worktree', workingDir: '/tmp/repo', worktreePath: '/tmp/wt', branch: 'harmonic/task-1-run-1' });
    const ownerTask = task({ id: 1, workingDir: '/tmp/repo' });
    const ownerRun = run({ id: 10, taskId: 1 });
    // A ready direct-mode Task on an unrelated directory never matches a worktree key.
    const unrelated = task({ id: 2, workingDir: '/tmp/other', state: 'ready' });
    const l = lease({ key: worktreeKey, ownerRunId: 10 });

    const [d] = buildLeaseDiagnostics({
      leases: [l],
      runs: [ownerRun],
      tasks: [ownerTask, unrelated],
      waitingSince: () => 0,
      now: 100_000,
    });

    expect(d).toMatchObject({ key: worktreeKey, waitingTaskCount: 0, longestWaitMs: null });
  });

  it('ignores a ready Task that is worktree-mode even on the same workingDir', () => {
    const ownerTask = task({ id: 1, workingDir: '/tmp/repo' });
    const ownerRun = run({ id: 10, taskId: 1 });
    const worktreeReady = task({ id: 2, workingDir: '/tmp/repo', state: 'ready', isolationMode: 'worktree' });
    const l = lease({ key: DIRECT_KEY, ownerRunId: 10 });

    const [d] = buildLeaseDiagnostics({
      leases: [l],
      runs: [ownerRun],
      tasks: [ownerTask, worktreeReady],
      waitingSince: () => 0,
      now: 0,
    });

    expect(d).toMatchObject({ waitingTaskCount: 0 });
  });

  it('produces one entry per lease, independent of how many leases are passed', () => {
    const ownerRun1 = run({ id: 10, taskId: 1 });
    const ownerRun2 = run({ id: 20, taskId: 2 });
    const t1 = task({ id: 1, workingDir: '/tmp/a' });
    const t2 = task({ id: 2, workingDir: '/tmp/b' });
    const l1 = lease({ id: 1, key: workContextKey({ isolationMode: 'direct', workingDir: '/tmp/a' }), ownerRunId: 10 });
    const l2 = lease({ id: 2, key: workContextKey({ isolationMode: 'direct', workingDir: '/tmp/b' }), ownerRunId: 20 });

    const diagnostics = buildLeaseDiagnostics({
      leases: [l1, l2],
      runs: [ownerRun1, ownerRun2],
      tasks: [t1, t2],
      waitingSince: () => undefined,
      now: 0,
    });

    expect(diagnostics).toHaveLength(2);
    expect(diagnostics.map((d) => d.ownerRunId).sort()).toEqual([10, 20]);
  });
});
