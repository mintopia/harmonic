import { describe, expect, it } from 'vitest';
import { exportEvents } from '../src/execution/harness/opencode.js';

const created = (ms: number) => ({ role: 'assistant', time: { created: ms } });

describe('opencode export → transcript events', () => {
  it('maps assistant text, reasoning, tool calls and patches to session/update payloads', () => {
    const events = exportEvents({
      info: { id: 'ses_x' },
      messages: [
        { info: { role: 'user', time: { created: 1000 } }, parts: [{ type: 'text', text: 'the prompt' }] },
        {
          info: created(2000),
          parts: [
            { type: 'reasoning', text: 'thinking first' },
            { type: 'text', text: 'here is the plan' },
            { type: 'tool', tool: 'read', callID: 'call_1', state: { status: 'completed', input: { filePath: '/repo/a.ts' }, output: 'file body' } },
            { type: 'patch', id: 'prt_1', files: ['/repo/src/runner.ts', '/repo/src/x.ts'] },
          ],
        },
      ],
    });

    expect(events).toEqual([
      { id: 1, seq: 1, ts: 2000, type: 'session_update', payload: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking first' } } },
      { id: 2, seq: 2, ts: 2000, type: 'session_update', payload: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'here is the plan' } } },
      {
        id: 3,
        seq: 3,
        ts: 2000,
        type: 'session_update',
        payload: {
          sessionUpdate: 'tool_call',
          toolCallId: 'call_1',
          title: 'read /repo/a.ts',
          status: 'completed',
          _meta: { opencode: { toolName: 'read' } },
          content: [{ type: 'content', content: { type: 'text', text: 'file body' } }],
        },
      },
      {
        id: 4,
        seq: 4,
        ts: 2000,
        type: 'session_update',
        payload: {
          sessionUpdate: 'tool_call',
          toolCallId: 'prt_1',
          title: 'patch runner.ts, x.ts',
          status: 'completed',
          _meta: { opencode: { toolName: 'patch' } },
        },
      },
    ]);
  });

  it('skips user turns and empty/whitespace parts', () => {
    const events = exportEvents({
      messages: [
        { info: { role: 'user' }, parts: [{ type: 'text', text: 'ignored user turn' }] },
        { info: created(5), parts: [{ type: 'text', text: '   ' }, { type: 'text', text: 'kept' }] },
      ],
    });
    expect(events).toEqual([
      { id: 1, seq: 1, ts: 5, type: 'session_update', payload: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'kept' } } },
    ]);
  });

  it('marks failed tool calls and omits empty output', () => {
    const events = exportEvents({
      messages: [{ info: created(9), parts: [{ type: 'tool', tool: 'bash', callID: 'c1', state: { status: 'error', input: { command: 'ls' }, output: '' } }] }],
    });
    expect(events).toEqual([
      { id: 1, seq: 1, ts: 9, type: 'session_update', payload: { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'bash ls', status: 'failed', _meta: { opencode: { toolName: 'bash' } } } },
    ]);
  });

  it('returns nothing for malformed input', () => {
    expect(exportEvents(null)).toEqual([]);
    expect(exportEvents({})).toEqual([]);
    expect(exportEvents({ messages: 'nope' })).toEqual([]);
  });
});
