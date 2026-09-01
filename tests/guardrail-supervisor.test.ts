import { describe, expect, it, vi } from 'vitest';
import {
  GuardrailSupervisor,
  PROGRESS_NUDGE_TEXT,
  type GuardrailDeps,
  type GuardrailTurn,
} from '../src/execution/guardrail-supervisor.js';
import type { AttemptRow } from '../src/db/schema.js';
import type { AttemptUsageSnapshot } from '../src/execution/usage.js';
import type { GuardrailEventInput } from '../src/domain/guardrail-events.js';
import type { StepType } from '../src/db/schema.js';
import type { ProgressEvent } from '../src/domain/stall-detector.js';

/**
 * Unit tests for the guardrail-trip logic in isolation (issue #445 acceptance):
 * each dimension trips (or holds) without a full drive turn — the supervisor is
 * driven with plain fakes for its stores + turn callbacks, and the per-fire
 * `evaluate*` bodies are invoked directly.
 */

interface GuardrailSnapshot {
  budget: { wallClockMinutes: number; tokens: number | null; costUsd: number | null };
  progress: boolean;
  toolTimeoutMinutes: number;
}

function budgetSnapshot(over: Partial<GuardrailSnapshot['budget']> = {}): GuardrailSnapshot {
  return { budget: { wallClockMinutes: 45, tokens: null, costUsd: null, ...over }, progress: false, toolTimeoutMinutes: 5 };
}

function snapshotWithTokens(totalTokens: number): AttemptUsageSnapshot {
  return { usage: { models: {}, totals: { totalTokens } } } as unknown as AttemptUsageSnapshot;
}

interface Harness {
  sup: GuardrailSupervisor;
  appended: Array<{ attemptId: number; event: GuardrailEventInput }>;
  settles: Array<{ now: AttemptRow; reason: string }>;
  records: unknown[];
  abort: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  steer: string[];
  state: { attempt: AttemptRow; stepType: StepType | null; settled: boolean; finishing: boolean; snapshot: AttemptUsageSnapshot | null };
  progressTrace: ProgressEvent[];
}

function makeSupervisor(opts: {
  config: GuardrailSnapshot;
  stepType?: StepType | null;
  startedAt?: number;
  snapshot?: AttemptUsageSnapshot | null;
  workspace?: { guardrailBudget?: string | null; guardrailProgress?: string | null };
  priceTable?: string | null;
  progressTrace?: ProgressEvent[];
  outstandingAction?: () => ProgressEvent | undefined;
  spendGraceMs?: number;
}): Harness {
  const attempt = {
    id: 7,
    startedAt: opts.startedAt ?? Date.now(),
    state: 'running',
    guardrailConfig: JSON.stringify(opts.config),
    priceTable: opts.priceTable ?? null,
  } as unknown as AttemptRow;

  const state = {
    attempt,
    stepType: opts.stepType === undefined ? ('implementation' as StepType) : opts.stepType,
    settled: false,
    finishing: false,
    snapshot: opts.snapshot ?? null,
  };

  const appended: Harness['appended'] = [];
  const settles: Harness['settles'] = [];
  const records: unknown[] = [];
  const abort = vi.fn();
  const kill = vi.fn();
  const steer: string[] = [];
  const progressTrace = opts.progressTrace ?? [];

  const deps: GuardrailDeps = {
    attempts: {
      get: async () => state.attempt,
      currentStepType: async () => state.stepType,
    },
    guardrailEvents: {
      append: (async (attemptId: number, event: GuardrailEventInput) => {
        appended.push({ attemptId, event });
        return {} as never;
      }) as GuardrailDeps['guardrailEvents']['append'],
    },
    getWorkspace: (async () => opts.workspace) as GuardrailDeps['getWorkspace'],
    sampleSnapshot: async () => state.snapshot,
    spendPollMs: 1000,
    spendGraceMs: opts.spendGraceMs ?? 60_000,
  };

  const turn: GuardrailTurn = {
    taskId: 1,
    workspaceId: 2,
    attemptId: attempt.id,
    attemptNumber: 1,
    progressTrace,
    attemptForTrip: async () => attempt,
    outstandingAction: opts.outstandingAction ?? (() => undefined),
    record: (payload) => records.push(payload),
    settle: async (now, reason) => {
      state.settled = true;
      settles.push({ now, reason });
    },
    abort,
    kill,
    isSettled: () => state.settled,
    isFinishing: () => state.finishing,
    hasPendingSteer: () => steer.length > 0,
    pushSteer: (text) => steer.push(text),
  };

  return {
    sup: new GuardrailSupervisor(deps, turn),
    appended,
    settles,
    records,
    abort,
    kill,
    steer,
    state,
    progressTrace,
  };
}

describe('GuardrailSupervisor spend (issue #128)', () => {
  it('trips at the token cap', async () => {
    const h = makeSupervisor({ config: budgetSnapshot({ tokens: 100 }), snapshot: snapshotWithTokens(150) });
    await h.sup.prime();
    await h.sup.evaluateSpend();

    expect(h.appended).toHaveLength(1);
    expect(h.appended[0]!.event).toMatchObject({ dimension: 'tokens', limitValue: 100, observedValue: 150, configSource: 'default' });
    expect(h.settles).toHaveLength(1);
    expect(h.abort).toHaveBeenCalledTimes(1);
    expect(h.kill).toHaveBeenCalledTimes(1);
    expect(h.records).toContainEqual({ event: 'guardrail-tripped', dimension: 'tokens', reason: expect.any(String) });
  });

  it('does not trip below the token cap', async () => {
    const h = makeSupervisor({ config: budgetSnapshot({ tokens: 100 }), snapshot: snapshotWithTokens(40) });
    await h.sup.prime();
    await h.sup.evaluateSpend();

    expect(h.appended).toHaveLength(0);
    expect(h.settles).toHaveLength(0);
    expect(h.abort).not.toHaveBeenCalled();
  });

  it('attributes the trip to a workspace override when one is set', async () => {
    const h = makeSupervisor({
      config: budgetSnapshot({ tokens: 100 }),
      snapshot: snapshotWithTokens(150),
      workspace: { guardrailBudget: '{"tokens":100}' },
    });
    await h.sup.prime();
    await h.sup.evaluateSpend();

    expect(h.appended[0]!.event.configSource).toBe('workspace');
  });

  it('holds an unmeasurable cap through the grace window, then trips', async () => {
    // A configured token cap with no usage feed → unmeasurable, not "ok". Grace
    // window 0 so the first fire past grace trips.
    const h = makeSupervisor({ config: budgetSnapshot({ tokens: 100 }), snapshot: null, spendGraceMs: 0 });
    await h.sup.prime();

    await h.sup.evaluateSpend();
    expect(h.appended).toHaveLength(1);
    expect(h.appended[0]!.event).toMatchObject({ dimension: 'tokens', observedValue: 0, payload: { unmeasurable: true } });
  });

  it('short-circuits once the turn is already settled', async () => {
    const h = makeSupervisor({ config: budgetSnapshot({ tokens: 100 }), snapshot: snapshotWithTokens(150) });
    await h.sup.prime();
    h.state.settled = true; // an operator/other guardrail already claimed the settle
    await h.sup.evaluateSpend();

    expect(h.appended).toHaveLength(0);
    expect(h.settles).toHaveLength(0);
  });
});

describe('GuardrailSupervisor wall-clock (issue #127)', () => {
  it('trips once the execution clock passes the budget', async () => {
    const h = makeSupervisor({
      config: budgetSnapshot({}), // 45m budget
      startedAt: Date.now() - 46 * 60_000,
      stepType: 'implementation' as StepType,
    });
    await h.sup.prime();
    await h.sup.evaluateWallClock();

    expect(h.appended).toHaveLength(1);
    expect(h.appended[0]!.event.dimension).toBe('wall-clock');
    expect(h.settles).toHaveLength(1);
    expect(h.abort).toHaveBeenCalledTimes(1);
    expect(h.kill).toHaveBeenCalledTimes(1);
  });

  it('does not trip when no counted Step is running (Attempt has reached merging)', async () => {
    const h = makeSupervisor({
      config: budgetSnapshot({}),
      startedAt: Date.now() - 46 * 60_000,
      stepType: null,
    });
    await h.sup.prime();
    await h.sup.evaluateWallClock();

    expect(h.appended).toHaveLength(0);
    expect(h.settles).toHaveLength(0);
  });
});

describe('GuardrailSupervisor tool-timeout (issue #131)', () => {
  it('trips on the oldest outstanding tool call past the bound', async () => {
    const h = makeSupervisor({
      config: { ...budgetSnapshot({}), progress: true, toolTimeoutMinutes: 0.001 }, // 60ms bound
      stepType: 'implementation' as StepType,
    });
    await h.sup.prime();
    // Open a tool call, then let it age past the tiny bound.
    h.sup.observeTool({ sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'Run tests' });
    await new Promise((r) => setTimeout(r, 80));
    await h.sup.evaluateToolTimeout();

    expect(h.appended).toHaveLength(1);
    expect(h.appended[0]!.event.dimension).toBe('tool-timeout');
    expect(h.settles).toHaveLength(1);
    expect(h.abort).toHaveBeenCalledTimes(1);
    expect(h.kill).toHaveBeenCalledTimes(1);
  });

  it('does not track tools when the progress guardrail is off', async () => {
    const h = makeSupervisor({ config: budgetSnapshot({}), stepType: 'implementation' as StepType });
    await h.sup.prime();
    h.sup.observeTool({ sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'Run tests' });
    await new Promise((r) => setTimeout(r, 10));
    await h.sup.evaluateToolTimeout();

    expect(h.appended).toHaveLength(0);
  });
});

describe('GuardrailSupervisor progress (issue #131)', () => {
  // 3 identical (action A -> result rA) pairs — a stall the detector flags.
  const stallTrace: ProgressEvent[] = [
    { seq: 1, kind: 'action', signature: 'A' },
    { seq: 2, kind: 'result', signature: 'rA' },
    { seq: 3, kind: 'action', signature: 'A' },
    { seq: 4, kind: 'result', signature: 'rA' },
    { seq: 5, kind: 'action', signature: 'A' },
    { seq: 6, kind: 'result', signature: 'rA' },
  ];

  it('nudges once on first stall, then trips once the nudge turn has run', async () => {
    const h = makeSupervisor({
      config: { ...budgetSnapshot({}), progress: true },
      progressTrace: [...stallTrace],
    });
    await h.sup.prime();

    // First boundary: nudge, do not trip.
    expect(await h.sup.checkProgressAtBoundary()).toBe(false);
    expect(h.steer).toEqual([PROGRESS_NUDGE_TEXT]);
    expect(h.records).toContainEqual({ event: 'progress-nudge', pattern: expect.any(String) });
    expect(h.appended).toHaveLength(0);

    // The nudge is still queued (turn not yet run) → still no trip.
    expect(await h.sup.checkProgressAtBoundary()).toBe(false);
    expect(h.appended).toHaveLength(0);

    // Nudge delivered (drained) and its turn ran → trip.
    h.steer.length = 0;
    expect(await h.sup.checkProgressAtBoundary()).toBe(true);
    expect(h.appended).toHaveLength(1);
    expect(h.appended[0]!.event.dimension).toBe('progress');
    expect(h.settles).toHaveLength(1);
  });

  it('does not evaluate when the agent has signalled finish/escalate', async () => {
    const h = makeSupervisor({ config: { ...budgetSnapshot({}), progress: true }, progressTrace: [...stallTrace] });
    await h.sup.prime();
    h.state.finishing = true;
    expect(await h.sup.checkProgressAtBoundary()).toBe(false);
    expect(h.steer).toHaveLength(0);
  });

  it('is a no-op when the progress guardrail is disabled', async () => {
    const h = makeSupervisor({ config: budgetSnapshot({}), progressTrace: [...stallTrace] });
    await h.sup.prime();
    expect(await h.sup.checkProgressAtBoundary()).toBe(false);
    expect(h.steer).toHaveLength(0);
  });
});
