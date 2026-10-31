import { describe, expect, it, vi } from 'vitest';
import { TurnDriver, type TurnDriverDeps } from '../src/execution/turn-driver.js';
import { BaseBranchUnresolved, EpicBaseNotReady } from '../src/execution/merge-coordinator.js';
import type { AgentDriveRequest } from '../src/execution/workflow-engine.js';
import type { RunBoundaryResult } from '../src/execution/run-control.js';
import type { AttemptRow, TaskRow } from '../src/db/schema.js';

const task = { id: 7, harness: 'claude', workingDir: '/repo', continuationChoice: null } as unknown as TaskRow;
const run = { id: 3, number: 1, startedAt: 1, sessionId: null } as unknown as AttemptRow;
const req = { task, run, harness: {}, harnessId: 'claude', model: 'm', cwd: '/repo', prompt: 'go', timeoutMs: 1 } as unknown as AgentDriveRequest;

function driver(over: { boundary?: RunBoundaryResult; prepare?: () => Promise<never> } = {}) {
  const coordinateSettle = vi.fn(async () => {});
  const settleEscalated = vi.fn(async () => {});
  const record = vi.fn();
  const deps = {
    attempts: { ensureForRun: vi.fn(async () => run), listToolCalls: vi.fn(async () => new Map()) },
    activeRuns: {
      getToolCallTotals: () => undefined, setToolCallTotals: vi.fn(), getProgressTrace: () => undefined, setProgressTrace: vi.fn(),
    },
    autoDrive: undefined,
    checkRunBoundary: vi.fn(async () => over.boundary ?? { stop: false }),
    recordRunEvent: record,
    prepareWorkspace: over.prepare ?? vi.fn(),
    fireAndForget: vi.fn(),
    keys: undefined,
    coordinateSettle,
    settleEscalated,
  } as unknown as TurnDriverDeps;
  return { turnDriver: new TurnDriver(deps), coordinateSettle, settleEscalated, record };
}

describe('TurnDriver.runAgentTurn halts', () => {
  it('halts paused without spawning when the run boundary reports an operator pause', async () => {
    const d = driver({ boundary: { stop: true, reason: 'operator-pause', pauseReason: 'x' } });
    await expect(d.turnDriver.runAgentTurn(req)).resolves.toMatchObject({ halt: 'paused' });
    expect(d.record).toHaveBeenCalledWith(task, run, 'lifecycle', { event: 'paused' });
  });

  it('halts paused on a global pause', async () => {
    const d = driver({ boundary: { stop: true, reason: 'global-pause' } });
    await expect(d.turnDriver.runAgentTurn(req)).resolves.toMatchObject({ halt: 'paused' });
  });

  it('halts settled when the Task already settled', async () => {
    const d = driver({ boundary: { stop: true, reason: 'settled' } });
    await expect(d.turnDriver.runAgentTurn(req)).resolves.toMatchObject({ halt: 'settled' });
    expect(d.record).not.toHaveBeenCalled();
  });

  it('settles a not-ready Epic base as failed-to-ready and halts settled', async () => {
    const d = driver({ prepare: async () => { throw new EpicBaseNotReady('epic base not ready'); } });
    await expect(d.turnDriver.runAgentTurn(req)).resolves.toMatchObject({ halt: 'settled' });
    expect(d.coordinateSettle).toHaveBeenCalledWith(task, run, 'failed', { runState: 'failed', taskAction: 'ready', reason: 'epic base not ready' });
  });

  it('escalates an unresolved base branch and halts settled', async () => {
    const d = driver({ prepare: async () => { throw new BaseBranchUnresolved('no base'); } });
    await expect(d.turnDriver.runAgentTurn(req)).resolves.toMatchObject({ halt: 'settled' });
    expect(d.settleEscalated).toHaveBeenCalledWith(task, run, 'no base', {});
  });

  it('rethrows an unexpected workspace failure for the engine to record', async () => {
    const d = driver({ prepare: async () => { throw new Error('disk full'); } });
    await expect(d.turnDriver.runAgentTurn(req)).rejects.toThrow('disk full');
  });
});
