// Explicit .js extension: this module is shared with the node-side test
// project, whose nodenext resolution requires it (Vite maps .js → .ts) —
// see conversation-transcript-model.ts's note.
import type { ConversationEvent } from './types.js';

/**
 * Whether the Conversation's latest Turn is still in flight (issue #14):
 * true when the most recent `user_turn` has no subsequent `lifecycle` event
 * whose `payload.event` is `'finished'` or `'error'` — those are the two
 * ways a Turn concludes. Turns are strictly sequential (the server only
 * starts the next one once the current one merges one of those lifecycle
 * events, queuing anything sent meanwhile), so "the latest user_turn is
 * unterminated" is an unambiguous definition of "a Turn is running" with no
 * need to track Turn boundaries any more explicitly than
 * conversation-transcript-model.ts already does for rendering.
 *
 * No `user_turn` at all (a fresh conversation, or the pre-turn stray events
 * conversation-transcript-model.ts tolerates) means no Turn has started, so
 * this returns false.
 */
export function isTurnRunning(events: ConversationEvent[]): boolean {
  let latestUserTurnIndex = -1;
  for (let i = 0; i < events.length; i++) {
    if (events[i]!.type === 'user_turn') latestUserTurnIndex = i;
  }
  if (latestUserTurnIndex === -1) return false;

  for (let i = latestUserTurnIndex + 1; i < events.length; i++) {
    const event = events[i]!;
    if (event.type === 'lifecycle' && (event.payload?.event === 'finished' || event.payload?.event === 'error')) {
      return false;
    }
  }
  return true;
}
