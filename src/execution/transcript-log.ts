import { open } from 'node:fs/promises';
import { forEachYielding } from '../reliability/yield.js';

const MAX_TRANSCRIPT_BYTES = 2 * 1024 * 1024;
const MAX_EVENTS = 2_000;

export interface TranscriptLogEvent {
  id: number;
  seq: number;
  ts: number;
  type: 'session_update';
  payload: Record<string, unknown>;
}

export type TranscriptLog = { status: 'available'; events: TranscriptLogEvent[] } | { status: 'unavailable' };

/**
 * Read the tail of a native transcript for the operator log. The cap matches
 * EventStream's render bound, and the yielding parser keeps a large live log
 * from monopolising Harmonic's single event loop.
 */
export async function readTranscriptLog(input: { harness: string; path: string | null; startedAt: number; finishedAt: number | null }): Promise<TranscriptLog> {
  if (!input.path) return { status: 'unavailable' };

  let text: string;
  try {
    const file = await open(input.path, 'r');
    try {
      const { size } = await file.stat();
      const bytes = Math.min(size, MAX_TRANSCRIPT_BYTES);
      const start = size - bytes;
      const data = Buffer.alloc(bytes);
      await file.read(data, 0, bytes, start);
      text = data.toString('utf8');
      // A bounded tail can begin halfway through a JSONL record; discard it.
      if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    } finally {
      await file.close();
    }
  } catch {
    return { status: 'unavailable' };
  }

  const events: TranscriptLogEvent[] = [];
  let recognized = false;
  const lines = text.split('\n');
  await forEachYielding(lines, (line) => {
    if (!line.trim()) return;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      return; // an incomplete final write is normal for a live JSONL file
    }
    const parsed = input.harness === 'claude' ? claudeEvents(entry, events.length + 1) : input.harness === 'codex' ? codexEvents(entry, events.length + 1) : [];
    if (parsed.length > 0) recognized = true;
    events.push(...parsed.filter((event) => event.ts === 0 || (event.ts >= input.startedAt && (input.finishedAt === null || event.ts <= input.finishedAt))));
  });

  if (!recognized) return { status: 'unavailable' };
  return { status: 'available', events: events.slice(-MAX_EVENTS) };
}

function claudeEvents(entry: unknown, firstId: number): TranscriptLogEvent[] {
  const record = asRecord(entry);
  const message = asRecord(record?.message);
  const content = message?.content;
  if (record?.type !== 'assistant' || !Array.isArray(content)) return [];
  const ts = timestamp(record?.timestamp);
  const events: TranscriptLogEvent[] = [];
  for (const block of content) {
    const value = asRecord(block);
    if (!value) continue;
    const id = firstId + events.length;
    if (value.type === 'text' && typeof value.text === 'string') {
      events.push({ id, seq: id, ts, type: 'session_update', payload: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value.text } } });
    } else if (value.type === 'thinking' && typeof value.thinking === 'string') {
      events.push({ id, seq: id, ts, type: 'session_update', payload: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: value.thinking } } });
    } else if (value.type === 'tool_use' && typeof value.id === 'string') {
      events.push({ id, seq: id, ts, type: 'session_update', payload: { sessionUpdate: 'tool_call', toolCallId: value.id, title: typeof value.name === 'string' ? value.name : 'Tool call', status: 'completed' } });
    }
  }
  return events;
}

function codexEvents(entry: unknown, firstId: number): TranscriptLogEvent[] {
  const record = asRecord(entry);
  const payload = asRecord(record?.payload);
  if (!record || !payload) return [];
  const ts = timestamp(record.timestamp);
  const message = record.type === 'response_item' && payload.type === 'message' && payload.role === 'assistant' ? contentText(payload.content) : record.type === 'event_msg' && payload.type === 'agent_message' ? contentText(payload.message) : null;
  return message === null ? [] : [{ id: firstId, seq: firstId, ts, type: 'session_update', payload: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: message } } }];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : null;
}

function timestamp(value: unknown): number {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? Date.parse(value) : 0;
}

function contentText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return null;
  const text = value
    .map((part) => {
      const block = asRecord(part);
      return block?.type === 'output_text' || block?.type === 'text' ? block.text : null;
    })
    .filter((part): part is string => typeof part === 'string')
    .join('');
  return text || null;
}
