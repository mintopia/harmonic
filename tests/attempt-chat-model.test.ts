import { describe, expect, it } from 'vitest';
import { chatRows } from '../web/src/attempt-chat-model.js';
import { coalesceEvents } from '../web/src/event-stream-model.js';
import type { AttemptLogEvent } from '../web/src/types.js';

const event = (id: number, sessionUpdate: string, payload: Record<string, unknown> = {}): AttemptLogEvent => ({
  id,
  seq: id,
  ts: id,
  type: 'session_update',
  payload: { sessionUpdate, ...payload },
});

const say = (id: number, text: string) => event(id, 'agent_message_chunk', { content: { type: 'text', text } });
const think = (id: number, text: string) => event(id, 'agent_thought_chunk', { content: { type: 'text', text } });
const operator = (id: number, text: string) => event(id, 'operator_message', { content: { type: 'text', text } });
const tool = (id: number, toolCallId: string, extra: Record<string, unknown>) =>
  event(id, 'tool_call', { toolCallId, ...extra });

const rows = (events: AttemptLogEvent[]) => chatRows(coalesceEvents(events));

describe('chatRows', () => {
  it('renders the agent as an assistant message and the operator steer as a You message, inline where it was sent', () => {
    const result = rows([
      say(1, 'Starting the change.'),
      operator(2, 'Also update the tests.'),
      say(3, 'Will do.'),
    ]);
    expect(result).toEqual([
      { kind: 'message', author: 'assistant', text: 'Starting the change.', at: 1, key: 1 },
      { kind: 'message', author: 'operator', text: 'Also update the tests.', at: 2, key: 2 },
      { kind: 'message', author: 'assistant', text: 'Will do.', at: 3, key: 3 },
    ]);
  });

  it('marks private reasoning as a thought row, distinct from a spoken message', () => {
    expect(rows([think(1, 'Let me consider the edge case.')])).toEqual([
      { kind: 'thought', text: 'Let me consider the edge case.', key: 1 },
    ]);
  });

  it('folds a tool call and its updates into one card whose status advances in place', () => {
    const result = rows([
      tool(1, 't1', { kind: 'read', title: 'Read src/app.ts', status: 'pending' }),
      tool(2, 't1', { status: 'completed' }),
    ]);
    expect(result).toEqual([
      { kind: 'tool', verb: 'Read', target: 'src/app.ts', status: 'ok', subagent: false, output: null, at: 1, key: 1 },
    ]);
  });

  it('keeps a bare-verb tool card with no target and flags a failed run', () => {
    const result = rows([tool(1, 't1', { kind: 'bash', title: 'Bash', status: 'failed' })]);
    expect(result).toEqual([{ kind: 'tool', verb: 'Bash', target: null, status: 'failed', subagent: false, output: null, at: 1, key: 1 }]);
  });

  it('flags a subagent tool call', () => {
    const result = rows([
      tool(1, 't1', { kind: 'read', title: 'Read x', status: 'completed', _meta: { claudeCode: { parentToolUseId: 'p' } } }),
    ]);
    expect(result[0]).toMatchObject({ kind: 'tool', subagent: true });
  });

  it('drops an empty-text bubble so a folded-to-nothing chunk leaves no blank message', () => {
    expect(rows([say(1, '   '), tool(2, 't1', { kind: 'read', title: 'Read x', status: 'completed' })])).toEqual([
      { kind: 'tool', verb: 'Read', target: 'x', status: 'ok', subagent: false, output: null, at: 2, key: 2 },
    ]);
  });

  it('surfaces a moving-base reconcile as a calm note', () => {
    const events: AttemptLogEvent[] = [
      { id: 1, seq: 1, ts: 1, type: 'lifecycle' as AttemptLogEvent['type'], payload: { sessionUpdate: 'lifecycle', event: 'moving-base' } },
    ];
    expect(chatRows(coalesceEvents(events))).toEqual([
      { kind: 'note', label: 'Reconciling', text: 'Reconciling with the latest base…', key: 1 },
    ]);
  });
});
