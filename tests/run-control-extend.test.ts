import { describe, expect, it, vi } from 'vitest';
import { RunControl, type RunControlDeps } from '../src/execution/run-control.js';
import { ActiveRuns } from '../src/execution/active-runs.js';
import type { TaskAttemptRow, AttemptEventRow } from '../src/db/schema.js';

const guardrailConfig = (wallClockMinutes: number) =>
  JSON.stringify({ budget: { wallClockMinutes }, progress: false, toolTimeoutMinutes: 10 });

function runningAttempt(over: Partial<TaskAttemptRow> = {}): TaskAttemptRow {
  return {
    id: 42,
    taskId: 7,
    workspaceId: null,
    epicRef: null,
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
    guardrailConfig: guardrailConfig(60),
    priceTable: null,
    detail: null,
    pid: null,
    pgid: null,
    procStartToken: null,
    ...over,
  };
}

describe('RunControl.extendGuardrail — between-turns (no ActiveRun)', () => {
  it('extends a working task from the durable running Attempt even when no ActiveRun is registered for it', async () => {
    let persisted = runningAttempt();
    const update = vi.fn(async (_id: number, patch: { guardrailConfig?: string | null }) => {
      persisted = { ...persisted, ...patch };
      return persisted;
    });
    const appendEvent = vi.fn(async (_attemptId: number, input: { type: string; payload: unknown }) => ({
      id: 1,
      attemptId: 42,
      seq: 1,
      ts: Date.now(),
      type: input.type,
      payload: input.payload,
    }) as unknown as AttemptEventRow);
    const onAttemptEvent = vi.fn();

    // A real, empty ActiveRuns: there is genuinely no live ActiveRun for this
    // task — the between-turns case (gates, verification, continuations).
    const activeRuns = new ActiveRuns();

    const deps: RunControlDeps = {
      taskService: { get: vi.fn(async () => ({ state: 'working' })) } as unknown as RunControlDeps['taskService'],
      attempts: {
        getRunningForTask: vi.fn(async () => persisted),
        update,
        appendEvent,
      } as unknown as RunControlDeps['attempts'],
      activeRuns,
      events: { onAttemptEvent } as unknown as RunControlDeps['events'],
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
    };

    const runControl = new RunControl(deps);
    const ok = await runControl.extendGuardrail(7, 60);

    expect(ok).toBe(true);
    expect(persisted.guardrailConfig).toContain('"wallClockMinutes":120');
    expect(appendEvent).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        type: 'lifecycle',
        payload: expect.objectContaining({ event: 'guardrail_extended', addMinutes: 60, wallClockMinutes: 120 }),
      }),
    );
  });

  it('returns false when the task is working but has no running Attempt at all', async () => {
    const deps: RunControlDeps = {
      taskService: { get: vi.fn(async () => ({ state: 'working' })) } as unknown as RunControlDeps['taskService'],
      attempts: {
        getRunningForTask: vi.fn(async () => undefined),
      } as unknown as RunControlDeps['attempts'],
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
    };

    const runControl = new RunControl(deps);
    expect(await runControl.extendGuardrail(7, 60)).toBe(false);
  });
});
