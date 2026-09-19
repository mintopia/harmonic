import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '../api';
import { subscribe, type ServerMessage } from '../ws';
import type { Conversation } from '../types';
import { removeConversationById, upsertConversation } from '../conversation-list-model';
import { useAsyncResource } from '../useAsyncResource';

/**
 * Loads and keeps live a workspace's conversation list. The initial fetch goes
 * through `useAsyncResource`, so a failed load surfaces a distinct `error`
 * instead of silently resetting to an empty list; `conversation_changed`
 * messages and the `upsert`/`remove` actions then patch the list directly, the
 * same way ws-driven updates already worked here.
 *
 * Every message received on the shared socket is also forwarded to
 * `onMessage`, so a caller that needs its own handling of the same stream
 * (e.g. attention tracking) can piggyback on this hook's subscription instead
 * of opening a second one.
 */
export function useConversationList(
  workspaceId: number | null,
  onMessage: (msg: ServerMessage) => void,
): {
  conversations: Conversation[];
  error: string | null;
  loading: boolean;
  reload: () => void;
  upsert: (conversation: Conversation) => void;
  remove: (id: number) => void;
} {
  const list = useAsyncResource(
    workspaceId === null ? null : () => api.conversations(workspaceId).then(({ conversations }) => conversations),
    [workspaceId],
  );
  const [conversations, setConversations] = useState<Conversation[]>([]);
  useEffect(() => { setConversations(list.data ?? []); }, [list.data]);

  const onMessageRef = useRef(onMessage);
  const reloadRef = useRef(list.reload);
  useLayoutEffect(() => {
    onMessageRef.current = onMessage;
    reloadRef.current = list.reload;
  });

  useEffect(() => {
    if (workspaceId === null) return;
    return subscribe((msg) => {
      onMessageRef.current(msg);
      if (msg.type === 'conversation_changed' && msg.conversation.workspaceId === workspaceId) {
        setConversations((current) => upsertConversation(current, msg.conversation));
      }
    }, () => reloadRef.current());
  }, [workspaceId]);

  const upsert = useCallback((conversation: Conversation) => {
    setConversations((current) => upsertConversation(current, conversation));
  }, []);
  const remove = useCallback((id: number) => {
    setConversations((current) => removeConversationById(current, id));
  }, []);

  return {
    conversations,
    error: list.error,
    loading: list.loading,
    reload: list.reload,
    upsert,
    remove,
  };
}
