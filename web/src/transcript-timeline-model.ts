import type { RunLogEvent } from './types';

export interface TranscriptLane<E extends RunLogEvent = RunLogEvent> {
  id: string;
  label: string;
  events: E[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

function parentToolUseId(event: RunLogEvent): string | undefined {
  const metadata = record(record(event.payload._meta)?.claudeCode);
  const id = metadata?.parentToolUseId;
  return typeof id === 'string' ? id : undefined;
}

function spawnLabel(event: RunLogEvent): string | undefined {
  const payload = event.payload;
  if (payload.sessionUpdate !== 'tool_call' || typeof payload.toolCallId !== 'string') return undefined;

  const metadata = record(record(payload._meta)?.claudeCode);
  const type = metadata?.toolName ?? payload.kind;
  const name = payload.title;
  if (typeof type !== 'string' || (type !== 'Agent' && type !== 'Task')) return undefined;
  return typeof name === 'string' && name.trim() ? `${type}: ${name.trim()}` : type;
}

/**
 * Partitions a Claude Code transcript by the spawning Agent/Task call before
 * it reaches the renderer. Keeping the split ahead of coalescing prevents
 * adjacent chunks from different agents becoming one utterance.
 */
export function transcriptLanes<E extends RunLogEvent>(events: E[]): TranscriptLane<E>[] {
  const labels = new Map<string, string>();
  for (const event of events) {
    if (typeof event.payload.toolCallId === 'string') {
      const label = spawnLabel(event);
      if (label) labels.set(event.payload.toolCallId, label);
    }
  }

  const main: TranscriptLane<E> = { id: 'main', label: 'Main agent', events: [] };
  const children = new Map<string, TranscriptLane<E>>();
  for (const event of events) {
    const parentId = parentToolUseId(event);
    if (!parentId) {
      main.events.push(event);
      continue;
    }
    const lane = children.get(parentId) ?? {
      id: parentId,
      label: labels.get(parentId) ?? 'Subagent',
      events: [],
    };
    lane.events.push(event);
    children.set(parentId, lane);
  }
  return [main, ...children.values()];
}
