import { describe, expect, it, vi } from 'vitest';
import { promptTurn, TurnCompletion, type TurnCompletionDeps } from '../src/execution/turn-completion.js';
import type { ActiveRun } from '../src/execution/active-runs.js';
import type { AcpDriver } from '../src/acp/driver.js';
import type { GuardrailSupervisor } from '../src/execution/guardrail-supervisor.js';
import type { TurnListeners } from '../src/execution/turn-listeners.js';
import type { StepArchiveWriter } from '../src/archive/task-archive.js';
import type { TaskRow } from '../src/db/schema.js';

describe('prompt_sent markers line up with archived prompts', () => {
  it('emits one marker per prompt in a cycle (first, steer, continue) and one for the post-finish commit nudge', async () => {
    const log: string[] = [];
    const prompts: string[] = [];
    const archive = { appendPrompt: (text: string) => { prompts.push(text); log.push(`archived:${text}`); } } as unknown as StepArchiveWriter;
    const record = (_type: string, payload: unknown) => { log.push((payload as { event: string }).event); };
    const active = {
      attemptId: 1, taskId: 7, pauseRequested: false, externallySettled: false, escalateReason: null,
      agentFinished: false, idle: false, steerable: false, steerQueue: [] as { text: string }[],
    } as unknown as ActiveRun;
    let turns = 0;
    const driver = { prompt: vi.fn(async () => {
      if (++turns === 1) (active.steerQueue as { text: string }[]).push({ text: 'steer text' });
      return { stopReason: 'end_turn' };
    }) } as unknown as AcpDriver;
    const completion = new TurnCompletion({
      attempts: { measureAgentTurn: async (_id: number, turn: () => Promise<unknown>) => turn() },
      autoDrive: { continueAttempts: async () => 1, continuePrompt: async () => 'continue text' },
    } as unknown as TurnCompletionDeps);

    await completion.drivePromptCycle({
      task: { id: 7 } as TaskRow, driver, active,
      guardrails: { checkProgressAtBoundary: async () => false } as unknown as GuardrailSupervisor,
      listeners: { stoppedShort: null, archive } as unknown as TurnListeners,
      autoDriven: true, promptText: 'first text', record: record as never,
    });
    log.push('finished', 'commit-nudge');
    await promptTurn(driver, 'nudge text', record as never, archive);

    expect(prompts).toEqual(['first text', 'steer text', 'continue text', 'nudge text']);
    expect(log).toEqual([
      'prompt_sent', 'archived:first text',
      'steer_delivered', 'prompt_sent', 'archived:steer text',
      'continue', 'prompt_sent', 'archived:continue text',
      'finished', 'commit-nudge', 'prompt_sent', 'archived:nudge text',
    ]);
    expect(log.filter((entry) => entry === 'prompt_sent')).toHaveLength(prompts.length);
  });
});
