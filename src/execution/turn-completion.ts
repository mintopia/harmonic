import { Git } from './git.js';
import { observedModelMismatch, type AttemptUsage } from './usage.js';
import { AcpDriver, AcpPromptTimeoutError, type PromptResult } from '../acp/driver.js';
import { AcpConnectionClosedError } from '../acp/connection.js';
import type { ActiveRun } from './active-runs.js';
import type { GuardrailSupervisor } from './guardrail-supervisor.js';
import type { TurnListeners } from './turn-listeners.js';
import type { TaskRow, AttemptRow } from '../db/schema.js';
import type { Workspace } from './runner.js';
import type { AttemptStore } from '../domain/attempts.js';
import type { StepArchiveWriter } from '../archive/task-archive.js';

export type RunEventRecorder = (type: 'permission_request' | 'lifecycle', payload: unknown) => void;

export interface TurnCompletionDeps {
  attempts: AttemptStore;
}

export class TurnCompletion {
  constructor(private readonly deps: TurnCompletionDeps) {}

  async drivePromptCycle(input: {
    driver: AcpDriver;
    active: ActiveRun;
    guardrails: GuardrailSupervisor;
    listeners: TurnListeners;
    promptText: string;
    /** An operator steer accepted before this turn existed, folded into `promptText`. */
    operatorSeed?: string | undefined;
    record: RunEventRecorder;
    /** Runs once, immediately before the turn's first prompt goes to the Harness. */
    onFirstPrompt?: (() => Promise<void>) | undefined;
  }): Promise<{ result: PromptResult; connectionGone: boolean; escalating: string | null; operatorSeedDelivered: boolean; promptSent: boolean }> {
    const { driver, active, guardrails, listeners, record } = input;
        let escalating: string | null = null;
    // A pause requested before this turn's first prompt: bail before promptText — including
    // input.operatorSeed — ever reaches the harness. The caller must put the seed back rather
    // than treat it as delivered (ADR-0005 §6).
    if (active.pauseRequested) return { result: {}, connectionGone: false, escalating: null, operatorSeedDelivered: false, promptSent: false };
    const timedPromptTurn = (text: string, lifecycle?: PromptLifecycle) => this.deps.attempts.measureAgentTurn(
      active.attemptId, () => promptTurn(driver, text, record, listeners.archive, lifecycle),
    );
    active.steerable = true;
    let connectionGone = false;
    if (input.operatorSeed !== undefined) record('lifecycle', { event: 'steer_delivered', text: input.operatorSeed });
    await input.onFirstPrompt?.();
    const first = await timedPromptTurn(input.promptText);
    connectionGone ||= first.connectionGone;
    let result: PromptResult = first.result ?? {};
    active.idle = true;
    for (; !escalating && !listeners.stoppedShort && !connectionGone; ) {
      if (active.externallySettled) break;
      if (active.pauseRequested && active.steerQueue.length === 0) break;
      if (active.escalateReason) {
        escalating = `the agent asked for a human: ${active.escalateReason}`;
        break;
      }
      if (await guardrails.checkProgressAtBoundary()) break;
      const steer = active.steerQueue.shift();
      if (steer !== undefined) {
        record('lifecycle', { event: 'steer_delivered', text: steer.text });
        steer.onDelivered?.();
        active.idle = false;
        const turn = await timedPromptTurn(steer.text);
        connectionGone ||= turn.connectionGone;
        if (turn.result) result = turn.result;
        active.idle = true;
        if (connectionGone) break;
        continue;
      }
      break;
    }
    active.idle = false;
    active.steerable = false;
    while (!connectionGone && !active.externallySettled && !escalating && !listeners.stoppedShort && active.steerQueue.length > 0) {
      const steer = active.steerQueue.shift()!;
      record('lifecycle', { event: 'steer_delivered', text: steer.text });
      steer.onDelivered?.();
      const turn = await timedPromptTurn(steer.text);
      connectionGone ||= turn.connectionGone;
      if (turn.result) result = turn.result;
    }
    return { result, connectionGone, escalating, operatorSeedDelivered: input.operatorSeed !== undefined, promptSent: true };
  }

  async stampVerifiedHead(input: { run: AttemptRow; workspace: Workspace }): Promise<void> {
    const { run, workspace } = input;
    const dirty = !workspace.startDirty && (await Git.isDirty(workspace.cwd).catch(() => false));
    const head = await Git.revParse(workspace.cwd, 'HEAD').catch(() => null);
    const hasOwnCommits = head
      ? workspace.baseRev
        ? (await Git.commitsAhead(workspace.cwd, workspace.baseRev, head)) > 0
        : true
      : false;
    if (head && (hasOwnCommits || dirty)) await this.deps.attempts.update(run.id, { verifiedHeadOid: head });
  }
}

/** A lifecycle event emitted when this prompt is sent, enriched with where its Resolved Prompt was archived. */
export type PromptLifecycle = { event: string; [key: string]: unknown };

export async function promptTurn(
  driver: AcpDriver,
  text: string,
  record: (type: 'permission_request' | 'lifecycle', payload: unknown) => void,
  archive?: StepArchiveWriter,
  lifecycle?: PromptLifecycle,
): Promise<{ result: PromptResult | null; connectionGone: boolean }> {
  if (archive) {
    record('lifecycle', { event: 'prompt_sent' });
    const index = archive.appendPrompt(text);
    if (lifecycle) {
      const promptIndex = await index;
      record('lifecycle', promptIndex != null ? { ...lifecycle, locator: archive.promptLocator, promptIndex } : lifecycle);
    }
  } else if (lifecycle) {
    record('lifecycle', lifecycle);
  }
  try {
    return { result: await driver.prompt([{ type: 'text', text }]), connectionGone: false };
  } catch (err) {
    if (err instanceof AcpPromptTimeoutError) {
      record('lifecycle', { event: 'turn-timeout', reason: err.message });
      return { result: null, connectionGone: false };
    }
    if (err instanceof AcpConnectionClosedError) {
      record('lifecycle', { event: 'turn-eof', reason: err.message });
      return { result: null, connectionGone: true };
    }
    throw err;
  }
}

export function noteModelMismatch(
  task: TaskRow,
  usage: AttemptUsage | null,
  record: (type: 'permission_request' | 'lifecycle', payload: unknown) => void,
): void {
  const observed = usage ? observedModelMismatch(task.model, usage.models) : null;
  if (observed) record('lifecycle', { event: 'model_mismatch', expected: task.model, observed });
}
