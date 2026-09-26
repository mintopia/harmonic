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

describe('RunControl — a working Task mid-drive between turns (no ActiveRun, but ActiveRuns.isDriving)', () => {
  function workingTask(over: Partial<TaskRow> = {}): TaskRow {
    return { id: 7, state: 'working', continuationChoice: null, ...over } as TaskRow;
  }

  it('steerWorking seeds the operator message for the next turn instead of relaunching a second drive loop', async () => {
    const task = workingTask();
    const attempt = runningAttempt();
    const activeRuns = new ActiveRuns();
    activeRuns.markDriving(7);

    const launchClaimed = vi.fn();
    const appendEvent = vi.fn(async (_attemptId: number, input: { type: string; payload: unknown }) => ({
      id: 1,
      attemptId: attempt.id,
      seq: 1,
      ts: Date.now(),
      type: input.type,
      payload: input.payload,
    }));
    const onAttemptEvent = vi.fn();
    const emitSteerLog = vi.fn();

    const deps: RunControlDeps = {
      taskService: { get: vi.fn(async () => task) } as unknown as RunControlDeps['taskService'],
      attempts: {
        getRunningForTask: vi.fn(async () => attempt),
        appendEvent,
      } as unknown as RunControlDeps['attempts'],
      activeRuns,
      events: { onAttemptEvent } as unknown as RunControlDeps['events'],
      getWorkspace: undefined,
      getConfig: vi.fn() as unknown as RunControlDeps['getConfig'],
      isGloballyPaused: undefined,
      onGloballyPaused: undefined,
      sessionContinuation: {
        resolveContinuationSource: vi.fn(async () => null),
        resumeEligibilityFor: vi.fn(),
      } as unknown as RunControlDeps['sessionContinuation'],
      emitSteerLog,
      recordLifecycleTransition: vi.fn(async () => {}),
      start: vi.fn() as unknown as RunControlDeps['start'],
      launchClaimed: launchClaimed as unknown as RunControlDeps['launchClaimed'],
      beginRun: vi.fn() as unknown as RunControlDeps['beginRun'],
    };

    const runControl = new RunControl(deps);
    const ok = await runControl.steerWorking(7, 'still there?');

    expect(ok).toBe(true);
    expect(launchClaimed).not.toHaveBeenCalled();
    expect(activeRuns.takePendingOperatorSeed(7)).toBe('still there?');
    expect(emitSteerLog).toHaveBeenCalledWith({ attemptId: attempt.id, text: 'still there?', queued: true });
  });

  it('two steers accepted while driving between turns both survive, in order (ADR-0005 §6)', async () => {
    const task = workingTask();
    const attempt = runningAttempt();
    const activeRuns = new ActiveRuns();
    activeRuns.markDriving(7);

    const deps: RunControlDeps = {
      taskService: { get: vi.fn(async () => task) } as unknown as RunControlDeps['taskService'],
      attempts: {
        getRunningForTask: vi.fn(async () => attempt),
        appendEvent: vi.fn(async () => ({}) as never),
      } as unknown as RunControlDeps['attempts'],
      activeRuns,
      events: { onAttemptEvent: vi.fn() } as unknown as RunControlDeps['events'],
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
      beginRun: vi.fn() as unknown as RunControlDeps['beginRun'],
    };

    const runControl = new RunControl(deps);
    expect(await runControl.steerWorking(7, 'first message')).toBe(true);
    expect(await runControl.steerWorking(7, 'second message')).toBe(true);

    // The next turn's prompt build calls takePendingOperatorSeed exactly once —
    // it must see both, not just the second overwriting the first.
    const seed = activeRuns.takePendingOperatorSeed(7);
    expect(seed).toContain('first message');
    expect(seed).toContain('second message');
    expect(seed!.indexOf('first message')).toBeLessThan(seed!.indexOf('second message'));
  });

  it('resume returns false rather than relaunching a second drive loop', async () => {
    const task = { id: 7, state: 'paused', continuationChoice: null } as TaskRow;
    const activeRuns = new ActiveRuns();
    activeRuns.markDriving(7);
    const launchClaimed = vi.fn();

    const deps: RunControlDeps = {
      taskService: { get: vi.fn(async () => task), resume: vi.fn() } as unknown as RunControlDeps['taskService'],
      attempts: { getRunningForTask: vi.fn(async () => runningAttempt()) } as unknown as RunControlDeps['attempts'],
      activeRuns,
      events: {} as unknown as RunControlDeps['events'],
      getWorkspace: undefined,
      getConfig: vi.fn() as unknown as RunControlDeps['getConfig'],
      isGloballyPaused: undefined,
      onGloballyPaused: undefined,
      sessionContinuation: {} as unknown as RunControlDeps['sessionContinuation'],
      emitSteerLog: vi.fn(),
      recordLifecycleTransition: vi.fn(async () => {}),
      start: vi.fn() as unknown as RunControlDeps['start'],
      launchClaimed: launchClaimed as unknown as RunControlDeps['launchClaimed'],
      beginRun: vi.fn() as unknown as RunControlDeps['beginRun'],
    };

    const runControl = new RunControl(deps);
    expect(await runControl.resume(7)).toBe(false);
    expect(launchClaimed).not.toHaveBeenCalled();
  });

  it('resumePaused defers to the driving loop rather than launching a second one', async () => {
    const task = { id: 7, state: 'paused', continuationChoice: null } as TaskRow;
    const activeRuns = new ActiveRuns();
    activeRuns.markDriving(7);
    const beginRun = vi.fn();
    const resume = vi.fn(async () => ({ ...task, state: 'working' }) as TaskRow);

    const deps: RunControlDeps = {
      taskService: { get: vi.fn(async () => task), resume } as unknown as RunControlDeps['taskService'],
      attempts: {} as unknown as RunControlDeps['attempts'],
      activeRuns,
      events: {} as unknown as RunControlDeps['events'],
      getWorkspace: undefined,
      getConfig: vi.fn() as unknown as RunControlDeps['getConfig'],
      isGloballyPaused: undefined,
      onGloballyPaused: undefined,
      sessionContinuation: {} as unknown as RunControlDeps['sessionContinuation'],
      emitSteerLog: vi.fn(),
      recordLifecycleTransition: vi.fn(async () => {}),
      start: vi.fn() as unknown as RunControlDeps['start'],
      launchClaimed: vi.fn() as unknown as RunControlDeps['launchClaimed'],
      beginRun: beginRun as unknown as RunControlDeps['beginRun'],
    };

    const runControl = new RunControl(deps);
    const result = await runControl.resumePaused(7);

    expect(result.state).toBe('working');
    expect(beginRun).not.toHaveBeenCalled();
    expect(resume).toHaveBeenCalledTimes(1);
  });
});

describe('RunControl.steerSettled — an escalated Task that never recorded a Session', () => {
  it('requeues fresh and seeds the operator message instead of refusing', async () => {
    const task = { id: 7, state: 'escalated', continuationChoice: null } as TaskRow;
    const activeRuns = new ActiveRuns();
    const requeue = vi.fn(async () => ({ ...task, state: 'ready' }) as TaskRow);
    const start = vi.fn(async () => ({ id: 42 }) as TaskAttemptRow);

    const deps: RunControlDeps = {
      taskService: { get: vi.fn(async () => task), requeue } as unknown as RunControlDeps['taskService'],
      attempts: {} as unknown as RunControlDeps['attempts'],
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
      start: start as unknown as RunControlDeps['start'],
      launchClaimed: vi.fn() as unknown as RunControlDeps['launchClaimed'],
      beginRun: vi.fn() as unknown as RunControlDeps['beginRun'],
    };

    const runControl = new RunControl(deps);
    const ok = await runControl.steerSettled(7, 'pick this back up');

    expect(ok).toBe(true);
    expect(requeue).toHaveBeenCalledWith(7, undefined, undefined);
    expect(start).toHaveBeenCalledWith(7);
    expect(activeRuns.takePendingOperatorSeed(7)).toBe('pick this back up');
  });
});

describe('RunControl — concurrent launch race on the same stranded/paused Task', () => {
  it('resume: two concurrent calls launch exactly once, the loser returns false', async () => {
    const task = { id: 7, state: 'paused', continuationChoice: null } as TaskRow;
    const attempt = runningAttempt();
    const activeRuns = new ActiveRuns();
    const launchClaimed = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { ...attempt, state: 'running' } as TaskAttemptRow;
    });

    const deps: RunControlDeps = {
      taskService: {
        get: vi.fn(async () => task),
        resume: vi.fn(async () => ({ ...task, state: 'working' }) as TaskRow),
        setContinuationChoice: vi.fn(async () => task),
      } as unknown as RunControlDeps['taskService'],
      attempts: {
        getRunningForTask: vi.fn(async () => attempt),
        update: vi.fn(async () => attempt),
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
      launchClaimed: launchClaimed as unknown as RunControlDeps['launchClaimed'],
      beginRun: vi.fn() as unknown as RunControlDeps['beginRun'],
    };

    const runControl = new RunControl(deps);
    const [a, b] = await Promise.all([runControl.resume(7), runControl.resume(7)]);

    expect(launchClaimed).toHaveBeenCalledTimes(1);
    expect([a, b].filter((v) => v === true)).toHaveLength(1);
    expect([a, b].filter((v) => v === false)).toHaveLength(1);
  });

  it('steerWorking: two concurrent calls launch exactly once, the loser delivers via the seed path', async () => {
    const task = { id: 7, state: 'working', continuationChoice: null } as TaskRow;
    const attempt = runningAttempt();
    const activeRuns = new ActiveRuns();
    const launchClaimed = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { ...attempt, state: 'running' } as TaskAttemptRow;
    });

    const deps: RunControlDeps = {
      taskService: { get: vi.fn(async () => task) } as unknown as RunControlDeps['taskService'],
      attempts: {
        getRunningForTask: vi.fn(async () => attempt),
        appendEvent: vi.fn(async () => ({}) as never),
      } as unknown as RunControlDeps['attempts'],
      activeRuns,
      events: { onAttemptEvent: vi.fn() } as unknown as RunControlDeps['events'],
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
      launchClaimed: launchClaimed as unknown as RunControlDeps['launchClaimed'],
      beginRun: vi.fn() as unknown as RunControlDeps['beginRun'],
    };

    const runControl = new RunControl(deps);
    const [a, b] = await Promise.all([runControl.steerWorking(7, 'first'), runControl.steerWorking(7, 'second')]);

    expect(launchClaimed).toHaveBeenCalledTimes(1);
    expect(a).toBe(true);
    expect(b).toBe(true);
  });

  it('resumePaused: two concurrent calls call beginRun exactly once', async () => {
    const task = { id: 7, state: 'paused', continuationChoice: null } as TaskRow;
    const attempt = runningAttempt();
    const activeRuns = new ActiveRuns();
    let taskState = 'paused';
    const beginRun = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { ...attempt, state: 'running' } as TaskAttemptRow;
    });

    const deps: RunControlDeps = {
      taskService: {
        get: vi.fn(async () => ({ ...task, state: taskState }) as TaskRow),
        resume: vi.fn(async () => {
          taskState = 'working';
          return { ...task, state: 'working' } as TaskRow;
        }),
      } as unknown as RunControlDeps['taskService'],
      attempts: { getRunningForTask: vi.fn(async () => attempt) } as unknown as RunControlDeps['attempts'],
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
    const [a, b] = await Promise.all([runControl.resumePaused(7), runControl.resumePaused(7)]);

    expect(beginRun).toHaveBeenCalledTimes(1);
    expect(a.state).toBe('working');
    expect(b.state).toBe('working');
  });
});
