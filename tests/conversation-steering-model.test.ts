import { describe, expect, it } from 'vitest';
import { isTurnRunning } from '../web/src/conversation-steering-model.js';
import type { ConversationEvent } from '../web/src/types.js';

const evt = (id: number, type: ConversationEvent['type'], payload: any): ConversationEvent => ({
  id,
  conversationId: 1,
  seq: id,
  ts: id,
  type,
  payload,
});

const userTurn = (id: number, text: string) => evt(id, 'user_turn', { text });
const agentChunk = (id: number, text: string) =>
  evt(id, 'session_update', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
const finished = (id: number, stopReason?: string) => evt(id, 'lifecycle', { event: 'finished', stopReason });
const errored = (id: number) => evt(id, 'lifecycle', { event: 'error' });

describe('isTurnRunning', () => {
  it('is false with no turns at all', () => {
    expect(isTurnRunning([])).toBe(false);
  });

  it('is false for stray pre-turn events with no user_turn yet', () => {
    expect(isTurnRunning([evt(1, 'lifecycle', { event: 'connected' })])).toBe(false);
  });

  it('is true while the latest turn has no terminating lifecycle event yet', () => {
    const events = [userTurn(1, 'hello'), agentChunk(2, 'thinking…')];
    expect(isTurnRunning(events)).toBe(true);
  });

  it('is false once the latest turn finished normally', () => {
    const events = [userTurn(1, 'hello'), agentChunk(2, 'hi'), finished(3, 'end_turn')];
    expect(isTurnRunning(events)).toBe(false);
  });

  it('is false once the latest turn ended in error', () => {
    const events = [userTurn(1, 'hello'), agentChunk(2, 'hi'), errored(3)];
    expect(isTurnRunning(events)).toBe(false);
  });

  it('is false once the latest turn was cancelled', () => {
    const events = [userTurn(1, 'hello'), agentChunk(2, 'hi'), finished(3, 'cancelled')];
    expect(isTurnRunning(events)).toBe(false);
  });

  it('is true again once a second, queued turn starts after the first finished', () => {
    const events = [
      userTurn(1, 'first'),
      agentChunk(2, 'reply one'),
      finished(3, 'end_turn'),
      userTurn(4, 'second, queued while the first was running'),
    ];
    expect(isTurnRunning(events)).toBe(true);
  });
});
