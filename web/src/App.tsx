import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { api } from './api';
import { formatCost } from './cost';
import type { AppConfig, Cost, Task, Workspace } from './types';
import { Board } from './components/Board';
import { TaskForm } from './components/TaskForm';
import { TaskDetail } from './components/TaskDetail';
import { subscribe } from './ws';
import { Login } from './components/Login';
import { ApiPage } from './components/ApiPage';
import { StatsPage } from './components/StatsPage';
import { SettingsPage } from './components/SettingsPage';
import { TableView } from './components/TableView';
import { GraphView } from './components/GraphView';
import { ActivityView } from './components/ActivityView';
import { BrandMark } from './components/BrandMark';
import { Icon, type IconName } from './components/Icon';
import { Switch } from './components/Switch';
import { ConversationLauncher } from './components/ConversationLauncher';
import { NewWorkspaceForm, WorkspaceSwitcher } from './components/WorkspaceSwitcher';
import { WorkspaceSettingsPage } from './components/WorkspaceSettingsPage';
import { EmptyState } from './components/EmptyState';
import { RAIL_VIEWS, VIEW_LABELS, isWorkspaceScopedView, loadRailCollapsed, storeRailCollapsed } from './rail-model';
import type { View } from './rail-model';
import {
  hasNoWorkspaces,
  loadActiveWorkspaceId,
  resolveActiveWorkspace,
  storeActiveWorkspaceId,
} from './workspace-model';
import { applyTheme, loadTheme, nextTheme, storeTheme, type ThemePref } from './theme';
import {
  loadDismissed,
  shouldShowReviewHint,
  shouldShowRunHint,
  storeDismissed,
  RUN_HINT_DISMISSED_KEY,
  REVIEW_HINT_DISMISSED_KEY,
} from './onboarding-model';
import { btnPrimary, btnQuiet, touchTarget } from './ui';
import { Toaster, toastError } from './toast';

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

// Collapse only applies at the rail breakpoint; the mobile drawer always
// shows icon + label, so collapsed styles are rail:-prefixed throughout.
// Active is the sidebar's only accent: a cobalt tint under cobalt text.
const railItem = (active: boolean, collapsed: boolean) =>
  `flex w-full min-h-11 items-center gap-2.5 overflow-hidden whitespace-nowrap rounded-md px-2.5 py-2 text-left transition-colors duration-150 ${
    collapsed ? 'rail:justify-center rail:px-0' : ''
  } ${active ? 'bg-accent-tint font-semibold text-accent' : 'font-medium text-muted hover:bg-raised hover:text-ink'}`;

const THEME_ICONS: Record<ThemePref, IconName> = {
  system: 'circle-half',
  light: 'sun',
  dark: 'moon',
};
const THEME_LABELS: Record<ThemePref, string> = {
  system: 'Theme: System',
  light: 'Theme: Light',
  dark: 'Theme: Dark',
};

/** Cost over the trailing 24h, scoped to the active Workspace — the status strip's period cost. */
function usePeriodCost(authed: boolean, tasks: Task[] | null, workspaceId: number | null) {
  const [cost, setCost] = useState<Cost | null>(null);
  // Runs finishing move cost, and every finish changes the running count;
  // together with the task count this catches the transitions that matter.
  const shape = tasks ? `${tasks.length}:${tasks.filter((t) => t.state === 'running').length}` : '';
  useEffect(() => {
    if (!authed || workspaceId === null) return;
    let live = true;
    const load = () => {
      const to = Date.now();
      fetch(`/api/stats?from=${to - 24 * 3600_000}&to=${to}&workspaceId=${workspaceId}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((s: { cost: Cost | null } | null) => live && s && setCost(s.cost))
        .catch(() => {}); // status readout only — never worth an alert
    };
    load();
    const timer = setInterval(load, 60_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [authed, shape, workspaceId]);
  return cost;
}

export function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  // False when no operator password is set: the app is ungated, so there's no
  // login screen and no logout affordance.
  const [passwordSet, setPasswordSet] = useState(true);
  // null = first load still in flight; lets the board tell "loading" from "no tasks yet".
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  // Distinguishes the pre-load `[]` from a genuinely empty list, so the
  // no-workspace empty state (#68) never flashes over the board before the
  // first fetch resolves.
  const [workspacesLoaded, setWorkspacesLoaded] = useState(false);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<number | null>(() =>
    loadActiveWorkspaceId(localStorage),
  );
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);
  const [editing, setEditing] = useState<Task | 'new' | null>(null);
  const [openTask, setOpenTask] = useState<Task | null>(null);
  const [view, setView] = useState<View>('board');
  const [menuOpen, setMenuOpen] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState(() => loadRailCollapsed(localStorage));
  const [theme, setTheme] = useState<ThemePref>(() => loadTheme(localStorage));
  const railDesktop = useRailBreakpoint();
  const [error, setError] = useState<string | null>(null);
  const [runHintDismissed, setRunHintDismissed] = useState(() =>
    loadDismissed(localStorage, RUN_HINT_DISMISSED_KEY),
  );
  const [reviewHintDismissed, setReviewHintDismissed] = useState(() =>
    loadDismissed(localStorage, REVIEW_HINT_DISMISSED_KEY),
  );
  // A manual tracker refresh is in flight — disables the board's Refresh control
  // and spins its icon until the rescan + mirror settle.
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

  // Workspace scoping (ADR-0008): board/table/stats and the status strip only
  // ever see the active Workspace's Tasks — undefined while workspaces
  // haven't loaded yet keeps refresh() a no-op rather than fetching unscoped.
  // The 10s poll runs unattended, so a single blip (a proxy hiccup, a
  // truncated body — the very failures api.request() now throws on instead of
  // returning null) must not clobber the board or flash a scary banner. Keep
  // the last-good tasks and only surface the error once failures persist across
  // consecutive polls; one recovered poll wipes the streak clean.
  const failStreak = useRef(0);
  const refresh = useCallback(async () => {
    if (activeWorkspaceId === null) return;
    try {
      const { tasks } = await api.tasks(activeWorkspaceId);
      setTasks(tasks);
      // Keep an open detail modal fresh from the poll too, not only the
      // socket — otherwise its state-aware footer can go stale (and keep
      // offering Accept on an already-completed task) if the ws drops.
      setOpenTask((current) => (current ? tasks.find((t) => t.id === current.id) ?? current : current));
      failStreak.current = 0;
      setError(null);
    } catch (e) {
      // Tolerate one transient failure; surface only a sustained outage so a
      // lone glitch never overwrites a working board with an error banner.
      failStreak.current += 1;
      if (failStreak.current >= 2) setError(e instanceof Error ? e.message : String(e));
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
    // Live updates over WebSocket; slow polling as a reconnect safety net.
    // The active Workspace can't change out from under this subscription's
    // closure (each switch re-subscribes via the activeWorkspaceId dep), so
    // filtering task_changed by workspaceId here is enough — no separate
    // "did the Workspace change" check needed.
    const unsubscribe = subscribe((msg) => {
      if (msg.type === 'task_changed' && msg.task.workspaceId === activeWorkspaceId) {
        setTasks((current) => {
          const rest = (current ?? []).filter((t) => t.id !== msg.task.id);
          return [...rest, msg.task];
        });
        setOpenTask((current) => (current && current.id === msg.task.id ? msg.task : current));
      }
    });
    const timer = setInterval(refresh, 10_000);
    return () => {
      unsubscribe();
      clearInterval(timer);
    };
  }, [refresh, authed, activeWorkspaceId]);

  const periodCost = usePeriodCost(authed === true, tasks, activeWorkspaceId);

  // Browser tab title: `Harmonic - {name} - {workspace}`. The instance name is
  // dropped when unset and the workspace when none has resolved yet, so an
  // unnamed single-workspace instance still reads a clean "Harmonic".
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
  // Zero Workspaces (first launch, or after deleting the last one) → a
  // full-screen invitation to create one, never a board stuck on "loading"
  // because there's no active Workspace to fetch Tasks for (issue #68). Only
  // the Workspace-scoped views yield to it; Activity/API/Settings need no
  // Workspace and stay reachable on a fresh instance.
  const noWorkspaces = hasNoWorkspaces(workspaces, workspacesLoaded);
  const showWorkspaceEmptyState = noWorkspaces && isWorkspaceScopedView(view);
  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId) ?? null;
  const runningCount = taskList.filter((t) => t.state === 'running').length;
  const cost24h = formatCost(periodCost);

  // The one cold-start bridge: a ready task won't start on its own while the
  // auto-runner is off, so point at the fix until the first run is seen. Once a
  // task reaches review the run hint retires and the review hint takes over —
  // the two never show at once (see onboarding-model).
  const showRunHint =
    view === 'board' && !!config && shouldShowRunHint(taskList, config.autoRunner, runHintDismissed);
  const dismissRunHint = () => {
    storeDismissed(localStorage, RUN_HINT_DISMISSED_KEY);
    setRunHintDismissed(true);
  };
  const showReviewHint = view === 'board' && shouldShowReviewHint(taskList, reviewHintDismissed);
  const dismissReviewHint = () => {
    storeDismissed(localStorage, REVIEW_HINT_DISMISSED_KEY);
    setReviewHintDismissed(true);
  };

  const pickView = (v: View) => {
    setView(v);
    setMenuOpen(false);
  };

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

  // Force a tracker re-poll now (rescan the repo + mirror), then re-fetch the
  // board so mirrored changes land immediately instead of on the next interval.
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
    setTasks(null); // "loading", not a flash of the old Workspace's (now stale) board
  };

  // One "a Workspace was created" flow for both entry points (the switcher's +
  // and the empty state): append it and make it active, which switches away
  // from the empty state onto the new Workspace's board.
  const handleWorkspaceCreated = (w: Workspace) => {
    setWorkspaces((current) => [...current, w]);
    switchWorkspace(w.id);
  };

  // A Workspace edited on its settings page (#64): replace it in the list so the
  // switcher name and the tab title pick up a rename immediately.
  const handleWorkspaceSaved = (updated: Workspace) => {
    setWorkspaces((current) => current.map((w) => (w.id === updated.id ? updated : w)));
    // A changed Workspace default (harness/model/…) re-resolves every board
    // Task that inherits it (ADR-0012), so pull the freshly-resolved values now
    // rather than waiting on the 10s poll.
    refresh();
  };

  // Deleting from the Workspace page (#64): drop it, then land on the board of
  // the next Workspace — or, if it was the last, on the empty state (#68).
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
      }
    }
    setView('board');
  };

  // Collapsed items keep their accessible name and gain a native tooltip;
  // when the label is visible neither is needed — below the breakpoint the
  // drawer shows labels, so the attributes must not apply there.
  const railItemName = (label: string) =>
    railCollapsed && railDesktop ? { 'aria-label': label, title: label } : {};

  // Hidden, not unmounted, when collapsed: keyboard order and focus
  // behavior stay identical in both widths.
  const railLabel = railCollapsed ? 'rail:hidden' : '';

  const navItems = (
    <>
      <nav aria-label="Views" className="flex flex-col gap-0.5 rail:flex-1">
        {RAIL_VIEWS.map((v) => (
          <button
            key={v}
            aria-current={view === v ? 'page' : undefined}
            {...railItemName(VIEW_LABELS[v])}
            className={railItem(view === v, railCollapsed)}
            onClick={() => pickView(v)}
          >
            <Icon name={v} />
            <span className={railLabel}>{VIEW_LABELS[v]}</span>
          </button>
        ))}
      </nav>
      {/* Desktop only: the nav's rail:flex-1 above pins this to the sidebar
          foot. Below the rail breakpoint the top drawer wins. */}
      <div className="mt-2 hidden border-t border-hairline pt-2 rail:flex rail:flex-col">
        <button
          aria-expanded={!railCollapsed}
          aria-label={railCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={railCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className={railItem(false, railCollapsed)}
          onClick={toggleRail}
        >
          <Icon className={railCollapsed ? '-scale-x-100' : ''} name="chevrons-left" />
          <span className={railLabel}>Collapse</span>
        </button>
      </div>
    </>
  );

  return (
    <div className="flex h-screen flex-col overflow-hidden rail:flex-row">
      {/* The sidebar: navigation lives here; above the working view is status only. */}
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
            className={`whitespace-nowrap font-display text-title font-bold tracking-tight ${railCollapsed ? 'rail:hidden' : ''}`}
          >
            {instanceName}
          </span>
          {railCollapsed && <span className="sr-only">{instanceName}</span>}
          <button
            aria-expanded={menuOpen}
            aria-label="Menu"
            className="ml-auto rounded-md px-2.5 py-1.5 font-medium text-muted hover:text-ink rail:hidden"
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
          {navItems}
        </div>
      </aside>

      <div className="group/shell flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 flex-wrap items-center gap-x-5 gap-y-2 border-b border-hairline bg-shell px-6 py-3">
          {config && (
            <Switch
              checked={config.autoRunner.enabled}
              label="Auto-runner"
              onChange={(enabled) =>
                api.updateConfig({ autoRunner: { enabled } }).then(setConfig, toastError)
              }
            >
              <span
                className="font-medium text-muted"
                title={`Machine Ceiling: ${config.autoRunner.maxConcurrentRuns}`}
              >
                Auto-runner
              </span>
            </Switch>
          )}
          {config && (
            <span className="flex items-center gap-2 text-muted">
              <span
                aria-hidden="true"
                className={`size-[7px] rounded-full ${runningCount > 0 ? 'bg-running' : 'bg-faint'}`}
              />
              <span>
                <span className={`font-semibold ${runningCount > 0 ? 'text-ink' : 'text-muted'}`}>
                  {runningCount}/{config.autoRunner.maxConcurrentRuns}
                </span>{' '}
                running
              </span>
            </span>
          )}
          {cost24h && (
            <span className="text-muted" title="Cost over the last 24 hours">
              <span className="font-semibold tabular-nums text-ink">{cost24h}</span> today
            </span>
          )}
          <div className="flex-1" />
          <button
            aria-label="Settings"
            aria-current={view === 'settings' ? 'page' : undefined}
            title="Settings"
            className={`${touchTarget} rounded-md transition-colors duration-150 ${
              view === 'settings' ? 'bg-accent-tint text-accent' : 'text-muted hover:bg-raised hover:text-ink'
            }`}
            onClick={() => pickView('settings')}
          >
            <Icon name="settings" />
          </button>
          <button
            aria-label={THEME_LABELS[theme]}
            title={THEME_LABELS[theme]}
            className={`${touchTarget} rounded-md text-muted transition-colors duration-150 hover:bg-raised hover:text-ink`}
            onClick={cycleTheme}
          >
            <Icon name={THEME_ICONS[theme]} />
          </button>
          {passwordSet && (
            <button
              aria-label="Log out"
              title="Log out"
              className={`${touchTarget} rounded-md text-muted transition-colors duration-150 hover:bg-raised hover:text-ink`}
              onClick={() => fetch('/api/auth/logout', { method: 'POST' }).then(() => setAuthed(false))}
            >
              <Icon name="logout" />
            </button>
          )}
          <button onClick={() => setEditing('new')} className={btnPrimary}>
            New task
          </button>
        </header>

        {/* Mounted here, not at the end of the return: the toast stack anchors
            itself to the header's bottom edge (see toast.tsx). */}
        <Toaster />

        {error && <div className="mx-6 mt-4 rounded-lg bg-fail-tint px-4 py-2 text-fail">{error}</div>}

        {showRunHint && (
          <div className="mx-6 mt-4 flex items-start gap-3 rounded-lg bg-raised px-4 py-2.5 text-small">
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

        {showReviewHint && (
          <div className="mx-6 mt-4 flex items-start gap-3 rounded-lg bg-raised px-4 py-2.5 text-small">
            <span aria-hidden="true" className="mt-1 size-1.5 shrink-0 rounded-full bg-accent" />
            <p className="flex-1 text-muted">
              A task is ready for review. Open it to read the changes, then{' '}
              <span className="font-semibold text-ink">Accept</span> to merge or{' '}
              <span className="font-semibold text-ink">Reject</span> with a reason — the review gate is
              the one step agents don't do for you.
            </p>
            <button className={`${btnQuiet} shrink-0`} onClick={dismissReviewHint}>
              Dismiss
            </button>
          </div>
        )}

        {/* The below-header region, and the Conversation's positioning
            context. The shell pins the header and scrolls only this, so the
            region's own top edge *is* the header's bottom edge at every
            viewport — which is what lets the docked panel inset off it
            without knowing the header's height. That height is not a
            constant to hardcode: the header sits at the viewport top on the
            rail, drops below the drawer under 900px, and wraps to two rows
            under ~520px (63 → 121 → 165px measured). */}
        <div className="relative min-h-0 flex-1">
          <main className="h-full min-w-0 overflow-y-auto px-6 py-5">
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
                  <>
                    {/* Manual tracker refresh — only when this Workspace mirrors a
                        tracker; otherwise there's nothing to re-poll. */}
                    {activeWorkspace?.trackerEnabled && (
                      <div className="mb-4 flex">
                        <button
                          className={`${btnQuiet} inline-flex items-center gap-1.5 rounded-md border border-hairline px-2.5 py-1.5 hover:bg-raised disabled:opacity-60`}
                          disabled={refreshingTracker}
                          title="Rescan the tracker and mirror ticket changes now"
                          onClick={refreshTracker}
                        >
                          <Icon
                            name="refresh"
                            className={refreshingTracker ? 'motion-safe:animate-spin' : ''}
                          />
                          {refreshingTracker ? 'Refreshing…' : 'Refresh tickets'}
                        </button>
                      </div>
                    )}
                    <Board
                      tasks={taskList}
                      loading={tasks === null}
                      onEdit={setEditing}
                      onOpen={setOpenTask}
                      onChanged={refresh}
                      onNewTask={() => setEditing('new')}
                    />
                  </>
                )}
                {view === 'activity' && <ActivityView config={config} />}
                {view === 'table' && <TableView workspaceId={activeWorkspaceId} onOpen={setOpenTask} />}
                {view === 'graph' && (
                  <GraphView tasks={taskList} loading={tasks === null} onOpen={setOpenTask} />
                )}
                {view === 'stats' && <StatsPage workspaceId={activeWorkspaceId} />}
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

          {!noWorkspaces && (
            <ConversationLauncher
              config={config}
              workspace={workspaces.find((w) => w.id === activeWorkspaceId) ?? null}
            />
          )}
        </div>
      </div>

      {openTask && (
        <TaskDetail
          task={openTask}
          onEdit={setEditing}
          onChanged={refresh}
          onClose={() => setOpenTask(null)}
        />
      )}

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
