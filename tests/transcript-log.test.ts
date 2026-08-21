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
});
