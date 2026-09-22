import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { boardSections } from './board-sections-model';
import { debounce } from './debounce';
import type { Epic } from './epic-model';
import { taskLabel } from './id-format.js';
import {
  advanceReviewAnnouncements,
  EMPTY_REVIEW_ANNOUNCEMENT_CURSOR,
  type ReviewAnnouncementCursor,
} from './review-announce-model';
import { NO_SELECTION, type Route } from './router-model';
import { toastError, toastFail, toastSuccess } from './toast';
import type { AppConfig, Task, UpdateState, Workspace } from './types';
import { useLiveEffect } from './useLiveEffect';
import type { NavigateFn } from './useRoute';
import { loadActiveWorkspaceId, storeActiveWorkspaceId } from './workspace-model';
import { subscribe } from './ws';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

const BOARD_PAGE = 100;
const POLL_INTERVAL_MS = 10_000;
const MAX_POLL_INTERVAL_MS = 60_000;

async function fetchAllPages<T>(loadPage: (offset: number) => Promise<{ items: T[]; total: number }>): Promise<T[]> {
  const all: T[] = [];
  for (let offset = 0; ; offset += BOARD_PAGE) {
    const { items, total } = await loadPage(offset);
    all.push(...items);
    if (items.length === 0 || all.length >= total) return all;
  }
}

function fetchOpenTasks(apiImpl: typeof api, workspaceId: number): Promise<Task[]> {
  return fetchAllPages((offset) =>
    apiImpl
      .tasks({ workspaceId, state: 'open', limit: BOARD_PAGE, offset })
      .then(({ tasks, total }) => ({ items: tasks, total })),
  );
}

function fetchAllEpics(apiImpl: typeof api, workspaceId: number): Promise<Epic[]> {
  return fetchAllPages((offset) =>
    apiImpl.epics(workspaceId, { limit: BOARD_PAGE, offset }).then(({ epics, total }) => ({ items: epics, total })),
  );
}

export interface UseAppSyncArgs {
  authed: boolean | null;
  route: Route;
  navigate: NavigateFn;
  /** Called when a WS `task_changed` push resolves a Ticket out of the escalated state, so the
   * caller can permanently dismiss the escalation onboarding hint (App-level UI preference). */
  onEscalationHandled?: () => void;
  apiImpl?: typeof api;
  storage?: StorageLike;
}

export function useAppSync({ authed, route, navigate, onEscalationHandled, apiImpl = api, storage = localStorage }: UseAppSyncArgs) {
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<number | null>(() => loadActiveWorkspaceId(storage));
  useEffect(() => {
    if (route.scope.kind === 'workspace') {
      setActiveWorkspaceId(route.scope.workspaceId);
      storeActiveWorkspaceId(storage, route.scope.workspaceId);
    } else {
      setActiveWorkspaceId(null);
    }
  }, [route.scope, storage]);

  const routeRef = useRef(route);
  // eslint-disable-next-line react/refs -- latest-route ref, deliberately synced during render so the ws handler reads it without re-subscribing
  routeRef.current = route;
  const onEscalationHandledRef = useRef(onEscalationHandled);
  // eslint-disable-next-line react/refs -- latest-callback ref, deliberately synced during render so the ws handler always calls the current one without re-subscribing
  onEscalationHandledRef.current = onEscalationHandled;

  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [hasHistory, setHasHistory] = useState<boolean | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [globalPaused, setGlobalPaused] = useState<boolean | null>(null);
  const [globalPausePending, setGlobalPausePending] = useState(false);
  const [update, setUpdate] = useState<UpdateState | null>(null);
  const [updatePending, setUpdatePending] = useState(false);
  const [updatePollKey, setUpdatePollKey] = useState(0);
  const updateRequest = useRef(0);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspacesLoaded, setWorkspacesLoaded] = useState(false);
  const [epics, setEpics] = useState<Epic[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshingTracker, setRefreshingTracker] = useState(false);
  const fetchedTaskIdRef = useRef<number | null>(null);
  const [fetchedTask, setFetchedTask] = useState<Task | null>(null);

  const failStreak = useRef(0);
  const refresh = useCallback(async () => {
    if (activeWorkspaceId === null) return;
    try {
      const tasks = await fetchOpenTasks(apiImpl, activeWorkspaceId);
      setTasks(tasks);
      failStreak.current = 0;
      setError(null);
    } catch (e) {
      failStreak.current += 1;
      if (failStreak.current >= 2) setError(e instanceof Error ? e.message : String(e));
    }
  }, [activeWorkspaceId, apiImpl]);

  const refreshGlobalPause = useCallback(() => {
    apiImpl
      .globalPause()
      .then(({ paused }) => setGlobalPaused(paused))
      .catch((error) => console.warn('refreshGlobalPause: fetch failed, keeping last-known state', error));
  }, [apiImpl]);

  const refreshEpics = useCallback(async () => {
    if (activeWorkspaceId === null) return;
    try {
      setEpics(await fetchAllEpics(apiImpl, activeWorkspaceId));
    } catch (error) {
      console.warn('refreshEpics: fetch failed, keeping last-known epics', error);
    }
  }, [activeWorkspaceId, apiImpl]);

  useLiveEffect((live) => {
    if (!authed) return;
    apiImpl.config().then((next) => live() && setConfig(next), (error) => live() && toastError(error));
    apiImpl
      .globalPause()
      .then(({ paused }) => live() && setGlobalPaused(paused))
      .catch((error) => live() && console.warn('useAppSync: initial globalPause fetch failed', error));
    apiImpl.workspaces().then(({ workspaces }) => {
      if (!live()) return;
      setWorkspaces(workspaces);
      setWorkspacesLoaded(true);
      if (route.scope.kind === 'workspace') setActiveWorkspaceId(route.scope.workspaceId);
    }, (error) => live() && toastError(error));
  }, [authed, route.scope, apiImpl]);

  useLiveEffect((live) => {
    if (!authed) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      const request = ++updateRequest.current;
      apiImpl.updateState().then(
        (next) => {
          if (!live() || request !== updateRequest.current) return;
          setUpdate(next);
          timer = setTimeout(load, next.armedVersion === null ? 15_000 : 1_000);
        },
        () => {
          if (!live() || request !== updateRequest.current) return;
          timer = setTimeout(load, 1_000);
        },
      );
    };
    load();
    return () => timer !== undefined && clearTimeout(timer);
  }, [authed, apiImpl, updatePollKey]);

  useLiveEffect((live) => {
    if (!authed || activeWorkspaceId === null) return;
    setHasHistory(null);
    apiImpl.tasks({ workspaceId: activeWorkspaceId, limit: 1 }).then(
      ({ total }) => live() && setHasHistory(total > 0),
      (error) => live() && console.warn('useAppSync: hasHistory probe failed', error),
    );
  }, [authed, activeWorkspaceId, apiImpl]);

  useLiveEffect((live) => {
    if (!authed || activeWorkspaceId === null) return;
    refresh();
    refreshEpics();
    refreshGlobalPause();
    const debouncedRefreshEpics = debounce(refreshEpics, 250);
    const unsubscribe = subscribe((msg) => {
      if (!live()) return;
      if (msg.type === 'task_changed' && msg.task.workspaceId === activeWorkspaceId) {
        const outcomes: (() => void)[] = [];
        let handledEscalation = false;
        setTasks((current) => {
          const prev = (current ?? []).find((t) => t.id === msg.task.id);
          if (prev?.mergeStatus && !msg.task.mergeStatus && msg.task.state === 'done') {
            outcomes.push(() => toastSuccess(`${taskLabel(msg.task.id)} merged`, { sticky: true }));
          } else if (prev && prev.state !== 'escalated' && msg.task.state === 'escalated') {
            outcomes.push(() => toastFail(`${taskLabel(msg.task.id)} escalated — needs a decision`));
          }
          if (prev?.state === 'escalated' && msg.task.state !== 'escalated') handledEscalation = true;
          const rest = (current ?? []).filter((t) => t.id !== msg.task.id);
          return [...rest, msg.task];
        });
        outcomes[0]?.();
        if (handledEscalation) onEscalationHandledRef.current?.();
        setFetchedTask((current) =>
          current?.id === msg.task.id || routeRef.current.task === msg.task.id ? msg.task : current,
        );
        debouncedRefreshEpics();
      }
      if (msg.type === 'epic_changed' && msg.workspaceId === activeWorkspaceId) {
        debouncedRefreshEpics();
      }
      if (msg.type === 'epic_integrated' && msg.workspaceId === activeWorkspaceId) {
        toastSuccess(`Epic #${msg.epicRef} merged`, { sticky: true });
        debouncedRefreshEpics();
      }
      if (msg.type === 'task_removed') {
        setTasks((current) => (current ?? []).filter((t) => t.id !== msg.id));
        setFetchedTask((current) => (current && current.id === msg.id ? null : current));
        if (routeRef.current.task === msg.id) {
          navigate({ ...routeRef.current, task: null, panel: NO_SELECTION }, { replace: true });
        }
      }
    }, () => {
      refresh();
      refreshEpics();
      refreshGlobalPause();
    });
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    const schedulePoll = () => {
      const delay = Math.min(POLL_INTERVAL_MS * 2 ** failStreak.current, MAX_POLL_INTERVAL_MS);
      pollTimer = setTimeout(() => {
        refresh();
        refreshEpics();
        refreshGlobalPause();
        schedulePoll();
      }, delay);
    };
    schedulePoll();
    return () => {
      unsubscribe();
      if (pollTimer !== undefined) clearTimeout(pollTimer);
      debouncedRefreshEpics.cancel();
    };
  }, [refresh, refreshEpics, refreshGlobalPause, authed, activeWorkspaceId, navigate]);

  const openTask = useMemo<Task | null>(() => {
    if (route.task === null) return null;
    return (
      (tasks ?? []).find((t) => t.id === route.task) ??
      (fetchedTask && fetchedTask.id === route.task ? fetchedTask : null)
    );
  }, [route.task, tasks, fetchedTask]);

  useLiveEffect((live) => {
    if (route.task === null) {
      setFetchedTask(null);
      fetchedTaskIdRef.current = null;
      return;
    }
    if ((tasks ?? []).some((t) => t.id === route.task)) return;
    if (fetchedTaskIdRef.current === route.task) return;
    fetchedTaskIdRef.current = route.task;
    apiImpl.task(route.task).then((t) => live() && setFetchedTask(t), toastError);
  }, [route.task, tasks, apiImpl]);

  const needsYouCount = useMemo(
    () => boardSections(tasks ?? [], epics).attention.length,
    [tasks, epics],
  );
  const reviewAnnouncementCursor = useRef<ReviewAnnouncementCursor>(EMPTY_REVIEW_ANNOUNCEMENT_CURSOR);
  const [politeReviewAnnouncement, setPoliteReviewAnnouncement] = useState('');
  const [assertiveMergeAnnouncement, setAssertiveMergeAnnouncement] = useState('');
  useEffect(() => {
    if (tasks === null) {
      reviewAnnouncementCursor.current = EMPTY_REVIEW_ANNOUNCEMENT_CURSOR;
      setPoliteReviewAnnouncement('');
      setAssertiveMergeAnnouncement('');
      return;
    }
    const next = advanceReviewAnnouncements(tasks, needsYouCount, reviewAnnouncementCursor.current);
    reviewAnnouncementCursor.current = next.cursor;
    setPoliteReviewAnnouncement(next.polite);
    setAssertiveMergeAnnouncement(next.assertive);
  }, [tasks, needsYouCount]);

  const setFleetPaused = useCallback(
    (paused: boolean) => {
      if (globalPausePending) return;
      setGlobalPausePending(true);
      (paused ? apiImpl.pauseGlobal() : apiImpl.resumeGlobal())
        .then(({ paused: next }) => {
          setGlobalPaused(next);
          refresh();
        }, toastError)
        .finally(() => setGlobalPausePending(false));
    },
    [globalPausePending, apiImpl, refresh],
  );

  const changeUpdate = useCallback(
    (action: () => Promise<UpdateState>) => {
      if (updatePending) return;
      const request = ++updateRequest.current;
      setUpdatePending(true);
      action().then(
        (next) => {
          if (request !== updateRequest.current) return;
          setUpdate(next);
          if (next.armedVersion !== null) setUpdatePollKey((key) => key + 1);
        },
        toastError,
      ).finally(() => setUpdatePending(false));
    },
    [updatePending],
  );

  const refreshTracker = useCallback(() => {
    if (activeWorkspaceId === null || refreshingTracker) return;
    setRefreshingTracker(true);
    apiImpl
      .refreshTracker(activeWorkspaceId)
      .then(refresh, toastError)
      .finally(() => setRefreshingTracker(false));
  }, [activeWorkspaceId, refreshingTracker, apiImpl, refresh]);

  return {
    activeWorkspaceId,
    setActiveWorkspaceId,
    config,
    setConfig,
    globalPaused,
    globalPausePending,
    setFleetPaused,
    workspaces,
    setWorkspaces,
    workspacesLoaded,
    update,
    updatePending,
    changeUpdate,
    tasks,
    setTasks,
    hasHistory,
    error,
    epics,
    setEpics,
    refresh,
    refreshTracker,
    refreshingTracker,
    openTask,
    needsYouCount,
    politeReviewAnnouncement,
    assertiveMergeAnnouncement,
  };
}
