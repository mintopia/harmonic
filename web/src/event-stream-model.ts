// Explicit .js extension: this module is shared with the node-side test
// project, whose nodenext resolution requires it (Vite maps .js → .ts).
import type { RunEvent } from './types.js';

/**
 * A run's event stream, prepared for rendering. Streamed message and
 * thought text arrives as many small `session_update` chunks split at
 * arbitrary byte boundaries; rendering each chunk as its own block breaks
 * words across lines. Coalescing folds consecutive chunks of the same
 * variant into one text item so `whitespace-pre-wrap` reflows them as one
 * utterance. Everything else stays one item per event.
 */
export type StreamItem =
  | { kind: 'text'; variant: 'message' | 'thought'; text: string; key: number }
  | { kind: 'event'; event: RunEvent; key: number };

const TEXT_VARIANT: Record<string, 'message' | 'thought'> = {
  agent_message_chunk: 'message',
  agent_thought_chunk: 'thought',
};

export function coalesceEvents(events: RunEvent[]): StreamItem[] {
  const items: StreamItem[] = [];
  for (const event of events) {
    const variant =
      event.type === 'session_update' ? TEXT_VARIANT[event.payload?.sessionUpdate] : undefined;
    if (variant) {
      const last = items[items.length - 1];
      const text = event.payload?.content?.text ?? '';
      if (last?.kind === 'text' && last.variant === variant) {
        last.text += text;
      } else {
        items.push({ kind: 'text', variant, text, key: event.id });
      }
      continue;
    }
    items.push({ kind: 'event', event, key: event.id });
  }
  return items;
}
