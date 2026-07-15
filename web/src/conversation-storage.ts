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
