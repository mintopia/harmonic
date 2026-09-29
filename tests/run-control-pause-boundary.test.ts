import { describe, expect, it, vi } from 'vitest';
import { RunControl, type RunControlDeps } from '../src/execution/run-control.js';
import { ActiveRuns, type ActiveRun } from '../src/execution/active-runs.js';
import type { TaskRow } from '../src/db/schema.js';

function workingTask(over: Partial<TaskRow> = {}): TaskRow {
  return { id: 7, state: 'working', continuationChoice: null, ...over } as TaskRow;
}

function baseDeps(overrides: Partial<RunControlDeps> = {}): RunControlDeps {
  return {
    taskService: { get: vi.fn(), pause: vi.fn(async () => workingTask({ state: 'paused' })) } as unknown as RunControlDeps['taskService'],
    attempts: {} as unknown as RunControlDeps['attempts'],
    activeRuns: new ActiveRuns(),
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
    beginRun: vi.fn() as unknown as RunControlDeps['beginRun'],
    ...overrides,
  };
}

/** A settling/verifying ActiveRun: past its steerable prompt loop, so nothing
 * in the driven turn will read `pauseRequested` again this Attempt. */
function nonSteerableActive(over: Partial<ActiveRun> = {}): ActiveRun {
  return {
    attemptId: 42,
    taskId: 7,
    steerable: false,
    pauseRequested: false,
    pauseReason: null,
    globalPauseRequested: false,
    ...over,
  } as unknown as ActiveRun;
}

describe('RunControl.pause — an ActiveRun mid-verify/merge (not steerable)', () => {
  it('marks intent and a pending boundary marker without writing Task state itself', async () => {
    const taskService = { get: vi.fn(async () => workingTask()), pause: vi.fn() };
    const activeRuns = new ActiveRuns();
    const active = nonSteerableActive();
    activeRuns.set(active.attemptId, active);

    const runControl = new RunControl(baseDeps({ taskService: taskService as unknown as RunControlDeps['taskService'], activeRuns }));
    const ok = await runControl.pause(7);

    expect(ok).toBe(true);
    expect(active.pauseRequested).toBe(true);
    expect(activeRuns.hasPendingPause(7)).toBe(true);
    // The whole point: refusing to pre-empt whatever this settle turns out to be.
    expect(taskService.pause).not.toHaveBeenCalled();
  });

  it('is dropped, not left stranding the Task, when the settle reaches done before the next boundary', async () => {
    const activeRuns = new ActiveRuns();
    const active = nonSteerableActive();
    activeRuns.set(active.attemptId, active);
    let taskState: TaskRow['state'] = 'working';
    const taskService = {
      get: vi.fn(async () => workingTask({ state: taskState })),
      pause: vi.fn(async () => {
        taskState = 'paused';
        return workingTask({ state: 'paused' });
      }),
    };
    const recordLifecycleTransition = vi.fn(async () => {});
    const runControl = new RunControl(
      baseDeps({ taskService: taskService as unknown as RunControlDeps['taskService'], activeRuns, recordLifecycleTransition }),
    );

    expect(await runControl.pause(7)).toBe(true);
    expect(activeRuns.hasPendingPause(7)).toBe(true);

    // The verify/merge finished and settled the Task done — the operator-pause
    // marker must never win this race and must never touch Task state.
    taskState = 'done';
    const boundary = await runControl.checkRunBoundary(7);

    expect(boundary).toEqual({ stop: true, reason: 'settled' });
    expect(taskService.pause).not.toHaveBeenCalled();
    expect(recordLifecycleTransition).not.toHaveBeenCalled();
    // TurnDriver.drive's finally clears the marker itself once the loop ends;
    // checkRunBoundary's early "settled" return correctly never consumes it.
    expect(activeRuns.hasPendingPause(7)).toBe(true);
    activeRuns.clearPendingPause(7);
    expect(activeRuns.hasPendingPause(7)).toBe(false);
  });
});

describe('RunControl.checkRunBoundary', () => {
  it('reports settled and does not touch pause state for a Task no longer working', async () => {
    const taskService = { get: vi.fn(async () => workingTask({ state: 'cancelled' })), pause: vi.fn() };
    const runControl = new RunControl(baseDeps({ taskService: taskService as unknown as RunControlDeps['taskService'] }));

    expect(await runControl.checkRunBoundary(7)).toEqual({ stop: true, reason: 'settled' });
    expect(taskService.pause).not.toHaveBeenCalled();
  });

  it('honours a global pause and calls the global-pause hook', async () => {
    const taskService = { get: vi.fn(async () => workingTask()), pause: vi.fn(async () => workingTask({ state: 'paused' })) };
    const onGloballyPaused = vi.fn(async () => {});
    const runControl = new RunControl(
      baseDeps({
        taskService: taskService as unknown as RunControlDeps['taskService'],
        isGloballyPaused: () => true,
        onGloballyPaused,
      }),
    );

    expect(await runControl.checkRunBoundary(7)).toEqual({ stop: true, reason: 'global-pause' });
    expect(taskService.pause).toHaveBeenCalledWith(7);
    expect(onGloballyPaused).toHaveBeenCalledWith(7);
  });

  it('consumes a pending operator pause and records the lifecycle transition', async () => {
    const taskService = { get: vi.fn(async () => workingTask()), pause: vi.fn(async () => workingTask({ state: 'paused' })) };
    const activeRuns = new ActiveRuns();
    activeRuns.setPendingPause(7, 'operator request');
    const recordLifecycleTransition = vi.fn(async () => {});
    const runControl = new RunControl(
      baseDeps({ taskService: taskService as unknown as RunControlDeps['taskService'], activeRuns, recordLifecycleTransition }),
    );

    expect(await runControl.checkRunBoundary(7)).toEqual({ stop: true, reason: 'operator-pause', pauseReason: 'operator request' });
    expect(taskService.pause).toHaveBeenCalledWith(7);
    expect(recordLifecycleTransition).toHaveBeenCalledWith(7, 'paused', 'operator request');
    expect(activeRuns.hasPendingPause(7)).toBe(false);
  });

  it('does not stop a plain working Task with nothing pending', async () => {
    const taskService = { get: vi.fn(async () => workingTask()), pause: vi.fn() };
    const runControl = new RunControl(baseDeps({ taskService: taskService as unknown as RunControlDeps['taskService'] }));

    expect(await runControl.checkRunBoundary(7)).toEqual({ stop: false });
    expect(taskService.pause).not.toHaveBeenCalled();
  });
});
