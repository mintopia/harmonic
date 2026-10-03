import { useEffect, useState } from 'react';
import { api } from './api';
import { NO_SERVER_FILTER, hasServerFilter, type ThreadsView } from './agent-messages-model';
import { debounce } from './debounce';
import { useAsyncResource } from './useAsyncResource';
import { useLiveEffect } from './useLiveEffect';
import { subscribe } from './ws';

const THREAD_LIMIT = 200;
const POLL_MS = 5_000;
const RELOAD_DEBOUNCE_MS = 250;

export function useAgentMessageThreads(workspaceId: number | null, enabled: boolean) {
  const [filter, setFilter] = useState(NO_SERVER_FILTER);
  useEffect(() => {
    setFilter(NO_SERVER_FILTER);
  }, [workspaceId]);
  const filtering = hasServerFilter(filter);
  const scope = workspaceId ?? filter.workspaceId ?? undefined;
  const optionScope = workspaceId ?? undefined;

  const all = useAsyncResource(
    enabled ? () => api.agentMessageThreads({ workspaceId: optionScope, limit: THREAD_LIMIT }) : null,
    [workspaceId, enabled],
    { pollMs: POLL_MS },
  );
  const filtered = useAsyncResource(
    enabled && filtering
      ? () =>
          api.agentMessageThreads({
            workspaceId: scope,
            epicId: filter.epicId ?? undefined,
            taskId: filter.taskId ?? undefined,
            live: filter.liveOnly ? true : undefined,
            limit: THREAD_LIMIT,
          })
      : null,
    [scope, enabled, filter.epicId, filter.taskId, filter.liveOnly],
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

  return {
    filter,
    setFilter,
    view,
    optionThreads: all.data?.threads ?? [],
    totalMessages: all.data?.totalMessages ?? 0,
    error: current.error,
    retry: current.reload,
  };
}
