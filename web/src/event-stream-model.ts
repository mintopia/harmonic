/**
 * The shape EventStream/coalesceEvents need — deliberately minimal so both
 * a Task run's `RunEvent` (keyed by `runId`) and a Conversation's
 * `ConversationEvent` (keyed by `conversationId`) satisfy it structurally
 * without either importing the other's type.
 */
export interface StreamEvent {
  id: number;
  seq: number;
  ts: number;
  type: string;
  payload: any;
}

/**
 * A run's (or conversation turn's) event stream, prepared for rendering.
 * Streamed message and thought text arrives as many small `session_update`
 * chunks split at arbitrary byte boundaries; rendering each chunk as its
 * own block breaks words across lines. Coalescing folds consecutive chunks
 * of the same variant into one text item so `whitespace-pre-wrap` reflows
 * them as one utterance. Everything else stays one item per event.
 */
export type StreamItem<E extends StreamEvent = StreamEvent> =
  | { kind: 'text'; variant: 'message' | 'thought'; text: string; key: number }
  | { kind: 'event'; event: E; key: number };

const TEXT_VARIANT: Record<string, 'message' | 'thought'> = {
  agent_message_chunk: 'message',
  agent_thought_chunk: 'thought',
};

export function coalesceEvents<E extends StreamEvent>(events: E[]): StreamItem<E>[] {
  const items: StreamItem<E>[] = [];
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
