import { useMemo, useRef, useState } from 'react';
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
import {
  addPendingElicitation,
  removePendingElicitation,
  resolvePendingElicitationFromEvent,
  type PendingElicitation,
  type PendingElicitations,
} from '../conversation-elicitations-model';
import type { ElicitationAnswer } from '../types';
import { toastError } from '../toast';
import { useLiveEffect } from '../useLiveEffect';

export function isConversationInWorkspace(
  conversation: Pick<Conversation, 'workspaceId'>,
  workspaceId: number | null,
) {
  return workspaceId !== null && conversation.workspaceId === workspaceId;
}

export function useConversationDetail(
  focusedId: number | null,
  options: {
    workspaceId: number | null;
    upsertConversationInList: (c: Conversation) => void;
    removeConversationFromList: (id: number) => void;
    openConversation: (id: number) => void;
    openList: () => void;
    pendingPermission: PendingPermission | null;
    clearPendingPermission: () => void;
  },
) {
  const {
    workspaceId,
    upsertConversationInList,
    removeConversationFromList,
    openConversation,
    openList,
    pendingPermission,
    clearPendingPermission,
  } = options;

  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [events, setEvents] = useState<ConversationEvent[]>([]);
  const [pending, setPending] = useState<PendingPermissions>({});
  const [pendingElicitations, setPendingElicitations] = useState<PendingElicitations>({});
  // Steering messages we render immediately, before the server has persisted and
  // echoed them back as real `user_turn` events. Each carries a negative id so it
  // never collides with a real one; the earliest is dropped as each real
  // `user_turn` arrives (turns are strictly sequential, so FIFO stays aligned).
  const [optimisticTurns, setOptimisticTurns] = useState<ConversationEvent[]>([]);
  const optimisticSeq = useRef(-1);

  useLiveEffect((live) => {
    if (focusedId === null) {
      setConversation(null);
      setEvents([]);
      setPending({});
      return;
    }
    const id = focusedId;
    setConversation(null);
    setEvents([]);
    setOptimisticTurns([]);
    setPending(
      pendingPermission?.conversationId === id
        ? { [pendingPermission.reqId]: pendingPermission }
        : {},
    );
    setPendingElicitations({});
    const load = () => {
      api.conversation(id).then((c) => {
        if (!live()) return;
        if (!isConversationInWorkspace(c, workspaceId)) {
          openList();
          return;
        }
        setConversation(c);
        upsertConversationInList(c);
        api.conversationEvents(id).then(({ events }) => live() && setEvents(events), toastError);
      }, toastError);
    };
    load();
    const unsubscribe = subscribe((msg) => {
      if (msg.type === 'conversation_event' && msg.event.conversationId === id) {
        setEvents((current) =>
          current.some((e) => e.id === msg.event.id) ? current : [...current, msg.event],
        );
        if (msg.event.type === 'user_turn') {
          setOptimisticTurns((current) => current.slice(1));
        }
        setPending((current) => resolvePendingPermissionFromEvent(current, msg.event));
        setPendingElicitations((current) => resolvePendingElicitationFromEvent(current, msg.event));
        const payload = msg.event.payload;
        if (
          msg.event.type === 'permission_request' &&
          payload !== null &&
          typeof payload === 'object' &&
          'reqId' in payload &&
          payload.reqId === pendingPermission?.reqId
        ) {
          clearPendingPermission();
        }
      }
      if (msg.type === 'permission_request' && msg.conversationId === id) {
        setPending((current) => addPendingPermission(current, msg));
      }
      if (msg.type === 'elicitation_request' && msg.conversationId === id) {
        setPendingElicitations((current) => addPendingElicitation(current, msg));
      }
      if (msg.type === 'conversation_changed' && msg.conversation.id === id) {
        if (!isConversationInWorkspace(msg.conversation, workspaceId)) {
          openList();
          return;
        }
        setConversation(msg.conversation);
        upsertConversationInList(msg.conversation);
        if (msg.conversation.state === 'ended') {
          setPending({});
          setPendingElicitations({});
          setOptimisticTurns([]);
          clearPendingPermission();
        }
      }
    }, load);
    return () => {
      unsubscribe();
    };
  }, [
    focusedId,
    workspaceId,
    upsertConversationInList,
    openList,
    pendingPermission,
    clearPendingPermission,
  ]);

  const send = async (fields: { harness: string; model: string; permissionMode: Conversation['permissionMode'] }, text: string) => {
    const steering = focusedId !== null;
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
    // Show the message in the transcript right away when steering the open
    // conversation. A brand-new conversation switches focus and reloads events,
    // which would discard an optimistic turn, so we skip it there.
    if (steering) {
      const optimisticId = optimisticSeq.current;
      optimisticSeq.current -= 1;
      setOptimisticTurns((current) => [
        ...current,
        {
          id: optimisticId,
          conversationId: id,
          seq: Number.MAX_SAFE_INTEGER,
          ts: Date.now(),
          type: 'user_turn',
          payload: { text, pending: true },
        },
      ]);
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
      setPendingElicitations({});
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

  const setPermissionMode = async (permissionMode: Conversation['permissionMode']) => {
    const id = focusedId;
    if (id === null) return;
    try {
      const updated = await api.setConversationPermissionMode(id, permissionMode);
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

  const answerPermission = async (p: PendingPermission, optionId: string, remember?: boolean) => {
    try {
      await api.answerPermission(p.conversationId, p.reqId, optionId, remember);
      setPending((current) => removePendingPermission(current, p.reqId));
      clearPendingPermission();
    } catch (e) {
      toastError(e);
    }
  };

  const answerElicitation = async (p: PendingElicitation, answer: ElicitationAnswer) => {
    try {
      await api.answerElicitation(p.conversationId, p.reqId, answer);
      setPendingElicitations((current) => removePendingElicitation(current, p.reqId));
    } catch (e) {
      toastError(e);
    }
  };

  const allEvents = useMemo(
    () => (optimisticTurns.length === 0 ? events : [...events, ...optimisticTurns]),
    [events, optimisticTurns],
  );

  return {
    conversation,
    events: allEvents,
    pending,
    pendingElicitations,
    actions: { send, end, rename, setPermissionMode, deleteConversation, answerPermission, answerElicitation },
  };
}
