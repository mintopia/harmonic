import { describe, expect, it, vi } from 'vitest';
import { TurnDriver, type TurnDriverDeps } from '../src/execution/turn-driver.js';
import type { AgentDriveRequest } from '../src/execution/workflow-engine.js';
import type { RunBoundaryResult } from '../src/execution/run-control.js';
import type { AttemptRow, TaskRow } from '../src/db/schema.js';

const task = { id: 7, harness: 'claude', workingDir: '/repo', continuationChoice: null } as unknown as TaskRow;
const run = { id: 3, number: 1, startedAt: 1, sessionId: null } as unknown as AttemptRow;
const req = { task, run, harness: {}, harnessId: 'claude', model: 'm', cwd: '/repo', prompt: 'go', timeoutMs: 1 } as unknown as AgentDriveRequest;

interface Scenario {
  spawnedBoundary?: RunBoundaryResult;
  active?: Record<string, unknown>;
  driven?: Record<string, unknown> | Error;
  stoppedShort?: string | null;
  stderrTail?: string;
  operatorSeed?: string;
  shuttingDown?: boolean;
  taskState?: string;
}

function setup(s: Scenario = {}) {
  const order: string[] = [];
  const boundaries: RunBoundaryResult[] = [{ stop: false }, s.spawnedBoundary ?? { stop: false }];
  const active = { externallySettled: false, pauseRequested: false, pauseFactRecorded: false, pauseReason: null, globalPauseRequested: false, ...s.active };
  const finalize = vi.fn(async () => void order.push('finalize'));
  const driver = { sessionId: 'sess-1', fail: vi.fn(() => void order.push('driver.fail')), dispose: vi.fn(() => void order.push('driver.dispose')) };
  const guardrails = { disarm: vi.fn(() => void order.push('disarm')) };
  const listeners = { stoppedShort: s.stoppedShort ?? null };
  const record = vi.fn();
  const attemptEvents: unknown[] = [];
  const deps = {
    attempts: {
      ensureForRun: vi.fn(async () => run),
      listToolCalls: vi.fn(async () => new Map()),
      appendEvent: vi.fn(async (_id: number, e: unknown) => {
        attemptEvents.push(e);
        return e;
      }),
    },
    activeRuns: {
      getToolCallTotals: () => undefined, setToolCallTotals: vi.fn(), getProgressTrace: () => undefined, setProgressTrace: vi.fn(),
      setPendingOperatorSeed: vi.fn(), delete: vi.fn(() => void order.push('activeRuns.delete')),
    },
    taskService: { get: vi.fn(async () => ({ state: s.taskState ?? 'working' })), pause: vi.fn(async () => {}) },
    events: { onAttemptEvent: vi.fn() },
    autoDrive: undefined,
    agentMessages: undefined,
    checkRunBoundary: vi.fn(async () => boundaries.shift() ?? { stop: false }),
    recordRunEvent: record,
    isShuttingDown: () => s.shuttingDown ?? false,
    onGloballyPaused: vi.fn(async () => {}),
  } as unknown as TurnDriverDeps;
  const td = new TurnDriver(deps);
  const internals = td as unknown as Record<string, unknown>;
  internals.spawnTurn = vi.fn(async () => ({ ok: true, workspace: { cwd: '/repo' }, mcpServers: [], child: {}, stderr: { tail: s.stderrTail ?? '', flushed: Promise.resolve() } }));
  internals.createTurnRuntime = vi.fn(() => ({ active, driver, guardrails, listeners, finalize }));
  internals.initializeTurn = vi.fn(async () => ({ promptText: 'p', operatorSeed: s.operatorSeed, heldMessages: [] }));
  const recordTurnUsage = vi.fn(async () => void order.push('usage'));
  internals.recordTurnUsage = recordTurnUsage;
  const completion = internals.completion as Record<string, unknown>;
  const drive = vi.fn(async () => {
    if (s.driven instanceof Error) throw s.driven;
    return { result: { stopReason: 'end_turn' }, connectionGone: false, escalating: null, operatorSeedDelivered: true, promptSent: true, ...s.driven };
  });
  completion.drivePromptCycle = drive;
  const stampVerifiedHead = vi.fn(async () => void order.push('stamp'));
  completion.stampVerifiedHead = stampVerifiedHead;
  return { td, deps, active, driver, guardrails, finalize, record, order, attemptEvents, drive, recordTurnUsage, stampVerifiedHead };
}

describe('TurnDriver.runAgentTurn once the harness is up: run boundary', () => {
  it('records an operator pause with its reason, finalises and halts paused without prompting', async () => {
    const t = setup({ spawnedBoundary: { stop: true, reason: 'operator-pause', pauseReason: 'lunch' } });
    await expect(t.td.runAgentTurn(req)).resolves.toMatchObject({ halt: 'paused' });
    expect(t.attemptEvents).toEqual([{ type: 'lifecycle', payload: { event: 'paused', reason: 'lunch' } }]);
    expect(t.deps.events.onAttemptEvent).toHaveBeenCalledTimes(1);
    expect(t.drive).not.toHaveBeenCalled();
    expect(t.order.slice(0, 1)).toEqual(['finalize']);
  });

  it('names a global pause as such', async () => {
    const t = setup({ spawnedBoundary: { stop: true, reason: 'global-pause' } });
    await t.td.runAgentTurn(req);
    expect(t.attemptEvents).toEqual([{ type: 'lifecycle', payload: { event: 'paused', reason: 'global pause' } }]);
  });

  it('halts settled without a pause event when the Task already settled', async () => {
    const t = setup({ spawnedBoundary: { stop: true, reason: 'settled' } });
    await expect(t.td.runAgentTurn(req)).resolves.toMatchObject({ halt: 'settled' });
    expect(t.attemptEvents).toEqual([]);
    expect(t.finalize).toHaveBeenCalled();
  });

  it('always tears the run down: disarm, fail and dispose the driver, drop the active run', async () => {
    const t = setup({ spawnedBoundary: { stop: true, reason: 'settled' } });
    await t.td.runAgentTurn(req);
    expect(t.order.filter((o) => o !== 'finalize')).toEqual(['disarm', 'driver.fail', 'driver.dispose', 'activeRuns.delete']);
    expect(t.order.at(-1)).toBe('finalize');
    expect(t.driver.fail).toHaveBeenCalledWith(new Error('run finished'));
  });
});

describe('TurnDriver.runAgentTurn paused during the turn', () => {
  it('puts an undelivered operator seed back, pauses a working Task, records usage and the pause, then halts paused', async () => {
    const t = setup({ active: { pauseRequested: true, pauseReason: 'operator asked' }, operatorSeed: 'seed', driven: { operatorSeedDelivered: false } });
    await expect(t.td.runAgentTurn(req)).resolves.toMatchObject({ halt: 'paused' });
    expect(t.deps.activeRuns.setPendingOperatorSeed).toHaveBeenCalledWith(7, 'seed');
    expect(t.deps.taskService.pause).toHaveBeenCalledWith(7);
    expect(t.recordTurnUsage).toHaveBeenCalledTimes(1);
    expect(t.record).toHaveBeenCalledWith(task, run, 'lifecycle', { event: 'finished', stopReason: 'end_turn' });
    expect(t.attemptEvents).toEqual([{ type: 'lifecycle', payload: { event: 'paused', reason: 'operator asked' } }]);
    expect(t.order.slice(0, 2)).toEqual(['usage', 'finalize']);
    expect(t.stampVerifiedHead).not.toHaveBeenCalled();
  });

  it('keeps a delivered seed, leaves a non-working Task alone, and skips the pause event when already recorded', async () => {
    const t = setup({ active: { pauseRequested: true, pauseFactRecorded: true }, operatorSeed: 'seed', taskState: 'paused' });
    await t.td.runAgentTurn(req);
    expect(t.deps.activeRuns.setPendingOperatorSeed).not.toHaveBeenCalled();
    expect(t.deps.taskService.pause).not.toHaveBeenCalled();
    expect(t.attemptEvents).toEqual([]);
  });

  it('defaults the pause reason and notifies a global pause after finalising', async () => {
    const t = setup({ active: { pauseRequested: true, globalPauseRequested: true } });
    await t.td.runAgentTurn(req);
    expect(t.attemptEvents).toEqual([{ type: 'lifecycle', payload: { event: 'paused', reason: 'operator request' } }]);
    expect(t.deps.onGloballyPaused).toHaveBeenCalledWith(7);
  });

  it('halts settled, recording nothing, when the run was settled externally mid-turn', async () => {
    const t = setup({ active: { externallySettled: true, pauseRequested: true } });
    await expect(t.td.runAgentTurn(req)).resolves.toMatchObject({ halt: 'settled' });
    expect(t.recordTurnUsage).not.toHaveBeenCalled();
    expect(t.record).not.toHaveBeenCalledWith(task, run, 'lifecycle', expect.objectContaining({ event: 'finished' }));
  });
});

describe('TurnDriver.runAgentTurn completed turn', () => {
  it('stamps the verified head, finalises, records usage and returns the drive result', async () => {
    const t = setup();
    const out = await t.td.runAgentTurn(req);
    expect(out).toEqual({ output: '', permissionRequests: [], sessionId: 'sess-1' });
    expect(t.order.slice(0, 3)).toEqual(['stamp', 'finalize', 'usage']);
    expect(t.record).toHaveBeenCalledWith(task, run, 'lifecycle', { event: 'finished', stopReason: 'end_turn' });
  });

  it('escalates without stamping the head', async () => {
    const t = setup({ driven: { escalating: 'need a human' } });
    const out = await t.td.runAgentTurn(req);
    expect(out).toMatchObject({ escalate: 'need a human', sessionId: 'sess-1' });
    expect(t.stampVerifiedHead).not.toHaveBeenCalled();
    expect(t.record).toHaveBeenCalledWith(task, run, 'lifecycle', { event: 'escalated', reason: 'need a human' });
    expect(t.recordTurnUsage).toHaveBeenCalledTimes(1);
  });

  it('records stopped-short and throws its reason without stamping the head', async () => {
    const t = setup({ stoppedShort: 'budget hit' });
    await expect(t.td.runAgentTurn(req)).rejects.toThrow('budget hit');
    expect(t.stampVerifiedHead).not.toHaveBeenCalled();
    expect(t.record).toHaveBeenCalledWith(task, run, 'lifecycle', { event: 'stopped-short', reason: 'budget hit' });
    expect(t.driver.dispose).toHaveBeenCalled();
  });
});

describe('TurnDriver.runAgentTurn failing', () => {
  it('rethrows the failure with the harness stderr tail appended', async () => {
    const t = setup({ driven: new Error('acp closed'), stderrTail: '  panic: oops\n' });
    await expect(t.td.runAgentTurn(req)).rejects.toThrow('acp closed\n\nharness stderr:\npanic: oops');
    expect(t.finalize).toHaveBeenCalled();
    expect(t.driver.dispose).toHaveBeenCalled();
    expect(t.deps.activeRuns.delete).toHaveBeenCalledWith(3);
  });

  it('rethrows the bare message when stderr is empty, wrapping non-Error throwables', async () => {
    const t = setup({ driven: new Error('acp closed') });
    await expect(t.td.runAgentTurn(req)).rejects.toThrow(/^acp closed$/);
    const thrown = setup();
    (thrown.drive as ReturnType<typeof vi.fn>).mockRejectedValue('plain string');
    await expect(thrown.td.runAgentTurn(req)).rejects.toThrow(/^plain string$/);
  });

  it('halts settled instead of throwing when the run was settled externally', async () => {
    const t = setup({ driven: new Error('killed'), active: { externallySettled: true } });
    await expect(t.td.runAgentTurn(req)).resolves.toMatchObject({ halt: 'settled' });
  });

  it('halts settled instead of throwing during shutdown', async () => {
    const t = setup({ driven: new Error('killed'), shuttingDown: true });
    await expect(t.td.runAgentTurn(req)).resolves.toMatchObject({ halt: 'settled' });
  });
});
