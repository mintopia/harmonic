import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { PendingPermission } from '../conversation-permissions-model';
import {
  applyAttentionMessage,
  clearAttention,
  NO_ATTENTION,
  type AttentionState,
} from '../conversation-attention-model';
import { useConversationDetail } from './useConversationDetail';
import { useConversationList } from './useConversationList';

export type LauncherView = { kind: 'list' } | { kind: 'detail'; conversationId: number | null };

export type ConversationLauncherState = {
  view: LauncherView;
  setView: Dispatch<SetStateAction<LauncherView>>;
  focusedId: number | null;
  attention: AttentionState;
  setAttention: Dispatch<SetStateAction<AttentionState>>;
  list: ReturnType<typeof useConversationList>;
  openList: () => void;
  openConversation: (id: number) => void;
  openCompose: () => void;
  setOpenedPendingPermission: Dispatch<SetStateAction<PendingPermission | null>>;
} & Pick<
  ReturnType<typeof useConversationDetail>,
  'conversation' | 'events' | 'pending' | 'pendingElicitations' | 'actions' | 'loadError' | 'reload'
> & {
  composerReady: boolean;
  ended: boolean;
  resumable: boolean;
};

export function useConversationLauncherState({
  workspaceId,
  initialFocusedId,
  onNavigate,
  active = true,
}: {
  workspaceId: number | null;
  initialFocusedId: () => number | null;
  // Its identity flows into openList/openConversation/openCompose, which useConversationDetail
  // keys effects on — an unstable onNavigate changes when those effects rerun.
  onNavigate: (conversationId: number | null) => void;
  active?: boolean;
}): ConversationLauncherState {
  const [view, setView] = useState<LauncherView>(() => {
    const id = initialFocusedId();
    return id === null ? { kind: 'list' } : { kind: 'detail', conversationId: id };
  });
  const focusedId = view.kind === 'detail' ? view.conversationId : null;

  const [attention, setAttention] = useState<AttentionState>(NO_ATTENTION);

  const [openedPendingPermission, setOpenedPendingPermission] = useState<PendingPermission | null>(null);
  const clearOpenedPendingPermission = useCallback(() => setOpenedPendingPermission(null), []);

  const focusedRef = useRef<number | null>(active ? focusedId : null);
  useEffect(() => {
    const focused = active && view.kind === 'detail' ? view.conversationId : null;
    focusedRef.current = focused;
    if (focused !== null) setAttention((current) => clearAttention(current, focused));
  }, [active, view]);

  const list = useConversationList(workspaceId, (msg) => {
    setAttention((current) => applyAttentionMessage(current, msg, focusedRef.current));
  });
  const listRemoveRef = useRef(list.remove);
  useLayoutEffect(() => { listRemoveRef.current = list.remove; });
  const removeConversationFromList = useCallback((id: number) => {
    listRemoveRef.current(id);
    setAttention((current) => clearAttention(current, id));
  }, []);

  const openList = useCallback(() => {
    setView({ kind: 'list' });
    onNavigate(null);
  }, [onNavigate]);
  const openConversation = useCallback((id: number) => {
    setView({ kind: 'detail', conversationId: id });
    onNavigate(id);
  }, [onNavigate]);
  const openCompose = useCallback(() => {
    setView({ kind: 'detail', conversationId: null });
    onNavigate(null);
  }, [onNavigate]);

  const detail = useConversationDetail(focusedId, {
    workspaceId,
    upsertConversationInList: list.upsert,
    removeConversationFromList,
    openConversation,
    openList,
    pendingPermission: openedPendingPermission,
    clearPendingPermission: clearOpenedPendingPermission,
  });

  const composerReady = view.kind === 'detail' && (view.conversationId === null || detail.conversation !== null);
  const ended = detail.conversation?.state === 'ended';
  const resumable = detail.conversation?.sessionId != null;

  return {
    view,
    setView,
    focusedId,
    attention,
    setAttention,
    list,
    openList,
    openConversation,
    openCompose,
    setOpenedPendingPermission,
    conversation: detail.conversation,
    events: detail.events,
    pending: detail.pending,
    pendingElicitations: detail.pendingElicitations,
    actions: detail.actions,
    loadError: detail.loadError,
    reload: detail.reload,
    composerReady,
    ended,
    resumable,
  };
}
