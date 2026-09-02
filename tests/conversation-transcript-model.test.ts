import { describe, expect, it } from 'vitest';
import { segmentTranscript } from '../web/src/conversation-transcript-model.js';
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

describe('segmentTranscript', () => {
  it('groups each user_turn with the agent events that follow it', () => {
    const turns = segmentTranscript([
      userTurn(1, 'hello'),
      agentChunk(2, 'hi'),
      agentChunk(3, ' there'),
    ]);
    expect(turns).toEqual([
      { userTurn: userTurn(1, 'hello'), agentEvents: [agentChunk(2, 'hi'), agentChunk(3, ' there')] },
    ]);
  });

  it('starts a new turn at every user_turn boundary', () => {
    const turns = segmentTranscript([
      userTurn(1, 'first'),
      agentChunk(2, 'reply one'),
      userTurn(3, 'second'),
      agentChunk(4, 'reply two'),
    ]);
    expect(turns.map((t) => (t.userTurn?.payload as { text?: string } | undefined)?.text)).toEqual(['first', 'second']);
    expect(turns[0]!.agentEvents).toEqual([agentChunk(2, 'reply one')]);
    expect(turns[1]!.agentEvents).toEqual([agentChunk(4, 'reply two')]);
  });

  it('gives a just-sent turn an empty agentEvents array while the agent has not replied yet', () => {
    const turns = segmentTranscript([userTurn(1, 'hello')]);
    expect(turns).toEqual([{ userTurn: userTurn(1, 'hello'), agentEvents: [] }]);
  });

  it('returns an empty transcript for no events', () => {
    expect(segmentTranscript([])).toEqual([]);
  });

  it('does not drop stray agent events preceding any user_turn', () => {
    const lifecycle = evt(1, 'lifecycle', { event: 'connected' });
    const turns = segmentTranscript([lifecycle, userTurn(2, 'hi')]);
    expect(turns).toEqual([
      { userTurn: null, agentEvents: [lifecycle] },
      { userTurn: userTurn(2, 'hi'), agentEvents: [] },
    ]);
  });
});
