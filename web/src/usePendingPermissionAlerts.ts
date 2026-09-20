import { useState } from 'react';
import { api } from './api';
import {
  removePendingForConversation,
  resolvePendingPermissionFromEvent,
  type PendingPermission,
} from './conversation-permissions-model';
import { conversationDisplayTitle } from './conversation-list-model';
import { useLiveEffect } from './useLiveEffect';
import { subscribe } from './ws';

export interface PendingPermissionAlert {
  permission: PendingPermission;
  conversationTitle: string;
}

export function usePendingPermissionAlerts(
  authed: boolean | null,
  activeWorkspaceId: number | null,
  apiImpl: Pick<typeof api, 'conversation'> = api,
): PendingPermissionAlert[] {
  const [pendingPermissionAlerts, setPendingPermissionAlerts] = useState<PendingPermissionAlert[]>([]);

  useLiveEffect((live) => {
    if (!authed || activeWorkspaceId === null) return;
    return subscribe((msg) => {
      if (!live()) return;
      if (msg.type === 'permission_request') {
        setPendingPermissionAlerts((current) => {
          const permission: PendingPermission = {
            reqId: msg.reqId,
            conversationId: msg.conversationId,
            request: msg.request,
          };
          const existing = current.findIndex(({ permission }) => permission.reqId === msg.reqId);
          if (existing === -1) return [...current, { permission, conversationTitle: 'Conversation' }];
          const next = current.slice();
          const previous = next[existing];
          if (!previous) return current;
          next[existing] = { ...previous, permission };
          return next;
        });
        apiImpl.conversation(msg.conversationId).then(
          (conversation) =>
            setPendingPermissionAlerts((current) =>
              current.map((alert) =>
                alert.permission.conversationId === conversation.id
                  ? { ...alert, conversationTitle: conversationDisplayTitle(conversation.title) }
                  : alert,
              ),
            ),
          () => {},
        );
      }
      if (msg.type === 'conversation_event') {
        setPendingPermissionAlerts((current) => {
          const pending = Object.fromEntries(current.map(({ permission }) => [permission.reqId, permission]));
          const resolved = resolvePendingPermissionFromEvent(pending, msg.event);
          return current.filter(({ permission }) => resolved[permission.reqId] !== undefined);
        });
      }
      if (msg.type === 'conversation_changed') {
        const conversation = msg.conversation;
        setPendingPermissionAlerts((current) => {
          if (conversation.state === 'ended') {
            const pending = Object.fromEntries(current.map(({ permission }) => [permission.reqId, permission]));
            const remaining = removePendingForConversation(pending, conversation.id);
            return current.filter(({ permission }) => remaining[permission.reqId] !== undefined);
          }
          return current.map((alert) =>
            alert.permission.conversationId === conversation.id
              ? { ...alert, conversationTitle: conversationDisplayTitle(conversation.title) }
              : alert,
          );
        });
      }
    });
  }, [authed, activeWorkspaceId, apiImpl]);

  return pendingPermissionAlerts;
}
