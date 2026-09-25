import { describe, expect, it, vi } from 'vitest';
import { RunControl, type RunControlDeps } from '../src/execution/run-control.js';
import { ActiveRuns } from '../src/execution/active-runs.js';
import type { TaskAttemptRow, TaskRow } from '../src/db/schema.js';

function pausedTask(over: Partial<TaskRow> = {}): TaskRow {
  return { id: 7, state: 'paused', continuationChoice: null } as TaskRow & Record<string, unknown> as TaskRow & typeof over;
}

function runningAttempt(over: Partial<TaskAttemptRow> = {}): TaskAttemptRow {
  return {
    id: 42,
    taskId: 7,
    number: 1,
    state: 'running',
    sessionRowId: null,
    sessionId: null,
    ...over,
  } as TaskAttemptRow;
}

describe('RunControl.resumePaused — a paused Task with no retained Session at all (never ran to a Session)', () => {
  it('starts work on the still-running Attempt row instead of refusing', async () => {
    const task = pausedTask();
    const attempt = runningAttempt();
    let taskState = 'paused';

    const setState = vi.fn(async (_id: number, state: string) => {
      taskState = state;
      return { ...task, state } as TaskRow;
    });
    const beginRun = vi.fn(async (_t: TaskRow, _parent: unknown, resumedAttempt?: TaskAttemptRow) => {
      expect(resumedAttempt?.id).toBe(attempt.id);
      return { ...attempt, state: 'running' } as TaskAttemptRow;
    });

    const deps: RunControlDeps = {
      taskService: {
        get: vi.fn(async () => ({ ...task, state: taskState }) as TaskRow),
        resume: vi.fn(async () => {
          taskState = 'working';
          return { ...task, state: 'working' } as TaskRow;
        }),
        setState,
        setContinuationChoice: vi.fn(async (_id: number, choice: string) => ({ ...task, continuationChoice: choice }) as TaskRow),
      } as unknown as RunControlDeps['taskService'],
      attempts: {
        getRunningForTask: vi.fn(async () => attempt),
      } as unknown as RunControlDeps['attempts'],
      activeRuns: new ActiveRuns(),
      events: {} as unknown as RunControlDeps['events'],
      getWorkspace: undefined,
      getConfig: vi.fn() as unknown as RunControlDeps['getConfig'],
      isGloballyPaused: undefined,
      onGloballyPaused: undefined,
      sessionContinuation: {
        // No prior Attempt ever recorded a Session.
        resolveContinuationSource: vi.fn(async () => null),
        resumeEligibilityFor: vi.fn(),
      } as unknown as RunControlDeps['sessionContinuation'],
      emitSteerLog: vi.fn(),
      recordLifecycleTransition: vi.fn(async () => {}),
      start: vi.fn() as unknown as RunControlDeps['start'],
      launchClaimed: vi.fn() as unknown as RunControlDeps['launchClaimed'],
      beginRun: beginRun as unknown as RunControlDeps['beginRun'],
    };

    const runControl = new RunControl(deps);
    const result = await runControl.resumePaused(7);

    expect(result.state).toBe('working');
    expect(beginRun).toHaveBeenCalledTimes(1);
    expect(deps.taskService.setContinuationChoice).not.toHaveBeenCalled();
  });

  it('steerPaused delivers the operator message via the same fallback, never a 409', async () => {
    const task = pausedTask();
    const attempt = runningAttempt();
    let taskState = 'paused';

    const beginRun = vi.fn(async () => ({ ...attempt, state: 'running' }) as TaskAttemptRow);
    const activeRuns = new ActiveRuns();

    const deps: RunControlDeps = {
      taskService: {
        get: vi.fn(async () => ({ ...task, state: taskState }) as TaskRow),
        resume: vi.fn(async () => {
          taskState = 'working';
          return { ...task, state: 'working' } as TaskRow;
        }),
        setState: vi.fn(async (_id: number, state: string) => {
          taskState = state;
          return { ...task, state } as TaskRow;
        }),
        setContinuationChoice: vi.fn(async (_id: number, choice: string) => ({ ...task, continuationChoice: choice }) as TaskRow),
      } as unknown as RunControlDeps['taskService'],
      attempts: {
        getRunningForTask: vi.fn(async () => attempt),
      } as unknown as RunControlDeps['attempts'],
      activeRuns,
      events: {} as unknown as RunControlDeps['events'],
      getWorkspace: undefined,
      getConfig: vi.fn() as unknown as RunControlDeps['getConfig'],
      isGloballyPaused: undefined,
      onGloballyPaused: undefined,
      sessionContinuation: {
        resolveContinuationSource: vi.fn(async () => null),
        resumeEligibilityFor: vi.fn(),
      } as unknown as RunControlDeps['sessionContinuation'],
      emitSteerLog: vi.fn(),
      recordLifecycleTransition: vi.fn(async () => {}),
      start: vi.fn() as unknown as RunControlDeps['start'],
      launchClaimed: vi.fn() as unknown as RunControlDeps['launchClaimed'],
      beginRun: beginRun as unknown as RunControlDeps['beginRun'],
    };

    const runControl = new RunControl(deps);
    const ok = await runControl.steerPaused(7, 'get moving again');

    expect(ok).toBe(true);
    expect(beginRun).toHaveBeenCalledTimes(1);
    expect(activeRuns.takePendingOperatorSeed(7)).toBe('get moving again');
  });
});
