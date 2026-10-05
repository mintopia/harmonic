import { baselineConfig } from '../src/config.js';
import { describe, expect, it, vi } from 'vitest';
import { deliverAgentMessage, type AgentMessageRunner } from '../src/execution/agent-message-delivery.js';
import type { AgentMessageStore } from '../src/domain/agent-messages.js';
import type { AgentMessageRecipient, AgentMessageRow } from '../src/db/schema.js';

const DEFAULT_PROMPT_FRAGMENTS = baselineConfig().promptFragments;

describe('deliverAgentMessage — a next-turn steer dropped when the run ends', () => {
  it('returns the queued receipt to held so it is redelivered later', async () => {
    const receipts: Partial<AgentMessageRecipient>[] = [];
    const store = { updateRecipient: vi.fn(async (_m: string, _t: number, patch: Partial<AgentMessageRecipient>) => void receipts.push(patch)) };
    let drop: (() => void) | undefined;
    const pending: Array<Promise<unknown>> = [];
    const runner: AgentMessageRunner = {
      hasLiveAgent: () => true,
      trackBackground: (op) => void pending.push(op()),
      runControl: {
        steerWithMode: async (_t, _text, _onDelivered, onDropped) => {
          drop = onDropped;
          return 'next-turn';
        },
      },
    };
    const row = { id: 'm1', senderTaskId: 1, recipients: [{ taskId: 2, receipt: 'held' }], parts: [{ text: 'hi' }] } as unknown as AgentMessageRow;

    await deliverAgentMessage({ store: store as unknown as AgentMessageStore, runner, fragments: { ...DEFAULT_PROMPT_FRAGMENTS } }, row, { id: 1, harness: 'claude' });
    expect(receipts.at(-1)).toMatchObject({ receipt: 'queued' });

    drop!();
    await Promise.all(pending);
    expect(receipts.at(-1)).toMatchObject({ receipt: 'held' });
  });
});
