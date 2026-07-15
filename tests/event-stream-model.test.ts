import { describe, expect, it } from 'vitest';
import { coalesceEvents } from '../web/src/event-stream-model.js';
import type { RunEvent } from '../web/src/types.js';

const evt = (id: number, type: RunEvent['type'], payload: any): RunEvent => ({
  id,
  runId: 1,
  seq: id,
  ts: id,
  type,
  payload,
});

const chunk = (id: number, text: string, sessionUpdate = 'agent_message_chunk'): RunEvent =>
  evt(id, 'session_update', { sessionUpdate, content: { type: 'text', text } });

describe('coalesceEvents', () => {
  it('folds consecutive message chunks into one text item so words reflow', () => {
    // These are the exact byte-boundary splits that broke words mid-line.
    const items = coalesceEvents([chunk(1, 'I searched the de'), chunk(2, 'ferred tool list.')]);
    expect(items).toEqual([
      { kind: 'text', variant: 'message', text: 'I searched the deferred tool list.', key: 1 },
    ]);
  });

  it('does not merge message text with thought text', () => {
    const items = coalesceEvents([
      chunk(1, 'thinking', 'agent_thought_chunk'),
      chunk(2, 'answer'),
    ]);
    expect(items.map((i) => i.kind === 'text' && i.variant)).toEqual(['thought', 'message']);
  });

  it('splits a text run around a non-text event, keeping each side coalesced', () => {
    const tool = evt(3, 'session_update', { sessionUpdate: 'tool_call', title: 'Read', status: 'completed' });
    const items = coalesceEvents([chunk(1, 'before '), chunk(2, 'tool.'), tool, chunk(4, 'after '), chunk(5, 'tool.')]);
    expect(items).toEqual([
      { kind: 'text', variant: 'message', text: 'before tool.', key: 1 },
      { kind: 'event', event: tool, key: 3 },
      { kind: 'text', variant: 'message', text: 'after tool.', key: 4 },
    ]);
  });

  it('passes non-text events through untouched', () => {
    const perm = evt(1, 'permission_request', { request: {}, outcome: { outcome: 'selected' } });
    const items = coalesceEvents([perm]);
    expect(items).toEqual([{ kind: 'event', event: perm, key: 1 }]);
  });

  it('tolerates chunks with missing text', () => {
    const items = coalesceEvents([chunk(1, 'a'), evt(2, 'session_update', { sessionUpdate: 'agent_message_chunk' })]);
    expect(items).toEqual([{ kind: 'text', variant: 'message', text: 'a', key: 1 }]);
  });
});
