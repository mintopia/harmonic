import { describe, expect, it, vi } from 'vitest';
import { TurnCompletion, type TurnCompletionDeps } from '../src/execution/turn-completion.js';
import type { ActiveRun } from '../src/execution/active-runs.js';
import type { AcpDriver } from '../src/acp/driver.js';
import type { GuardrailSupervisor } from '../src/execution/guardrail-supervisor.js';
import type { TurnListeners } from '../src/execution/turn-listeners.js';

const completion = new TurnCompletion({
  attempts: { measureAgentTurn: async (_id: number, turn: () => Promise<unknown>) => turn() },
} as unknown as TurnCompletionDeps);

function setup(over: Record<string, unknown> = {}, progressStop = false) {
  const active = {
    attemptId: 1, pauseRequested: false, externallySettled: false, escalateReason: null,
    idle: false, steerable: false, steerQueue: [], ...over,
  } as unknown as ActiveRun;
  const prompt = vi.fn(async () => ({ stopReason: 'end_turn' }));
  const driver = { prompt } as unknown as AcpDriver;
  const checkProgressAtBoundary = vi.fn(async () => progressStop);
  const guardrails = { checkProgressAtBoundary } as unknown as GuardrailSupervisor;
  const listeners = { stoppedShort: null } as unknown as TurnListeners;
  const record = vi.fn();
  const go = () => completion.drivePromptCycle({ driver, active, guardrails, listeners, promptText: 'p', record });
  return { active, prompt, checkProgressAtBoundary, go, record };
}

const steer = (text: string) => ({ text, onDelivered: vi.fn() });

describe('TurnCompletion.drivePromptCycle boundary', () => {
  it('escalates with the agent reason and sends no steer', async () => {
    const s = steer('later');
    const t = setup({ escalateReason: 'stuck', steerQueue: [s] });
    const out = await t.go();
    expect(out.escalating).toBe('the agent asked for a human: stuck');
    expect(t.prompt).toHaveBeenCalledTimes(1);
    expect(t.checkProgressAtBoundary).not.toHaveBeenCalled();
    expect(s.onDelivered).not.toHaveBeenCalled();
  });

  it('delivers a queued steer in the idle loop', async () => {
    const s = steer('more');
    const t = setup({ steerQueue: [s] });
    const out = await t.go();
    expect(t.prompt).toHaveBeenCalledTimes(2);
    expect(s.onDelivered).toHaveBeenCalledTimes(1);
    expect(t.record).toHaveBeenCalledWith('lifecycle', { event: 'steer_delivered', text: 'more' });
    expect(out.escalating).toBeNull();
    expect(t.active.idle).toBe(false);
    expect(t.active.steerable).toBe(false);
  });

  it('a guardrail stop skips the idle steer but the drain still delivers it', async () => {
    const s = steer('more');
    const t = setup({ steerQueue: [s] }, true);
    await t.go();
    expect(t.checkProgressAtBoundary).toHaveBeenCalledTimes(1);
    expect(t.prompt).toHaveBeenCalledTimes(2);
    expect(s.onDelivered).toHaveBeenCalledTimes(1);
  });

  it('an externally settled run delivers nothing further', async () => {
    const s = steer('more');
    const t = setup({ externallySettled: true, steerQueue: [s] });
    await t.go();
    expect(t.prompt).toHaveBeenCalledTimes(1);
    expect(s.onDelivered).not.toHaveBeenCalled();
  });

  it('a pause with an empty queue stops without consulting guardrails', async () => {
    const t = setup();
    t.prompt.mockImplementation(async () => {
      t.active.pauseRequested = true;
      return { stopReason: 'end_turn' };
    });
    await t.go();
    expect(t.checkProgressAtBoundary).not.toHaveBeenCalled();
  });
});
