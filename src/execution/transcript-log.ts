import { open, readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
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

/** An operator steer message (Harmonic's own `steer_injected`/`steer_queued`
 * run-event, ADR-0031's "small structured fact") to interleave into a parsed
 * transcript so the operator's redirections show alongside the agent's turns. */
export interface OperatorMessage {
  ts: number;
  text: string;
  /** Queued for the next turn boundary vs injected mid-turn — informational. */
  queued: boolean;
}

/**
 * Merge operator steer messages into a parsed transcript, stable-sorted with
 * the harness events by timestamp and re-sequenced. The harness JSONL only
 * records the agent's side; the operator's messages live in Harmonic's run-event
 * log, so this is where the two rejoin for the transcript view. A steer renders
 * as its own `operator_message` row (see `web/event-stream-model.ts`).
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
    // Stable sort by ts: agent events keep their file order (their timestamps are
    // monotonic), and each steer slots in at the moment it was sent.
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

  const text = await readTail(input.path);
  if (text === null) return { status: 'unavailable' };

  const inWindow = (ts: number) => ts === 0 || (ts >= input.startedAt && (input.finishedAt === null || ts <= input.finishedAt));
  const events: TranscriptLogEvent[] = [];
  let recognized = false;
  let previousCodexEventMessage: string | null = null;
  await forEachYielding(text.split('\n'), (line) => {
    const entry = parseLine(line);
    if (entry === undefined) return;
    const codexEventMessage = input.harness === 'codex' ? codexEventMessageText(entry) : null;
    const codexResponseMessage = input.harness === 'codex' ? codexResponseMessageText(entry) : null;
    const duplicateCodexResponse = codexResponseMessage !== null && codexResponseMessage === previousCodexEventMessage;
    const parsed = input.harness === 'claude' ? claudeEvents(entry, events.length + 1) : input.harness === 'codex' ? codexEvents(entry, events.length + 1) : [];
    if (parsed.length > 0) recognized = true;
    for (const event of parsed) {
      if (!inWindow(event.ts)) continue;
      if (!duplicateCodexResponse) events.push(event);
    }
    const ts = timestamp(asRecord(entry)?.timestamp);
    previousCodexEventMessage = codexEventMessage !== null && inWindow(ts) ? codexEventMessage : null;
  });

  if (!recognized) return { status: 'unavailable' };

  if (input.harness === 'claude') {
    // Claude Code writes each spawned Subagent's transcript beside the root
    // session (`<sessionId>/subagents/agent-<id>.jsonl`, ADR 0009). Fold them
    // in tagged with the spawning tool call so the transcript view can lane
    // them apart from the main agent instead of interleaving foreign turns.
    for (const sub of await readClaudeSubagents(input.path)) {
      const subText = await readTail(sub.path);
      if (subText === null) continue;
      await forEachYielding(subText.split('\n'), (line) => {
        const entry = parseLine(line);
        if (entry === undefined) return;
        for (const event of claudeEvents(entry, events.length + 1, sub.parentToolUseId)) {
          if (inWindow(event.ts)) events.push(event);
        }
      });
    }
    // Stable by timestamp: each file is already in order, and a Subagent's
    // turns slot in at the moment they happened relative to the root.
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

/** Every Subagent transcript under a Claude root session, with the tool-call id
 * that spawned it (its `.meta.json` sidecar's `toolUseId`, falling back to the
 * agent id so an unlabelled Subagent still lanes on its own). */
async function readClaudeSubagents(rootPath: string): Promise<Array<{ path: string; parentToolUseId: string }>> {
  const dir = join(dirname(rootPath), basename(rootPath, '.jsonl'), 'subagents');
  let names: string[];
  try {
    names = (await readdir(dir, { recursive: true })) as string[];
  } catch {
    return [];
  }
  const found = new Map<string, { jsonl?: string; meta?: string }>();
  for (const rel of names) {
    const m = /^agent-(.+)\.(jsonl|meta\.json)$/.exec(basename(rel));
    if (!m) continue;
    const entry = found.get(m[1]!) ?? {};
    if (m[2] === 'jsonl') entry.jsonl = join(dir, rel);
    else entry.meta = join(dir, rel);
    found.set(m[1]!, entry);
  }
  const subs: Array<{ path: string; parentToolUseId: string }> = [];
  for (const [id, { jsonl, meta }] of found) {
    if (!jsonl) continue;
    let parentToolUseId = id;
    if (meta) {
      try {
        const parsed = asRecord(JSON.parse(await readFile(meta, 'utf8')));
        if (typeof parsed?.toolUseId === 'string') parentToolUseId = parsed.toolUseId;
      } catch {
        /* incomplete sidecar write mid-run: lane on the agent id */
      }
    }
    subs.push({ path: jsonl, parentToolUseId });
  }
  return subs;
}

function claudeEvents(entry: unknown, firstId: number, parentToolUseId?: string): TranscriptLogEvent[] {
  const record = asRecord(entry);
  const message = asRecord(record?.message);
  const content = message?.content;
  if (record?.type !== 'assistant' || !Array.isArray(content)) return [];
  const ts = timestamp(record?.timestamp);
  const lane = parentToolUseId ? { parentToolUseId } : {};
  const events: TranscriptLogEvent[] = [];
  for (const block of content) {
    const value = asRecord(block);
    if (!value) continue;
    const id = firstId + events.length;
    if (value.type === 'text' && typeof value.text === 'string') {
      events.push({ id, seq: id, ts, type: 'session_update', payload: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value.text }, ...(parentToolUseId ? { _meta: { claudeCode: lane } } : {}) } });
    } else if (value.type === 'thinking' && typeof value.thinking === 'string') {
      events.push({ id, seq: id, ts, type: 'session_update', payload: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: value.thinking }, ...(parentToolUseId ? { _meta: { claudeCode: lane } } : {}) } });
    } else if (value.type === 'tool_use' && typeof value.id === 'string') {
      const name = typeof value.name === 'string' ? value.name : 'Tool call';
      events.push({
        id,
        seq: id,
        ts,
        type: 'session_update',
        payload: { sessionUpdate: 'tool_call', toolCallId: value.id, title: withTarget(name, value.input), status: 'completed', _meta: { claudeCode: { toolName: name, ...lane } } },
      });
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

/** The transcript row shows a tool as `<verb> <target>` (event-stream-model
 * splits the title on the first space), so fold the tool's own argument — the
 * shell command it runs, the file it touches — into the title. Without it an
 * `exec` row is a bare verb with no hint of what actually ran. */
function withTarget(name: string, rawInput: unknown): string {
  const target = toolTarget(name, rawInput);
  return target ? `${name} ${target}` : name;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** Per-tool targets where the generic field scan would read nothing useful: a
 * bare `Skill` or `Agent` row tells the operator nothing about what ran. */
const TOOL_TARGETS: Record<string, (input: Record<string, unknown>) => string> = {
  Skill: (i) => [str(i.skill) && `/${str(i.skill)}`, str(i.args)].filter(Boolean).join(' '),
  Agent: (i) => [str(i.description) || str(i.prompt), str(i.subagent_type) && `(${str(i.subagent_type)})`].filter(Boolean).join(' '),
  Task: (i) => [str(i.description) || str(i.prompt), str(i.subagent_type) && `(${str(i.subagent_type)})`].filter(Boolean).join(' '),
  TodoWrite: (i) => (Array.isArray(i.todos) ? `${i.todos.length} todo${i.todos.length === 1 ? '' : 's'}` : ''),
  Grep: (i) => [str(i.pattern), str(i.path)].filter(Boolean).join(' in '),
  Glob: (i) => [str(i.pattern), str(i.path)].filter(Boolean).join(' in '),
  AskUserQuestion: (i) => {
    const first = Array.isArray(i.questions) ? asRecord(i.questions[0]) : null;
    return str(first?.question);
  },
};

const GENERIC_TARGET_KEYS = ['command', 'cmd', 'script', 'file_path', 'path', 'filename', 'pattern', 'query', 'url', 'skill', 'description', 'prompt', 'title', 'name', 'message', 'text', 'model'];

/** A concise one-line command/target from a tool's input, which arrives as an
 * object (Claude `tool_use`) or a JSON/plain string (Codex `input`/`arguments`). */
function toolTarget(name: string, raw: unknown): string {
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
  const specific = TOOL_TARGETS[name]?.(record);
  if (specific) return oneLine(specific);
  // A front-door MCP call (`order { action, args }`): the action plus its args.
  if (typeof record.action === 'string' && record.action) {
    const args = record.args !== undefined ? ` ${JSON.stringify(record.args)}` : '';
    return oneLine(`${record.action}${args}`);
  }
  for (const key of GENERIC_TARGET_KEYS) {
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
