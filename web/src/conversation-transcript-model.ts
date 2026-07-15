// Explicit .js extension: this module is shared with the node-side test
// project, whose nodenext resolution requires it (Vite maps .js → .ts).
import type { ConversationEvent } from './types.js';

/**
 * One Turn of a Conversation transcript: the operator's `user_turn` event
 * (null only for stray agent events that precede any turn — not expected
 * in practice, but kept so segmentation never drops events) followed by
 * every agent event up to the next `user_turn`. Rendering segments on this
 * boundary keeps the transcript honest — no fake seamless mid-thought —
 * while still reusing EventStream per turn for the agent's own events.
 */
export interface TranscriptTurn {
  userTurn: ConversationEvent | null;
  agentEvents: ConversationEvent[];
}

export function segmentTranscript(events: ConversationEvent[]): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  let current: TranscriptTurn | null = null;
  for (const event of events) {
    if (event.type === 'user_turn') {
      current = { userTurn: event, agentEvents: [] };
      turns.push(current);
      continue;
    }
    if (!current) {
      current = { userTurn: null, agentEvents: [] };
      turns.push(current);
    }
    current.agentEvents.push(event);
  }
  return turns;
}
