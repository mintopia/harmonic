// Explicit .js extension: shared with the node-side test project (see
// conversation-transcript-model.ts's note on NodeNext resolution).
import type { Conversation } from './types.js';

/**
 * Display text for a Conversation's title (issue #15). The server already
 * resolves operator-set vs first-Turn-derived title into `Conversation.title`
 * (the LOCKED contract) — this only covers the one case neither could
 * produce: no custom title and no Turn yet, which the API represents as
 * `null`. An honest placeholder, never a blank row.
 */
export function conversationDisplayTitle(title: string | null): string {
  return title && title.trim().length > 0 ? title : 'Untitled conversation';
}

/**
 * Inserts or replaces a Conversation by id — the shared merge for the
 * list's initial `GET /conversations` load and every live
 * `conversation_changed` message afterward. An unknown id is prepended
 * (newest first, matching the server's reverse-chronological `createdAt`
 * order — a brand new Conversation is always the newest); a known id is
 * replaced in place rather than moved, since the server sorts by
 * `createdAt` alone and a rename/usage update must not reorder the list
 * out from under a scrolled operator.
 */
export function upsertConversation(list: Conversation[], conversation: Conversation): Conversation[] {
  const idx = list.findIndex((c) => c.id === conversation.id);
  if (idx === -1) return [conversation, ...list];
  const next = list.slice();
  next[idx] = conversation;
  return next;
}

/** Drops one Conversation by id — the list's local removal on a successful
 * delete (issue #15: deletion doesn't broadcast over the WebSocket). */
export function removeConversationById(list: Conversation[], id: number): Conversation[] {
  return list.filter((c) => c.id !== id);
}
