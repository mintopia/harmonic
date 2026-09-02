import { open } from 'node:fs/promises';
import { forEachYielding } from '../reliability/yield.js';
import { adapterFor } from './harness/registry.js';
import type { TranscriptLogEvent } from './harness/transcript.js';

const MAX_TRANSCRIPT_BYTES = 2 * 1024 * 1024;
const MAX_EVENTS = 2_000;

export type { TranscriptLogEvent } from './harness/transcript.js';

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
  const transcript = adapterFor(input.harness).transcript;
  if (!transcript) return { status: 'unavailable' };

  const text = await readTail(input.path);
  if (text === null) return { status: 'unavailable' };

  const inWindow = (ts: number) => ts === 0 || (ts >= input.startedAt && (input.finishedAt === null || ts <= input.finishedAt));
  const events: TranscriptLogEvent[] = [];
  let recognized = false;
  let previousEntry: unknown = undefined;
  await forEachYielding(text.split('\n'), (line) => {
    const entry = parseLine(line);
    if (entry === undefined) return;
    const duplicateMessage = previousEntry !== undefined && transcript.isDuplicateMessage?.(entry, previousEntry) === true;
    const parsed = transcript.events(entry, events.length + 1);
    if (parsed.length > 0) recognized = true;
    for (const event of parsed) {
      if (!inWindow(event.ts)) continue;
      if (!duplicateMessage) events.push(event);
    }
    if (parsed.some((event) => inWindow(event.ts))) previousEntry = entry;
  });

  if (!recognized) return { status: 'unavailable' };

  if (transcript.subagents) {
    for (const sub of await transcript.subagents(input.path)) {
      const subText = await readTail(sub.path);
      if (subText === null) continue;
      await forEachYielding(subText.split('\n'), (line) => {
        const entry = parseLine(line);
        if (entry === undefined) return;
        for (const event of transcript.events(entry, events.length + 1, sub.parentToolUseId)) {
          if (inWindow(event.ts)) events.push(event);
        }
      });
    }
    events.sort((a, b) => a.ts - b.ts);
    events.forEach((event, i) => {
      event.id = i + 1;
      event.seq = i + 1;
    });
  }

  return { status: 'available', events: events.slice(-MAX_EVENTS) };
}

/** The bounded tail of a JSONL file; null when it cannot be read. */
async function readTail(path: string): Promise<string | null> {
  try {
    const file = await open(path, 'r');
    try {
      const { size } = await file.stat();
      const bytes = Math.min(size, MAX_TRANSCRIPT_BYTES);
      const start = size - bytes;
      const data = Buffer.alloc(bytes);
      await file.read(data, 0, bytes, start);
      const text = data.toString('utf8');
      // A bounded tail can begin halfway through a JSONL record; discard it.
      return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
    } finally {
      await file.close();
    }
  } catch {
    return null;
  }
}

/** One JSONL line parsed, or undefined for a blank line or an incomplete
 * final write (normal for a live file). */
function parseLine(line: string): unknown {
  if (!line.trim()) return undefined;
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}
