import type { AgentMessageRecipient, AgentMessageRow, TaskRow } from '../db/schema.js';
import type { AgentMessageStore } from '../domain/agent-messages.js';
import { messageText } from '../domain/agent-messages.js';
import { logger } from '../logger.js';
import type { FailureReport } from '../error-handling.js';
import type { RunControl } from './run-control.js';
import type { PromptFragments } from '../domain/prompt-fragments.js';
import { renderFragment } from './prompt-template.js';

export interface AgentMessageRunner {
  hasLiveAgent(taskId: number): boolean;
  trackBackground(op: () => Promise<unknown>, report: FailureReport): void;
  runControl: Pick<RunControl, 'steerWithMode'>;
}

const harnessLabel = (harness: string): string => harness.charAt(0).toUpperCase() + harness.slice(1);

/** Names the sending Task so the Agent never mistakes it for an operator instruction. */
export function peerFrame(sender: Pick<TaskRow, 'id' | 'harness'>, text: string, fragments: PromptFragments): string {
  return renderFragment('peerLiveMessage', fragments, { taskId: sender.id, harness: harnessLabel(sender.harness), text });
}

/** Held messages as a prompt section, in send order. */
export function peerMessagesSection(
  rows: readonly AgentMessageRow[],
  senderHarness: (taskId: number) => string,
  fragments: PromptFragments,
): string {
  const entries = rows.map((row) =>
    renderFragment('peerMessage', fragments, {
      taskId: row.senderTaskId,
      harness: harnessLabel(senderHarness(row.senderTaskId)),
      text: messageText(row),
    }),
  );
  return renderFragment('peerMessages', fragments, { messages: entries.join('\n\n') });
}

/** Delivers to each recipient and records its receipt; no steerable run means held. */
export async function deliverAgentMessage(
  deps: { store: AgentMessageStore; runner: AgentMessageRunner; fragments: PromptFragments },
  row: AgentMessageRow,
  sender: Pick<TaskRow, 'id' | 'harness'>,
): Promise<AgentMessageRecipient[]> {
  const text = peerFrame(sender, messageText(row), deps.fragments);
  const receipts: AgentMessageRecipient[] = [];
  for (const { taskId } of row.recipients) {
    let receipt: AgentMessageRecipient = { taskId, receipt: 'held' };
    let acked = false;
    let written: Promise<void> | undefined;
    const markDelivered = () => {
      acked = true;
      const ack = written;
      if (ack) deps.runner.trackBackground(() => ack.then(() => recordDelivered(deps.store, row.id, taskId)), { op: 'agentMessages.recordDelivered', level: 'warn', context: { taskId } });
    };
    let dropped = false;
    const markHeld = () => {
      dropped = true;
      const ack = written;
      if (ack) deps.runner.trackBackground(() => ack.then(() => recordHeld(deps.store, row.id, taskId)), { op: 'agentMessages.recordHeld', level: 'warn', context: { taskId } });
    };
    if (deps.runner.hasLiveAgent(taskId)) {
      const mode = await deps.runner.runControl.steerWithMode(taskId, text, markDelivered, markHeld).catch((err: unknown) => {
        logger.warn('Agent Message live delivery failed; holding', { messageId: row.id, taskId, err: String(err) });
        return null;
      });
      if (mode === 'mid-turn') receipt = { taskId, receipt: 'delivered', mode, deliveredAt: Date.now() };
      else if (mode === 'next-turn') receipt = { taskId, receipt: acked ? 'delivered' : 'queued', mode, ...(acked ? { deliveredAt: Date.now() } : {}) };
    }
    const { taskId: _id, ...patch } = receipt;
    written = deps.store.updateRecipient(row.id, taskId, patch);
    await written;
    if (dropped && !acked) await recordHeld(deps.store, row.id, taskId);
    receipts.push(receipt);
  }
  return receipts;
}

async function recordDelivered(store: AgentMessageStore, messageId: string, taskId: number): Promise<void> {
  try {
    await store.updateRecipient(messageId, taskId, { receipt: 'delivered', deliveredAt: Date.now() });
  } catch (err) {
    logger.warn('Agent Message receipt update failed', { messageId, taskId, err: String(err) });
  }
}

async function recordHeld(store: AgentMessageStore, messageId: string, taskId: number): Promise<void> {
  try {
    await store.updateRecipient(messageId, taskId, { receipt: 'held' });
  } catch (err) {
    logger.warn('Agent Message receipt reset failed', { messageId, taskId, err: String(err) });
  }
}
