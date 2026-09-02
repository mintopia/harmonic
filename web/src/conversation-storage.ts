type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export const CONVERSATION_ID_KEY = 'harmonic.conversation-id';

export function loadConversationId(storage: StorageLike): number | null {
  try {
    const raw = storage.getItem(CONVERSATION_ID_KEY);
    if (!raw) return null;
    const id = Number(raw);
    return Number.isFinite(id) ? id : null;
  } catch {
    return null;
  }
}

export function storeConversationId(storage: StorageLike, id: number): void {
  try {
    storage.setItem(CONVERSATION_ID_KEY, String(id));
  } catch {
  }
}

/** Forgets the last-open conversation: called when the operator
 * explicitly navigates back to the list, so reopening the launcher shows the
 * list rather than snapping back into a conversation they deliberately left —
 * "returns to where the operator was" covers the list itself as a place. */
export function clearConversationId(storage: StorageLike): void {
  try {
    storage.removeItem(CONVERSATION_ID_KEY);
  } catch {
  }
}
