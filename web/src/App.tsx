import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { api } from './api';
import { formatCost } from './cost';
import type { AppConfig, Cost, Task, Workspace } from './types';
import type { Epic } from './epic-model';
import { Board } from './components/Board';
import { HeaderStatusBar } from './components/HeaderStatusBar';
import { NavRail } from './components/NavRail';
import { boardSections } from './board-sections-model';
import { TaskForm } from './components/TaskForm';
import { TicketPage } from './components/TicketPage';
import { EpicPage } from './components/EpicPage';
import { subscribe } from './ws';
import { debounce } from './debounce';
import { useLiveEffect } from './useLiveEffect';
import { Login } from './components/Login';
import { ApiPage } from './components/ApiPage';
import { StatsPage } from './components/StatsPage';
import { OperationsPage } from './components/OperationsPage';
import { SettingsPage } from './components/SettingsPage';
import { TableView } from './components/TableView';
import { ActivityView } from './components/ActivityView';
import { BrandMark } from './components/BrandMark';
import { Icon } from './components/Icon';
import { ConversationLauncher } from './components/ConversationLauncher';
import { NewWorkspaceForm, WorkspaceSwitcher } from './components/WorkspaceSwitcher';
import { WorkspaceSettingsPage } from './components/WorkspaceSettingsPage';
import { EmptyState } from './components/EmptyState';
import { VIEW_LABELS, isWorkspaceScopedView, loadRailCollapsed, storeRailCollapsed } from './rail-model';
import { CrumbBar } from './components/CrumbBar';
import type { View } from './rail-model';
import { NO_SELECTION, parseRoute, serializeRoute, type Route, type TableFilters } from './router-model';
import {
  hasNoWorkspaces,
  loadActiveWorkspaceId,
  resolveActiveWorkspace,
  storeActiveWorkspaceId,
} from './workspace-model';
import { applyTheme, loadTheme, nextTheme, storeTheme, type ThemePref } from './theme';
import {
  loadDismissed,
  shouldShowEscalationHint,
  shouldShowRunHint,
  storeDismissed,
  RUN_HINT_DISMISSED_KEY,
  ESCALATION_HINT_DISMISSED_KEY,
} from './onboarding-model';
import { btnPrimary, btnQuiet } from './ui';
import { Toaster, toastError } from './toast';
import { ReviewLiveRegions } from './components/ReviewLiveRegions';
import {
  advanceReviewAnnouncements,
  EMPTY_REVIEW_ANNOUNCEMENT_CURSOR,
  type ReviewAnnouncementCursor,
} from './review-announce-model';

const GraphView = lazy(() => import('./components/GraphView').then((m) => ({ default: m.GraphView })));

// Mirrors --breakpoint-rail (index.css): collapsed-only a11y attributes
// must not leak into the mobile drawer, so JS needs the same threshold.
const RAIL_QUERY = '(min-width: 900px)';
function useRailBreakpoint() {
  return useSyncExternalStore(
    (onChange) => {
      const mq = matchMedia(RAIL_QUERY);
      mq.addEventListener('change', onChange);
      return () => mq.removeEventListener('change', onChange);
    },
    () => matchMedia(RAIL_QUERY).matches,
  );
}

function useRoute(): [Route, (next: Route, opts?: { replace?: boolean }) => void] {
  const [route, setRoute] = useState<Route>(() =>
    parseRoute(window.location.pathname, window.location.search),
  );
  useEffect(() => {
    const canonical = serializeRoute(parseRoute(window.location.pathname, window.location.search));
    if (canonical !== `${window.location.pathname}${window.location.search}`) {
      window.history.replaceState(null, '', canonical);
    }
    const onPop = () => setRoute(parseRoute(window.location.pathname, window.location.search));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const navigate = useCallback((next: Route, opts?: { replace?: boolean }) => {
    const url = serializeRoute(next);
    if (url === `${window.location.pathname}${window.location.search}`) {
      setRoute(next);
      return;
    }
    if (opts?.replace) window.history.replaceState(null, '', url);
    else window.history.pushState(null, '', url);
    setRoute(next);
  }, []);
  return [route, navigate];
}

const BOARD_PAGE = 100;
async function fetchOpenTasks(workspaceId: number): Promise<Task[]> {
  const all: Task[] = [];
  for (let offset = 0; ; offset += BOARD_PAGE) {
    const { tasks, total } = await api.tasks({ workspaceId, state: 'open', limit: BOARD_PAGE, offset });
    all.push(...tasks);
    if (tasks.length === 0 || all.length >= total) return all;
  }
}

async function fetchAllEpics(workspaceId: number): Promise<Epic[]> {
  const all: Epic[] = [];
  for (let offset = 0; ; offset += BOARD_PAGE) {
    const { epics, total } = await api.epics(workspaceId, { limit: BOARD_PAGE, offset });
    all.push(...epics);
    if (epics.length === 0 || all.length >= total) return all;
  }
}

function usePeriodCost(authed: boolean, tasks: Task[] | null, workspaceId: number | null) {
  const [cost, setCost] = useState<Cost | null>(null);
  const taskListSignature = tasks ? `${tasks.length}:${tasks.filter((t) => t.state === 'working').length}` : '';
  const refresh = useRef<(() => void) | null>(null);
  const signatureSettled = useRef(false);
  useLiveEffect((live) => {
    if (!authed || workspaceId === null) {
      refresh.current = null;
      return;
    }
    const load = () => {
      const to = Date.now();
      fetch(`/api/stats?from=${to - 24 * 3600_000}&to=${to}&workspaceId=${workspaceId}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((s: { cost: Cost | null } | null) => live() && s && setCost(s.cost))
        .catch(() => {});
    };
    const debounced = debounce(load, 1000);
    refresh.current = debounced;
    signatureSettled.current = false;
    load();
    const timer = setInterval(load, 60_000);
    return () => {
      clearInterval(timer);
      debounced.cancel();
      refresh.current = null;
    };
  }, [authed, workspaceId]);
  useEffect(() => {
    if (!signatureSettled.current) {
      signatureSettled.current = true;
      return;
    }
    refresh.current?.();
  }, [taskListSignature]);
  return cost;
}

export function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [passwordSet, setPasswordSet] = useState(true);
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspacesLoaded, setWorkspacesLoaded] = useState(false);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<number | null>(() =>
    loadActiveWorkspaceId(localStorage),
  );
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);
  const [editing, setEditing] = useState<Task | 'new' | null>(null);
  const [fetchedTask, setFetchedTask] = useState<Task | null>(null);
  const [epics, setEpics] = useState<Epic[]>([]);
  const [route, navigate] = useRoute();
  const view = route.view;
  const routeRef = useRef(route);
  // eslint-disable-next-line react/refs -- latest-route ref, deliberately synced during render so the ws handler reads it without re-subscribing
  routeRef.current = route;
  const fetchedTaskIdRef = useRef<number | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState(() => loadRailCollapsed(localStorage));
  const [theme, setTheme] = useState<ThemePref>(() => loadTheme(localStorage));
  const railDesktop = useRailBreakpoint();
  const [error, setError] = useState<string | null>(null);
  const [runHintDismissed, setRunHintDismissed] = useState(() =>
    loadDismissed(localStorage, RUN_HINT_DISMISSED_KEY),
  );
  const [escalationHintDismissed, setEscalationHintDismissed] = useState(() =>
    loadDismissed(localStorage, ESCALATION_HINT_DISMISSED_KEY),
  );
  const [refreshingTracker, setRefreshingTracker] = useState(false);

  useEffect(() => {
    applyTheme(document.documentElement, theme);
  }, [theme]);

  useEffect(() => {
    fetch('/api/auth/me')
      .then((r) => r.json())
      .then((me: { authenticated: boolean; passwordConfigured: boolean }) => {
        setPasswordSet(me.passwordConfigured);
        setAuthed(me.authenticated || !me.passwordConfigured);
      })
      .catch(() => setAuthed(false));
  }, []);

  const failStreak = useRef(0);
  const refresh = useCallback(async () => {
    if (activeWorkspaceId === null) return;
    try {
      const tasks = await fetchOpenTasks(activeWorkspaceId);
      setTasks(tasks);
      failStreak.current = 0;
      setError(null);
    } catch (e) {
      failStreak.current += 1;
      if (failStreak.current >= 2) setError(e instanceof Error ? e.message : String(e));
    }
  }, [activeWorkspaceId]);

  const refreshEpics = useCallback(async () => {
    if (activeWorkspaceId === null) return;
    try {
      setEpics(await fetchAllEpics(activeWorkspaceId));
    } catch {
    }
  }, [activeWorkspaceId]);

  useEffect(() => {
    if (!authed) return;
    api.config().then(setConfig).catch(() => {});
    api.workspaces().then(({ workspaces }) => {
      setWorkspaces(workspaces);
      setWorkspacesLoaded(true);
      const active = resolveActiveWorkspace(workspaces, loadActiveWorkspaceId(localStorage));
      if (active) setActiveWorkspaceId(active.id);
    }, toastError);
  }, [authed]);

  useEffect(() => {
    if (!authed || activeWorkspaceId === null) return;
    refresh();
    refreshEpics();
    const debouncedRefreshEpics = debounce(refreshEpics, 250);
    const unsubscribe = subscribe((msg) => {
      if (msg.type === 'task_changed' && msg.task.workspaceId === activeWorkspaceId) {
        setTasks((current) => {
          const rest = (current ?? []).filter((t) => t.id !== msg.task.id);
          return [...rest, msg.task];
        });
        setFetchedTask((current) =>
          current?.id === msg.task.id || routeRef.current.task === msg.task.id ? msg.task : current,
        );
        debouncedRefreshEpics();
      }
      if (msg.type === 'task_removed') {
        setTasks((current) => (current ?? []).filter((t) => t.id !== msg.id));
        setFetchedTask((current) => (current && current.id === msg.id ? null : current));
        if (routeRef.current.task === msg.id) {
          navigate({ ...routeRef.current, task: null, panel: NO_SELECTION }, { replace: true });
        }
      }
    });
    const timer = setInterval(() => {
      refresh();
      refreshEpics();
    }, 10_000);
    return () => {
      unsubscribe();
      clearInterval(timer);
      debouncedRefreshEpics.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `view`/`navigate` intentionally excluded; subscribe once per Workspace, routeRef carries the latest route to the handler
  }, [refresh, refreshEpics, authed, activeWorkspaceId]);

  const periodCost = usePeriodCost(authed === true, tasks, activeWorkspaceId);

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
    api.task(route.task).then((t) => live() && setFetchedTask(t), toastError);
  }, [route.task, tasks]);

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

  // A Ticket deep-link (a Board/Table/Graph row, a child-task link on the Epic
  // page): navigate to /task/:id, clearing any focused Epic so the two pathname
  // surfaces stay mutually exclusive (ADR-0017).
  const openTaskById = (taskId: number) => navigate({ ...route, task: taskId, epic: null, panel: NO_SELECTION });
  // A Board/Table/Graph row's click target — the one seam every surface's
  // `onOpen(task)` shares, so a row always opens the same /task/:id route.
  const openRow = (t: Task) => openTaskById(t.id);
  // An Epic's click target (ADR-0017): the Tasks-list Epic row, the Board band
  // header, and a Ticket's parent-Epic breadcrumb all open the Epic summary page
  // at /epic/:ref, clearing any focused Ticket.
  const openEpicByRef = (ref: number) => navigate({ ...route, epic: ref, task: null, panel: NO_SELECTION });

  const activeWorkspaceName =
    workspaces.find((w) => w.id === activeWorkspaceId)?.name ?? null;
  const instanceName = config?.name?.trim() ? config.name.trim() : 'Harmonic';
  useEffect(() => {
    const parts = ['Harmonic'];
    if (config?.name?.trim()) parts.push(config.name.trim());
    if (activeWorkspaceName) parts.push(activeWorkspaceName);
    document.title = parts.join(' - ');
  }, [config?.name, activeWorkspaceName]);

  if (authed === null) return null;
  if (!authed) return <Login onLoggedIn={() => setAuthed(true)} />;

  const taskList = tasks ?? [];
  const noWorkspaces = hasNoWorkspaces(workspaces, workspacesLoaded);
  const showWorkspaceEmptyState = noWorkspaces && isWorkspaceScopedView(view);
  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId) ?? null;
  const runningCount = taskList.filter((t) => t.state === 'working').length;
  const cost24h = formatCost(periodCost);

  const showRunHint =
    view === 'board' && !!config && shouldShowRunHint(taskList, config.autoRunner, runHintDismissed);
  const dismissRunHint = () => {
    storeDismissed(localStorage, RUN_HINT_DISMISSED_KEY);
    setRunHintDismissed(true);
  };
  const showEscalationHint = view === 'board' && shouldShowEscalationHint(taskList, escalationHintDismissed);
  const dismissEscalationHint = () => {
    storeDismissed(localStorage, ESCALATION_HINT_DISMISSED_KEY);
    setEscalationHintDismissed(true);
  };

  const pickView = (v: View) => {
    navigate({ ...route, view: v, task: null, epic: null, panel: NO_SELECTION });
    setMenuOpen(false);
  };


  const setTableFilters = (table: TableFilters) => navigate({ ...route, table }, { replace: true });

  const toggleRail = () => {
    const next = !railCollapsed;
    setRailCollapsed(next);
    storeRailCollapsed(localStorage, next);
  };

  const cycleTheme = () => {
    const next = nextTheme(theme);
    setTheme(next);
    storeTheme(localStorage, next);
  };

  const refreshTracker = () => {
    if (activeWorkspaceId === null || refreshingTracker) return;
    setRefreshingTracker(true);
    api
      .refreshTracker(activeWorkspaceId)
      .then(refresh, toastError)
      .finally(() => setRefreshingTracker(false));
  };

  const switchWorkspace = (id: number) => {
    setActiveWorkspaceId(id);
    storeActiveWorkspaceId(localStorage, id);
    setTasks(null);
    setEpics([]);
  };

  const handleWorkspaceCreated = (w: Workspace) => {
    setWorkspaces((current) => [...current, w]);
    switchWorkspace(w.id);
  };

  const handleWorkspaceSaved = (updated: Workspace) => {
    setWorkspaces((current) => current.map((w) => (w.id === updated.id ? updated : w)));
    refresh();
  };

  const handleWorkspaceDeleted = (id: number) => {
    const remaining = workspaces.filter((w) => w.id !== id);
    setWorkspaces(remaining);
    if (id === activeWorkspaceId) {
      const next = remaining[0];
      if (next) {
        switchWorkspace(next.id);
      } else {
        setActiveWorkspaceId(null);
        setTasks(null);
        setEpics([]);
      }
    }
    // Programmatic redirect off the deleted Workspace's page, not a place the
    // operator chose to visit — replace, no history entry.
    navigate({ ...route, view: 'board', task: null, panel: NO_SELECTION }, { replace: true });
  };

  return (
    <div className="flex h-screen flex-col overflow-hidden rail:flex-row">
      <ReviewLiveRegions polite={politeReviewAnnouncement} assertive={assertiveMergeAnnouncement} />
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:inline-flex focus:min-h-11 focus:items-center focus:rounded-md focus:bg-surface focus:px-4 focus:font-medium focus:text-ink focus:shadow-card"
      >
        Skip to content
      </a>
      <aside
        className={`shrink-0 border-b border-hairline bg-shell rail:flex rail:flex-col rail:overflow-hidden rail:border-b-0 rail:border-r rail:transition-[width] rail:duration-150 rail:ease-out motion-reduce:rail:transition-none ${
          railCollapsed ? 'rail:w-12' : 'rail:w-[200px]'
        }`}
      >
        <div
          className={`flex items-center gap-2.5 px-4 py-3 rail:px-3 rail:pb-5 ${railCollapsed ? 'rail:justify-center rail:px-0' : ''}`}
        >
          <BrandMark />
          <span
            className={`whitespace-nowrap font-display text-title font-display-weight tracking-tight ${railCollapsed ? 'rail:hidden' : ''}`}
          >
            {instanceName}
          </span>
          {railCollapsed && <span className="sr-only">{instanceName}</span>}
          <button
            aria-expanded={menuOpen}
            aria-label="Menu"
            className="ml-auto inline-flex min-h-11 items-center rounded-md px-2.5 font-medium text-muted hover:text-ink rail:hidden"
            onClick={() => setMenuOpen((open) => !open)}
          >
            Menu
          </button>
        </div>
        <div className={`px-4 pb-3 rail:px-3 ${railCollapsed ? 'rail:hidden' : ''}`}>
          <WorkspaceSwitcher
            workspaces={workspaces}
            activeId={activeWorkspaceId}
            onSwitch={switchWorkspace}
            onCreated={handleWorkspaceCreated}
          />
        </div>
        <div
          className={`${menuOpen ? 'flex' : 'hidden'} flex-col gap-0.5 overflow-y-auto border-t border-hairline p-2 rail:flex rail:flex-1 rail:border-t-0 rail:pt-0 ${
            railCollapsed ? 'rail:px-1.5' : ''
          }`}
        >
          <NavRail
            view={view}
            needsYouCount={needsYouCount}
            railCollapsed={railCollapsed}
            railDesktop={railDesktop}
            onPickView={pickView}
            onToggleRail={toggleRail}
          />
        </div>
      </aside>

      <div className="group/shell flex min-h-0 min-w-0 flex-1 flex-col">
        <HeaderStatusBar
          config={config}
          runningCount={runningCount}
          cost24h={cost24h}
          theme={theme}
          view={view}
          passwordSet={passwordSet}
          onAutoRunnerChange={(enabled) =>
            api.updateConfig({ autoRunner: { enabled } }).then(setConfig, toastError)
          }
          onThemeCycle={cycleTheme}
          onSettingsClick={() => pickView('settings')}
          onLogout={() => fetch('/api/auth/logout', { method: 'POST' }).then(() => setAuthed(false))}
          onNewTask={() => setEditing('new')}
        />

        <Toaster />

        <div className="relative min-h-0 flex-1">
          {route.epic !== null && activeWorkspaceId !== null ? (
            <EpicPage
              epicRef={route.epic}
              workspaceId={activeWorkspaceId}
              onClose={() => navigate({ ...route, epic: null, panel: NO_SELECTION }, { replace: true })}
              onOpenTask={openTaskById}
              selection={route.panel}
              onSelect={(panel) => navigate({ ...route, panel })}
            />
          ) : openTask ? (
            <TicketPage
              task={openTask}
              onEdit={setEditing}
              onChanged={refresh}
              onClose={() => navigate({ ...route, task: null, panel: NO_SELECTION }, { replace: true })}
              onOpenTask={openTaskById}
              selection={route.panel}
              onSelect={(panel) => navigate({ ...route, panel })}
              onOpenEpic={openEpicByRef}
              parentEpicRef={epics.find((e) => e.members.some((m) => m.taskId === openTask.id))?.ref ?? null}
              error={error}
            />
          ) : (
            <div className="flex h-full flex-col">
              {!showWorkspaceEmptyState && view !== 'settings' && (
                <CrumbBar
                  className="shrink-0"
                  crumbs={
                    view === 'board'
                      ? [{ node: <span className="font-semibold text-ink">{activeWorkspaceName ?? instanceName}</span> }]
                      : [
                          {
                            node: <span className="font-semibold text-ink">{activeWorkspaceName ?? instanceName}</span>,
                            onClick: () => pickView('board'),
                          },
                          { node: <span className="text-ink">{VIEW_LABELS[view]}</span> },
                        ]
                  }
                  right={
                    view === 'board' && activeWorkspace?.trackerEnabled ? (
                      <button
                        className={`${btnQuiet} inline-flex items-center gap-1.5 rounded-md border border-hairline px-2.5 py-1.5 text-muted hover:bg-raised hover:text-ink disabled:opacity-60`}
                        disabled={refreshingTracker}
                        title="Rescan the tracker and mirror ticket changes now"
                        onClick={refreshTracker}
                      >
                        <Icon name="refresh" className={refreshingTracker ? 'motion-safe:animate-spin' : ''} />
                        {refreshingTracker ? 'Refreshing…' : 'Refresh tickets'}
                      </button>
                    ) : undefined
                  }
                />
              )}
              {error && (
                <div role="alert" className="mx-6 mt-4 shrink-0 rounded-lg bg-fail-tint px-4 py-2 text-fail">
                  {error}
                </div>
              )}
              {showRunHint && (
                <div className="mx-6 mt-4 flex shrink-0 items-start gap-3 rounded-lg bg-raised px-4 py-2.5 text-small">
                  <span
                    aria-hidden="true"
                    className="mt-1 size-1.5 shrink-0 rounded-full bg-ready-dot"
                  />
                  <p className="flex-1 text-muted">
                    Your first task is ready, but nothing's running it yet. Press{' '}
                    <span className="font-semibold text-ink">Run now</span> on the card, or turn the{' '}
                    <span className="font-semibold text-ink">Auto-runner</span> on above.
                  </p>
                  <button className={`${btnQuiet} shrink-0`} onClick={dismissRunHint}>
                    Dismiss
                  </button>
                </div>
              )}
              {showEscalationHint && (
                <div className="mx-6 mt-4 flex shrink-0 items-start gap-3 rounded-lg bg-raised px-4 py-2.5 text-small">
                  <span aria-hidden="true" className="mt-1 size-1.5 shrink-0 rounded-full bg-await-dot" />
                  <p className="flex-1 text-muted">
                    A ticket is escalated. Open it to read why and the changes so far, then{' '}
                    <span className="font-semibold text-ink">Accept</span> to merge as-is,{' '}
                    <span className="font-semibold text-ink">Reject</span> with guidance for the next attempt, or{' '}
                    <span className="font-semibold text-ink">Close</span> it — the one decision agents don't take for you.
                  </p>
                  <button className={`${btnQuiet} shrink-0`} onClick={dismissEscalationHint}>
                    Dismiss
                  </button>
                </div>
              )}
              <main
                id="main-content"
                tabIndex={-1}
                className="min-h-0 min-w-0 flex-1 overflow-y-auto px-6 pt-5 pb-16"
              >
                {showWorkspaceEmptyState ? (
                  <EmptyState
                    title="No workspace open"
                    className="mt-24"
                    action={
                      <button className={btnPrimary} onClick={() => setCreatingWorkspace(true)}>
                        Open a workspace
                      </button>
                    }
                  >
                    A workspace points Harmonic at a project directory — its tasks, runs, and cost all
                    scope to it. Open one to get started.
                  </EmptyState>
                ) : (
                  <>
                    {view === 'board' && (
                      <Board
                        tasks={taskList}
                        loading={tasks === null}
                        epics={epics}
                        onOpen={openRow}
                        onOpenTask={openTaskById}
                        onChanged={refresh}
                        onNewTask={() => setEditing('new')}
                        onOpenEpic={(epic) => openEpicByRef(epic.ref)}
                      />
                    )}
                  {view === 'activity' && <ActivityView config={config} />}
                  {view === 'table' && (
                    <TableView
                      workspaceId={activeWorkspaceId}
                      onOpen={openRow}
                      onOpenEpic={openEpicByRef}
                      filters={route.table}
                      onFiltersChange={setTableFilters}
                    />
                  )}
                  {view === 'graph' && (
                    <Suspense
                      fallback={
                        <div className="flex h-full items-center justify-center text-muted">Loading graph…</div>
                      }
                    >
                      <GraphView workspaceId={activeWorkspaceId} onOpen={openRow} />
                    </Suspense>
                  )}
                  {view === 'stats' && <StatsPage workspaceId={activeWorkspaceId} />}
                  {view === 'operations' && <OperationsPage />}
                  {view === 'api' && <ApiPage />}
                  {view === 'settings' && <SettingsPage onSaved={setConfig} />}
                  {view === 'workspace' && config && activeWorkspace && (
                    <WorkspaceSettingsPage
                      workspace={activeWorkspace}
                      config={config}
                      blockedByRunningTask={runningCount > 0}
                      onSaved={handleWorkspaceSaved}
                      onDeleted={handleWorkspaceDeleted}
                    />
                  )}
                  </>
                )}
              </main>
            </div>
          )}

          {!noWorkspaces && (
            <ConversationLauncher
              config={config}
              workspace={workspaces.find((w) => w.id === activeWorkspaceId) ?? null}
            />
          )}
        </div>
      </div>

      {creatingWorkspace && (
        <NewWorkspaceForm
          onClose={() => setCreatingWorkspace(false)}
          onCreated={handleWorkspaceCreated}
        />
      )}

      {editing !== null && config && (
        <TaskForm
          config={config}
          task={editing === 'new' ? null : editing}
          workspace={activeWorkspace}
          workspaceId={activeWorkspaceId}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}
