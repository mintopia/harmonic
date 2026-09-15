import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GuardrailSupervisor } from '../src/execution/guardrail-supervisor.js';

const MINUTE = 60_000;

// A mutable attempt row the stub `attempts.get` reads through, so a test can
// bump `startedAt` the way `Runner.resume` bumps the DB row on resume.
function makeSupervisor(state: { startedAt: number }, onTrip: () => void) {
  const row = () => ({
    id: 1,
    state: 'running',
    startedAt: state.startedAt,
    guardrailConfig: JSON.stringify({ budget: { wallClockMinutes: 60 }, progress: false, toolTimeoutMinutes: 20 }),
    priceTable: null,
  });
  const deps = {
    attempts: {
      get: vi.fn(async () => row()),
      currentStepType: vi.fn(async () => 'implementation' as const),
    },
    guardrailEvents: { append: vi.fn(async () => undefined) },
    getWorkspace: undefined,
    sampleSnapshot: vi.fn(async () => null),
    spendPollMs: 1_000,
    spendGraceMs: 1_000,
  };
  const turn = {
    taskId: 1,
    workspaceId: null,
    attemptId: 1,
    attemptNumber: 1,
    progressTrace: [],
    attemptForTrip: async () => row(),
    outstandingAction: () => undefined,
    record: () => {},
    settle: async () => {
      onTrip();
    },
    abort: () => {},
    kill: () => {},
    isSettled: () => false,
    isFinishing: () => false,
    hasPendingSteer: () => false,
    pushSteer: () => {},
  };
  return new GuardrailSupervisor(deps as any, turn as any);
}

describe('GuardrailSupervisor.resetWallClock', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('restarts the 60-minute wall clock from the reset origin, dropping the elapsed span', async () => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const state = { startedAt: Date.now() - 30 * MINUTE }; // 30 min already elapsed
    let tripped = false;
    const sup = makeSupervisor(state, () => {
      tripped = true;
    });
    await sup.prime();
    sup.armWallClock();

    // Original deadline is 30 min out; 29 min in, nothing has tripped.
    await vi.advanceTimersByTimeAsync(29 * MINUTE);
    expect(tripped).toBe(false);

    // Operator resumes: the DB row is bumped to now and the guard re-armed.
    state.startedAt = Date.now();
    sup.resetWallClock(Date.now());

    // The original deadline passes — the reset must have dropped it.
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(tripped).toBe(false);

    // A full fresh 60 minutes from the reset trips the guard.
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(tripped).toBe(true);
  });
});
