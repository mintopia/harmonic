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

/** An operator steer message to interleave into a parsed transcript so the
 * operator's redirections show alongside the agent's turns. */
export interface OperatorMessage {
  ts: number;
  text: string;
  /** Queued for the next turn boundary vs injected mid-turn — informational. */
  queued: boolean;
}

/**
 * Merge operator steer messages into a parsed transcript, stable-sorted with
 * the harness events by timestamp and re-sequenced. A steer renders as its own
 * `operator_message` row.
 */
export function withOperatorMessages(events: TranscriptLogEvent[], operator: OperatorMessage[]): TranscriptLogEvent[] {
  if (operator.length === 0) return events;
  const merged: TranscriptLogEvent[] = [
    ...events,
    ...operator.map((m) => ({
      id: 0,
      seq: 0,
      ts: m.ts,
      type: 'session_update' as const,
      payload: { sessionUpdate: 'operator_message', queued: m.queued, content: { type: 'text', text: m.text } },
    })),
  ]
    .sort((a, b) => a.ts - b.ts);
  return merged.map((e, i) => ({ ...e, id: i + 1, seq: i + 1 }));
}

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
      if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    } finally {
      await file.close();
    }
  } catch {
    return { status: 'unavailable' };
  }

  const events: TranscriptLogEvent[] = [];
  let recognized = false;
  let previousCodexEventMessage: string | null = null;
  const lines = text.split('\n');
  await forEachYielding(lines, (line) => {
    if (!line.trim()) return;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      return;
    }
    const codexEventMessage = input.harness === 'codex' ? codexEventMessageText(entry) : null;
    const codexResponseMessage = input.harness === 'codex' ? codexResponseMessageText(entry) : null;
    const duplicateCodexResponse = codexResponseMessage !== null && codexResponseMessage === previousCodexEventMessage;
    const parsed = input.harness === 'claude' ? claudeEvents(entry, events.length + 1) : input.harness === 'codex' ? codexEvents(entry, events.length + 1) : [];
    if (parsed.length > 0) recognized = true;
    for (const event of parsed) {
      if (event.ts !== 0 && (event.ts < input.startedAt || (input.finishedAt !== null && event.ts > input.finishedAt))) continue;
      if (!duplicateCodexResponse) events.push(event);
    }
    const ts = timestamp(asRecord(entry)?.timestamp);
    const eventInRunWindow = ts === 0 || (ts >= input.startedAt && (input.finishedAt === null || ts <= input.finishedAt));
    previousCodexEventMessage = codexEventMessage !== null && eventInRunWindow ? codexEventMessage : null;
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

  const message = codexResponseMessageText(entry) ?? codexEventMessageText(entry);
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

function withTarget(name: string, rawInput: unknown): string {
  const target = toolTarget(rawInput);
  return target ? `${name} ${target}` : name;
}

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

function codexEventMessageText(entry: unknown): string | null {
  const record = asRecord(entry);
  const payload = asRecord(record?.payload);
  return record?.type === 'event_msg' && payload?.type === 'agent_message' ? contentText(payload.message) : null;
}

function codexResponseMessageText(entry: unknown): string | null {
  const record = asRecord(entry);
  const payload = asRecord(record?.payload);
  return record?.type === 'response_item' && payload?.type === 'message' && payload.role === 'assistant' ? contentText(payload.content) : null;
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
