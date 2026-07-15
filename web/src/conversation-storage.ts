/**
 * Persists which Conversation the launcher panel has open across
 * close/reopen and page reloads (issue #10 walking skeleton) — the panel
 * itself is not the source of truth, the server is; this only remembers
 * *which* conversation to replay via `GET /api/conversations/:id/events`.
 * Storage is injected, mirroring rail-model.ts, so this stays unit-testable
 * without a DOM.
 */
type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export const CONVERSATION_ID_KEY = 'harmonic.conversation-id';

export function loadConversationId(storage: StorageLike): number | null {
  try {
    const raw = storage.getItem(CONVERSATION_ID_KEY);
    if (!raw) return null;
    const id = Number(raw);
    return Number.isFinite(id) ? id : null;
  } catch {
    return null; // private browsing etc. — start a fresh conversation
  }
}

export function storeConversationId(storage: StorageLike, id: number): void {
  try {
    storage.setItem(CONVERSATION_ID_KEY, String(id));
  } catch {
    // best-effort: losing persistence must not break sending a turn
  }
}

/** Forgets the last-open conversation (issue #15): called when the operator
 * explicitly navigates back to the list, so reopening the launcher shows the
 * list rather than snapping back into a conversation they deliberately left —
 * "returns to where the operator was" covers the list itself as a place. */
export function clearConversationId(storage: StorageLike): void {
  try {
    storage.removeItem(CONVERSATION_ID_KEY);
  } catch {
    // best-effort, same as storeConversationId
  }
}
