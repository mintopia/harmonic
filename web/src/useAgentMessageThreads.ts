import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { NO_SERVER_FILTER, THREAD_PAGE_SIZE, hasServerFilter, mergeThreadPages, nextPageCount, type ServerThreadFilter, type ThreadsView } from './agent-messages-model';
import { debounce } from './debounce';
import { useAsyncResource } from './useAsyncResource';
import { useLiveEffect } from './useLiveEffect';
import { subscribe } from './ws';

type ThreadParams = Parameters<typeof api.agentMessageThreads>[0];

async function fetchThreadPages(params: ThreadParams, pageCount: number): Promise<ThreadsView> {
  const pages = await Promise.all(
    Array.from({ length: pageCount }, (_, i) =>
      api.agentMessageThreads({ ...params, limit: THREAD_PAGE_SIZE, offset: i * THREAD_PAGE_SIZE }),
    ),
  );
  return mergeThreadPages(pages);
}

const POLL_MS = 5_000;
const RELOAD_DEBOUNCE_MS = 250;

export function useAgentMessageThreads(workspaceId: number | null, enabled: boolean) {
  const [filter, setFilterState] = useState(NO_SERVER_FILTER);
  const [pageCount, setPageCount] = useState(1);
  const setFilter = useCallback((next: ServerThreadFilter) => {
    setFilterState(next);
    setPageCount(1);
  }, []);
  useEffect(() => {
    setFilter(NO_SERVER_FILTER);
  }, [workspaceId, setFilter]);
  const filtering = hasServerFilter(filter);
  const scope = workspaceId ?? filter.workspaceId ?? undefined;
  const optionScope = workspaceId ?? undefined;

  const all = useAsyncResource(
    enabled ? () => fetchThreadPages({ workspaceId: optionScope }, pageCount) : null,
    [workspaceId, enabled, pageCount],
    { pollMs: POLL_MS },
  );
  const filtered = useAsyncResource(
    enabled && filtering
      ? () =>
          fetchThreadPages(
            {
              workspaceId: scope,
              epicId: filter.epicId ?? undefined,
              taskId: filter.taskId ?? undefined,
              live: filter.liveOnly ? true : undefined,
            },
            pageCount,
          )
      : null,
    [scope, enabled, filter.epicId, filter.taskId, filter.liveOnly, pageCount],
    { pollMs: POLL_MS },
  );
  const current = filtering ? filtered : all;

  const [shown, setShown] = useState<{ workspaceId: number | null; view: ThreadsView } | null>(null);
  const currentData = current.data;
  useEffect(() => {
    if (currentData) setShown({ workspaceId, view: currentData });
  }, [currentData, workspaceId]);
  const view = shown?.workspaceId === workspaceId ? shown.view : null;

  const reloadAll = all.reload;
  const reloadFiltered = filtered.reload;
  useLiveEffect(() => {
    const reload = () => {
      reloadAll();
      reloadFiltered();
    };
    const reloadSoon = debounce(reload, RELOAD_DEBOUNCE_MS);
    const unsubscribe = subscribe((message) => {
      if (message.type === 'agent_messages_changed') reloadSoon();
    }, reload);
    return () => {
      unsubscribe();
      reloadSoon.cancel();
    };
  }, [workspaceId, reloadAll, reloadFiltered]);

  const loadedTotal = current.data?.total ?? 0;
  const loadMore = () => setPageCount((n) => nextPageCount(n, loadedTotal));

  return {
    loadMore,
    filter,
    setFilter,
    view,
    optionThreads: all.data?.threads ?? [],
    totalMessages: all.data?.totalMessages ?? 0,
    error: current.error,
    retry: current.reload,
  };
}
