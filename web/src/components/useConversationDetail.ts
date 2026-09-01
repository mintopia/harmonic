import { useEffect, useState } from 'react';
import { api } from '../api';
import { subscribe } from '../ws';
import type { Conversation, ConversationEvent } from '../types';
import {
  addPendingPermission,
  removePendingPermission,
  resolvePendingPermissionFromEvent,
  type PendingPermission,
  type PendingPermissions,
} from '../conversation-permissions-model';
import { toastError } from '../toast';

export function useConversationDetail(
  focusedId: number | null,
  options: {
    workspaceId: number | null;
    upsertConversationInList: (c: Conversation) => void;
    removeConversationFromList: (id: number) => void;
    openConversation: (id: number) => void;
    openList: () => void;
  },
) {
  const { workspaceId, upsertConversationInList, removeConversationFromList, openConversation, openList } = options;

  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [events, setEvents] = useState<ConversationEvent[]>([]);
  const [pending, setPending] = useState<PendingPermissions>({});

  useEffect(() => {
    if (focusedId === null) {
      setConversation(null);
      setEvents([]);
      setPending({});
      return;
    }
    const id = focusedId;
    let live = true;
    setConversation(null);
    setEvents([]);
    setPending({});
    api.conversation(id).then((c) => {
      if (!live) return;
      setConversation(c);
      upsertConversationInList(c);
    }, toastError);
    api.conversationEvents(id).then(({ events }) => live && setEvents(events), toastError);
    const unsubscribe = subscribe((msg) => {
      if (msg.type === 'conversation_event' && msg.event.conversationId === id) {
        setEvents((current) =>
          current.some((e) => e.id === msg.event.id) ? current : [...current, msg.event],
        );
        // The resolution signal (LOCKED contract): a permission_request
        // conversation_event whose payload.reqId matches a pending prompt
        // clears it, whether it was answered here or elsewhere/crashed.
        setPending((current) => resolvePendingPermissionFromEvent(current, msg.event));
      }
      if (msg.type === 'permission_request' && msg.conversationId === id) {
        setPending((current) => addPendingPermission(current, msg));
      }
      if (msg.type === 'conversation_changed' && msg.conversation.id === id) {
        setConversation(msg.conversation);
        upsertConversationInList(msg.conversation);
        // Belt-and-braces: the server auto-clears pending permissions on
        // end/crash via the resolution signal above, but a prompt should
        // never outlive the conversation's own 'ended' state in the UI.
        if (msg.conversation.state === 'ended') setPending({});
      }
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [focusedId, upsertConversationInList]);

  const send = async (fields: { harness: string; model: string }, text: string) => {
    let id = focusedId;
    if (id === null) {
      const created = await api.createConversation({
        ...fields,
        ...(workspaceId !== null ? { workspaceId } : {}),
      });
      id = created.id;
      setConversation(created);
      upsertConversationInList(created);
      openConversation(id);
    }
    const { queued } = await api.sendTurn(id, text);
    return { queued };
  };

  const end = () => {
    const id = focusedId;
    if (id === null) return;
    api.endConversation(id).then((c) => {
      setConversation(c);
      upsertConversationInList(c);
      setPending({});
    }, toastError);
  };

  const rename = async (title: string | null) => {
    const id = focusedId;
    if (id === null) return;
    try {
      const updated = await api.renameConversation(id, title);
      setConversation(updated);
      upsertConversationInList(updated);
    } catch (e) {
      toastError(e);
    }
  };

  const deleteConversation = async (id: number) => {
    try {
      await api.deleteConversation(id);
      removeConversationFromList(id);
      if (id === focusedId) openList();
    } catch (e) {
      toastError(e);
    }
  };

  // Optimistic relative to the *resolving event*, not the HTTP response:
  // the server confirms via a conversation_event carrying this reqId, but
  // there is no reason to wait for it once the answer POST itself
  // succeeded — remove the prompt immediately, and re-add it (implicitly,
  // by leaving state untouched) on failure so the operator can retry.
  const answerPermission = async (p: PendingPermission, optionId: string, remember?: boolean) => {
    try {
      await api.answerPermission(p.conversationId, p.reqId, optionId, remember);
      setPending((current) => removePendingPermission(current, p.reqId));
    } catch (e) {
      toastError(e);
    }
  };

  return {
    conversation,
    events,
    pending,
    actions: { send, end, rename, deleteConversation, answerPermission },
  };
}
