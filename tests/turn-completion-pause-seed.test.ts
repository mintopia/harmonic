import { describe, expect, it, vi } from 'vitest';
import { TurnCompletion, type TurnCompletionDeps } from '../src/execution/turn-completion.js';
import type { ActiveRun } from '../src/execution/active-runs.js';
import type { AcpDriver } from '../src/acp/driver.js';
import type { GuardrailSupervisor } from '../src/execution/guardrail-supervisor.js';
import type { TurnListeners } from '../src/execution/turn-listeners.js';
import type { TaskRow } from '../src/db/schema.js';

function baseActive(over: Partial<ActiveRun> = {}): ActiveRun {
  return {
    attemptId: 1,
    taskId: 7,
    pauseRequested: false,
    externallySettled: false,
    escalateReason: null,
    agentFinished: false,
    idle: false,
    steerable: false,
    steerQueue: [],
    steerAcks: new Map(),
    ...over,
  } as unknown as ActiveRun;
}

describe('TurnCompletion.drivePromptCycle — a pause requested before the first prompt', () => {
  const task = { id: 7 } as TaskRow;
  const measureAgentTurn = vi.fn(async (_id: number, turn: () => Promise<unknown>) => turn());
  const completion = new TurnCompletion({ attempts: { measureAgentTurn } } as unknown as TurnCompletionDeps);

  it('bails before sending the prompt and reports the seed as undelivered', async () => {
    const active = baseActive({ pauseRequested: true });
    const driver = { prompt: vi.fn() } as unknown as AcpDriver;
    const record = vi.fn();

    const result = await completion.drivePromptCycle({
      task,
      driver,
      active,
      guardrails: {} as unknown as GuardrailSupervisor,
      listeners: {} as unknown as TurnListeners,
      autoDriven: false,
      promptText: 'do the ticket',
      operatorSeed: 'urgent: stop touching the migrations',
      record,
    });

    expect(result.operatorSeedDelivered).toBe(false);
    expect(driver.prompt).not.toHaveBeenCalled();
    expect(measureAgentTurn).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalledWith('lifecycle', expect.objectContaining({ event: 'steer_delivered' }));
  });

  it('delivers the seed and reports it delivered when nothing pre-empts the first prompt', async () => {
    const active = baseActive();
    measureAgentTurn.mockClear();
    const driver = { prompt: vi.fn(async () => ({ stopReason: 'end_turn' })) } as unknown as AcpDriver;
    const guardrails = { checkProgressAtBoundary: vi.fn(async () => false) } as unknown as GuardrailSupervisor;
    const listeners = { stoppedShort: null } as unknown as TurnListeners;
    const record = vi.fn();

    const result = await completion.drivePromptCycle({
      task,
      driver,
      active,
      guardrails,
      listeners,
      autoDriven: false,
      promptText: 'do the ticket\n\n## Operator message\n\nurgent: stop touching the migrations',
      operatorSeed: 'urgent: stop touching the migrations',
      record,
    });

    expect(result.operatorSeedDelivered).toBe(true);
    expect(driver.prompt).toHaveBeenCalledTimes(1);
    expect(measureAgentTurn).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith('lifecycle', {
      event: 'steer_delivered',
      text: 'urgent: stop touching the migrations',
    });
  });

  it('measures queued follow-up prompts separately on the same Attempt', async () => {
    measureAgentTurn.mockClear();
    const active = baseActive();
    let turns = 0;
    const driver = { prompt: vi.fn(async () => {
      if (++turns === 1) active.steerQueue.push('follow up');
      return { stopReason: 'end_turn' };
    }) } as unknown as AcpDriver;
    const guardrails = { checkProgressAtBoundary: vi.fn(async () => false) } as unknown as GuardrailSupervisor;
    const listeners = { stoppedShort: null } as unknown as TurnListeners;

    await completion.drivePromptCycle({
      task, driver, active, guardrails, listeners, autoDriven: false,
      promptText: 'first turn', record: vi.fn(),
    });

    expect(driver.prompt).toHaveBeenCalledTimes(2);
    expect(measureAgentTurn).toHaveBeenCalledTimes(2);
    expect(measureAgentTurn.mock.calls.map(([id]) => id)).toEqual([1, 1]);
  });
});
