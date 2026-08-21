import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTranscriptLog } from '../src/execution/transcript-log.js';

describe('native transcript log parser', () => {
  it('reads Codex JSONL and keeps only the selected Run window', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'harmonic-codex-log-')), 'rollout.jsonl');
    writeFileSync(
      file,
      [
        JSON.stringify({ timestamp: '2026-08-21T10:00:00.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'earlier run' } }),
        JSON.stringify({ timestamp: '2026-08-21T10:01:00.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'selected run' }] } }),
      ].join('\n'),
    );

    await expect(
      readTranscriptLog({ harness: 'codex', path: file, startedAt: Date.parse('2026-08-21T10:00:30.000Z'), finishedAt: null }),
    ).resolves.toEqual({
      status: 'available',
      events: [
        {
          id: 1,
          seq: 1,
          ts: Date.parse('2026-08-21T10:01:00.000Z'),
          type: 'session_update',
          payload: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'selected run' } },
        },
      ],
    });
  });

  it('surfaces Codex reasoning summaries and tool calls, never encrypted reasoning', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'harmonic-codex-log-')), 'rollout.jsonl');
    writeFileSync(
      file,
      [
        JSON.stringify({ timestamp: '2026-08-21T10:01:00.000Z', type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'planning the edit' }], encrypted_content: 'gAAAopaque' } }),
        JSON.stringify({ timestamp: '2026-08-21T10:01:01.000Z', type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'call_a', name: 'exec', input: 'ls' } }),
        JSON.stringify({ timestamp: '2026-08-21T10:01:02.000Z', type: 'response_item', payload: { type: 'function_call', id: 'fc_1', name: 'send_message', namespace: 'collaboration', arguments: '{}' } }),
        JSON.stringify({ timestamp: '2026-08-21T10:01:03.000Z', type: 'response_item', payload: { type: 'reasoning', summary: [], encrypted_content: 'gAAAopaque' } }),
      ].join('\n'),
    );

    await expect(
      readTranscriptLog({ harness: 'codex', path: file, startedAt: Date.parse('2026-08-21T10:00:30.000Z'), finishedAt: null }),
    ).resolves.toEqual({
      status: 'available',
      events: [
        { id: 1, seq: 1, ts: Date.parse('2026-08-21T10:01:00.000Z'), type: 'session_update', payload: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'planning the edit' } } },
        { id: 2, seq: 2, ts: Date.parse('2026-08-21T10:01:01.000Z'), type: 'session_update', payload: { sessionUpdate: 'tool_call', toolCallId: 'call_a', title: 'exec', status: 'completed' } },
        { id: 3, seq: 3, ts: Date.parse('2026-08-21T10:01:02.000Z'), type: 'session_update', payload: { sessionUpdate: 'tool_call', toolCallId: 'fc_1', title: 'collaboration.send_message', status: 'completed' } },
      ],
    });
  });
});
