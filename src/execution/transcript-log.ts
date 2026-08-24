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
    for (const event of parsed) {
      if (event.ts !== 0 && (event.ts < input.startedAt || (input.finishedAt !== null && event.ts > input.finishedAt))) continue;
      // Codex logs one assistant message as BOTH an `event_msg` and a durable
      // `response_item`, so drop the identical back-to-back copy (it otherwise
      // coalesces into the message rendered twice).
      const text = messageChunkText(event);
      const prev = events[events.length - 1];
      if (text !== null && prev && messageChunkText(prev) === text) continue;
      events.push(event);
    }
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
      const name = typeof value.name === 'string' ? value.name : 'Tool call';
      events.push({ id, seq: id, ts, type: 'session_update', payload: { sessionUpdate: 'tool_call', toolCallId: value.id, title: withTarget(name, value.input), status: 'completed' } });
    }
  }
  return events;
}

function codexEvents(entry: unknown, firstId: number): TranscriptLogEvent[] {
  const record = asRecord(entry);
  const payload = asRecord(record?.payload);
  if (!record || !payload) return [];
  const ts = timestamp(record.timestamp);
  const events: TranscriptLogEvent[] = [];
  const push = (update: Record<string, unknown>) => {
    const id = firstId + events.length;
    events.push({ id, seq: id, ts, type: 'session_update', payload: update });
  };

  const message = record.type === 'response_item' && payload.type === 'message' && payload.role === 'assistant' ? contentText(payload.content) : record.type === 'event_msg' && payload.type === 'agent_message' ? contentText(payload.message) : null;
  if (message !== null) push({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: message } });

  // Reasoning summaries only ever carry plaintext in `summary`; `encrypted_content` is opaque and never surfaced.
  if (record.type === 'response_item' && payload.type === 'reasoning' && Array.isArray(payload.summary)) {
    for (const part of payload.summary) {
      const block = asRecord(part);
      const text = block && (block.type === 'summary_text' || block.type === 'text') ? block.text : null;
      if (typeof text === 'string' && text) push({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } });
    }
  }

  if (record.type === 'response_item' && (payload.type === 'custom_tool_call' || payload.type === 'function_call')) {
    const name = typeof payload.name === 'string' ? payload.name : 'Tool call';
    const qualified = typeof payload.namespace === 'string' && payload.namespace ? `${payload.namespace}.${name}` : name;
    const title = withTarget(qualified, payload.input ?? payload.arguments);
    const callId = typeof payload.call_id === 'string' ? payload.call_id : typeof payload.id === 'string' ? payload.id : qualified;
    push({ sessionUpdate: 'tool_call', toolCallId: callId, title, status: 'completed' });
  }

  return events;
}

/** The transcript row shows a tool as `<verb> <target>` (event-stream-model
 * splits the title on the first space), so fold the tool's own argument — the
 * shell command it runs, the file it touches — into the title. Without it an
 * `exec` row is a bare verb with no hint of what actually ran. */
function withTarget(name: string, rawInput: unknown): string {
  const target = toolTarget(rawInput);
  return target ? `${name} ${target}` : name;
}

/** A concise one-line command/target from a tool's input, which arrives as an
 * object (Claude `tool_use`) or a JSON/plain string (Codex `input`/`arguments`). */
function toolTarget(raw: unknown): string {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return '';
    try {
      value = JSON.parse(trimmed);
    } catch {
      return oneLine(trimmed);
    }
  }
  if (typeof value === 'string') return oneLine(value);
  const record = asRecord(value);
  if (!record) return '';
  for (const key of ['command', 'cmd', 'script', 'file_path', 'path', 'filename', 'pattern', 'query', 'url']) {
    const field = record[key];
    if (Array.isArray(field)) return oneLine(field.map(String).join(' '));
    if (typeof field === 'string' && field) return oneLine(field);
  }
  return '';
}

function oneLine(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > 240 ? `${collapsed.slice(0, 240)}…` : collapsed;
}

function messageChunkText(event: TranscriptLogEvent): string | null {
  const payload = event.payload as { sessionUpdate?: string; content?: { text?: unknown } } | null;
  return payload?.sessionUpdate === 'agent_message_chunk' && typeof payload.content?.text === 'string'
    ? payload.content.text
    : null;
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
