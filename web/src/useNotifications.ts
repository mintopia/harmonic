import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { subscribe } from './ws';
import { toastError } from './toast';
import {
  EMPTY_NOTIFICATIONS,
  NOTIFICATION_PAGE_SIZE,
  RETENTION_CAP,
  applyCreated,
  applyRead,
  markAllReadLocal,
  mergeFetchedPage,
  mergeOlderPage,
  unknownIds,
  type NotificationsState,
} from './notifications-model';

const COUNT_REFRESH_MS = 300;

export interface NotificationsApi {
  state: NotificationsState;
  allRetainedLoaded: boolean;
  markRead: (id: number) => void;
  markAllRead: () => void;
}

export function useNotifications(authed: boolean, scopeWorkspaceId: number | null, all: boolean): NotificationsApi {
  const [state, setState] = useState<NotificationsState>(EMPTY_NOTIFICATIONS);
  const [allRetainedLoaded, setAllRetainedLoaded] = useState(false);
  const stateRef = useRef(state);
  const scopeRef = useRef(scopeWorkspaceId);
  const allRef = useRef(all);
  const generation = useRef(0);
  const running = useRef<number | null>(null);
  const dirty = useRef(false);
  const countTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const commit = useCallback((update: (prev: NotificationsState) => NotificationsState) => {
    stateRef.current = update(stateRef.current);
    setState(stateRef.current);
  }, []);

  const sync = useCallback(async () => {
    const gen = generation.current;
    if (running.current === gen) {
      dirty.current = true;
      return;
    }
    running.current = gen;
    const scope = scopeRef.current ?? undefined;
    const live = () => gen === generation.current;
    try {
      do {
        dirty.current = false;
        const page = await api.notifications({ workspaceId: scope, limit: NOTIFICATION_PAGE_SIZE });
        if (!live()) return;
        commit((prev) => mergeFetchedPage(prev, page.items, page.unreadCount));
        let last = page;
        while (allRef.current && last.items.length >= NOTIFICATION_PAGE_SIZE && stateRef.current.items.length < RETENTION_CAP) {
          last = await api.notifications({ workspaceId: scope, limit: NOTIFICATION_PAGE_SIZE, before: last.items[last.items.length - 1]!.id });
          if (!live()) return;
          commit((prev) => mergeOlderPage(prev, last.items));
        }
        setAllRetainedLoaded(last.items.length < NOTIFICATION_PAGE_SIZE || stateRef.current.items.length >= RETENTION_CAP);
      } while (dirty.current);
    } catch (e) {
      if (live()) toastError(e);
    } finally {
      if (running.current === gen) running.current = null;
    }
  }, [commit]);

  const scheduleCountRefresh = useCallback(() => {
    if (countTimer.current !== null) return;
    const gen = generation.current;
    countTimer.current = setTimeout(() => {
      countTimer.current = null;
      api.notifications({ workspaceId: scopeRef.current ?? undefined, limit: 1 }).then(
        (page) => gen === generation.current && commit((prev) => ({ ...prev, unreadCount: page.unreadCount })),
        toastError,
      );
    }, COUNT_REFRESH_MS);
  }, [commit]);

  useEffect(() => {
    if (!authed) return;
    generation.current++;
    scopeRef.current = scopeWorkspaceId;
    dirty.current = false;
    commit(() => EMPTY_NOTIFICATIONS);
    setAllRetainedLoaded(false);
    void sync();
    const unsubscribe = subscribe(
      (msg) => {
        if (msg.type === 'notification_created') commit((prev) => applyCreated(prev, msg.notification, scopeRef.current));
        else if (msg.type === 'notifications_read') {
          const unknown = unknownIds(stateRef.current, msg.ids).length > 0;
          commit((prev) => applyRead(prev, msg.ids));
          if (unknown) scheduleCountRefresh();
        }
      },
      () => void sync(),
    );
    return () => {
      unsubscribe();
      if (countTimer.current !== null) clearTimeout(countTimer.current);
      countTimer.current = null;
    };
  }, [authed, scopeWorkspaceId, commit, sync, scheduleCountRefresh]);

  useEffect(() => {
    if (allRef.current === all) return;
    allRef.current = all;
    if (all && authed) void sync();
  }, [all, authed, sync]);

  const markRead = useCallback((id: number) => {
    commit((prev) => applyRead(prev, [id], Date.now()));
    api.markNotificationRead(id).catch((e) => {
      toastError(e);
      void sync();
    });
  }, [commit, sync]);

  const markAllRead = useCallback(() => {
    commit((prev) => markAllReadLocal(prev, Date.now()));
    api.markAllNotificationsRead(scopeRef.current ?? undefined).catch((e) => {
      toastError(e);
      void sync();
    });
  }, [commit, sync]);

  return { state, allRetainedLoaded, markRead, markAllRead };
}
