import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '../api';
import { subscribe } from '../ws';
import { useLiveEffect } from '../useLiveEffect';
import { toastError } from '../toast';
import type { AppConfig, GuardrailEvent, Task, TicketTimelineEvent, Workspace } from '../types';

/** The api calls this hook depends on, injectable so tests can supply fakes
 * directly instead of stubbing global `fetch`. Defaults to the real `api`. */
export type TicketPageDataDeps = {
  loadAllTasks: () => Promise<{ tasks: Task[] }>;
  loadTask: (id: number) => Promise<Task>;
  loadTimeline: (id: number) => Promise<{ events: TicketTimelineEvent[] }>;
  loadConfig: () => Promise<AppConfig>;
  loadWorkspaces: () => Promise<{ workspaces: Workspace[] }>;
  loadGuardrailEvents: (attemptId: number) => Promise<{ guardrailEvents: GuardrailEvent[] }>;
};

const defaultDeps: TicketPageDataDeps = {
  loadAllTasks: api.tasks,
  loadTask: api.task,
  loadTimeline: api.taskTimeline,
  loadConfig: api.config,
  loadWorkspaces: api.workspaces,
  loadGuardrailEvents: api.attemptGuardrailEvents,
};

export type TicketPageData = {
  /** All Tasks, for resolving `dependsOn` labels in Properties. */
  allTasks: Task[];
  /** The full Task (richer than the list-derived `task` prop, e.g. `prompt`); null until loaded. */
  detail: Task | null;
  timelineEvents: TicketTimelineEvent[];
  maxAttempts: number | null;
  workspaceName: string | null;
  commandConfigured: boolean;
  guardrailEvents: GuardrailEvent[];
};

/**
 * The Ticket page's whole-Task data: the sibling Task list, the full Task
 * detail, the lifecycle timeline, the owning workspace's attempt/command
 * config, and the selected Attempt's guardrail events. Each loads on mount
 * and re-fetches on the relevant `ws` broadcast; the full Task detail also
 * live-patches from `task_changed` without a refetch.
 */
export function useTicketPageData(task: Task, selectedAttemptId: number | null, deps: TicketPageDataDeps = defaultDeps): TicketPageData {
  const [allTasks, setAllTasks] = useState<Task[]>([]);
  const [detail, setDetail] = useState<Task | null>(null);
  const [timelineEvents, setTimelineEvents] = useState<TicketTimelineEvent[]>([]);
  const [maxAttempts, setMaxAttempts] = useState<number | null>(null);
  const [workspaceName, setWorkspaceName] = useState<string | null>(null);
  const [commandConfigured, setCommandConfigured] = useState(true);
  const [guardrailEvents, setGuardrailEvents] = useState<GuardrailEvent[]>([]);

  // Read through a ref, same as useAsyncResource's loadRef: a caller-supplied
  // `deps` object has no referential-stability guarantee, so it can't sit in
  // these effects' dependency arrays without risking a re-render loop.
  const depsRef = useRef(deps);
  useLayoutEffect(() => {
    depsRef.current = deps;
  });

  useLiveEffect((live) => {
    depsRef.current.loadAllTasks().then(({ tasks }) => live() && setAllTasks(tasks), toastError);
  }, [task.id]);

  useLiveEffect((live) => {
    setDetail(null);
    depsRef.current.loadTask(task.id).then((full) => live() && setDetail(full), toastError);
  }, [task.id]);

  useLiveEffect((live) => {
    const load = () =>
      depsRef.current.loadTimeline(task.id).then(({ events: next }) => {
        if (live()) setTimelineEvents(next);
      }, toastError);
    load();
    const unsubscribe = subscribe((msg) => {
      if ((msg.type === 'attempt_timeline_changed' && msg.taskId === task.id) || (msg.type === 'attempt_changed' && msg.run.taskId === task.id)) load();
    }, load);
    return () => {
      unsubscribe();
    };
  }, [task.id]);

  useEffect(
    () =>
      subscribe((msg) => {
        if (msg.type === 'task_changed' && msg.task.id === task.id) setDetail(msg.task);
      }),
    [task.id],
  );

  useLiveEffect((live) => {
    Promise.all([depsRef.current.loadConfig(), depsRef.current.loadWorkspaces()]).then(([config, { workspaces }]) => {
      if (!live()) return;
      const workspace = workspaces.find((workspace) => workspace.id === task.workspaceId);
      setMaxAttempts(workspace?.maxAttempts ?? config.maxAttempts);
      setWorkspaceName(workspace?.name ?? null);
      setCommandConfigured((workspace?.taskPreMergeCommands ?? config.verify.task.preMerge.commands).length > 0);
    }, toastError);
  }, [task.workspaceId]);

  useLiveEffect((live) => {
    if (selectedAttemptId === null) {
      setGuardrailEvents([]);
      return;
    }
    const load = () =>
      depsRef.current.loadGuardrailEvents(selectedAttemptId).then(({ guardrailEvents }) => live() && setGuardrailEvents(guardrailEvents));
    load();
    const unsubscribe = subscribe((msg) => {
      if (msg.type === 'attempt_changed' && msg.run.id === selectedAttemptId) load();
    }, load);
    return () => {
      unsubscribe();
    };
  }, [selectedAttemptId]);

  return { allTasks, detail, timelineEvents, maxAttempts, workspaceName, commandConfigured, guardrailEvents };
}
