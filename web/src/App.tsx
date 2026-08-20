import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { api } from './api';
import { formatCost } from './cost';
import type { AppConfig, Cost, Task, Workspace } from './types';
import type { Epic, EpicLandOutcome } from './epic-model';
import { Deck } from './components/Deck';
import { deckSections } from './deck-model';
import { TaskForm } from './components/TaskForm';
import { TicketPage } from './components/TicketPage';
import { EpicPeek } from './components/EpicPeek';
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
import { RAIL_GROUPS, VIEW_LABELS, isWorkspaceScopedView, loadRailCollapsed, storeRailCollapsed } from './rail-model';
import type { View } from './rail-model';
import { parseRoute, serializeRoute, type Route, type TableFilters } from './router-model';
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
import { btnPrimary, btnQuiet, railBadge, sectionLabel, touchTarget } from './ui';
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

// Client routing (issue #103): the active view and its per-view filter/sort/
// peek state live in the URL, so a refresh restores where the operator was
// and Back steps between views instead of leaving the app. Pushes a history
// entry for real navigation and replaces for in-place param tweaks — see the
// callers below for which is which.
function useRoute(): [Route, (next: Route, opts?: { replace?: boolean }) => void] {
  const [route, setRoute] = useState<Route>(() =>
    parseRoute(window.location.pathname, window.location.search),
  );
  useEffect(() => {
    // Canonicalize a hand-edited or bookmarked URL on load (drop unknown params,
    // normalize order) so the no-op-navigation guard in navigate() can trust
    // window.location — otherwise re-selecting the active view would push a lone
    // canonicalization entry and cost a dead Back press. serializeRoute now
    // owns the whole path (pathname + query): the focused Ticket lives at
    // /task/:id, so we no longer prepend window.location.pathname to it.
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
    // Re-selecting the active view (or otherwise landing on the URL we're
    // already at) must not push a duplicate entry — that leaves a dead Back
    // press. Sync state without touching history when nothing moved.
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
  // The focused Ticket is the URL (route.task), not local state (issue #181):
  // a row opens /task/:id and Back returns to the Deck. `fetchedTask` only
  // caches a Task that isn't in the current Workspace's list (an EpicPeek
  // deep-link, a cross-Workspace id) so the derived `openTask` below can still
  // resolve it; a Task that IS in the list stays live off the poll/socket.
  const [fetchedTask, setFetchedTask] = useState<Task | null>(null);
  // Parallel-Epic read model (issue #167, ADR-0026): epics is the active
  // Workspace's derived Epic list; openEpic/focusEpic mirror openTask's
  // "which one is the operator looking at" pattern for the peek and the
  // Board's focus-mode respectively.
  const [epics, setEpics] = useState<Epic[]>([]);
  const [openEpic, setOpenEpic] = useState<Epic | null>(null);
  const [focusEpic, setFocusEpic] = useState<Epic | null>(null);
  const [route, navigate] = useRoute();
  const view = route.view;
  // Latest route for the ws subscription's task_removed handler, which lives
  // outside React's render scope and must not put `route` in its effect deps
  // (that would re-subscribe on every navigation).
  const routeRef = useRef(route);
  routeRef.current = route;
  // The last Ticket id we fired a not-in-list fetch for, so a 10s poll (which
  // hands `tasks` a fresh array reference) can't re-fire the fetch — and, on a
  // failing fetch, can't re-toast — every tick for a cross-Workspace deep link.
  const fetchedTaskIdRef = useRef<number | null>(null);
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
      // The open Ticket derives from this list (see `openTask` below), so the
      // poll keeps its state-aware footer fresh with no extra bookkeeping —
      // the list is refreshed here, the modal re-reads it.
      failStreak.current = 0;
      setError(null);
    } catch (e) {
      // Tolerate one transient failure; surface only a sustained outage so a
      // lone glitch never overwrites a working board with an error banner.
      failStreak.current += 1;
      if (failStreak.current >= 2) setError(e instanceof Error ? e.message : String(e));
    }
  }, [activeWorkspaceId]);

  // Parallel-Epic read model refetch (issue #167, ADR-0026: "the client
  // refetches on the existing task_changed firehose poke"). Best-effort — an
  // Epic-derivation blip is never worth the board's error banner the way a
  // Task-list failure is, so failures are swallowed rather than tracked in
  // failStreak. Keeps an open peek/focus-mode fresh by re-resolving them out
  // of the freshly-fetched list; either falls back to null if the Epic no
  // longer derives (e.g. it fully landed and dropped off the list).
  const refreshEpics = useCallback(async () => {
    if (activeWorkspaceId === null) return;
    try {
      const { epics } = await api.epics(activeWorkspaceId);
      setEpics(epics);
      setOpenEpic((current) => (current ? (epics.find((e) => e.ref === current.ref) ?? null) : current));
      setFocusEpic((current) => (current ? (epics.find((e) => e.ref === current.ref) ?? null) : current));
    } catch {
      // Soft-fail: see comment above.
    }
  }, [activeWorkspaceId]);

  // Force-land an Epic (issue #167, ADR-0026), used by the Board's focus-mode
  // header and the Table's group-by-Epic band headers; EpicPeek calls the API
  // directly since it already carries `workspaceId`. Refetches epics on any
  // outcome so the caller's toast/banner and the next render agree.
  const forceLandEpic = useCallback(
    async (epicRef: number): Promise<EpicLandOutcome> => {
      if (activeWorkspaceId === null) throw new Error('No active workspace');
      const outcome = await api.forceLandEpic(activeWorkspaceId, epicRef);
      refreshEpics();
      return outcome;
    },
    [activeWorkspaceId, refreshEpics],
  );

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
        // Keep the cached (not-in-list) open Ticket fresh from the socket too;
        // an in-list one refreshes via setTasks above.
        setFetchedTask((current) => (current && current.id === msg.task.id ? msg.task : current));
        // Keep the Epic peek + landing rail live (ADR-0026): a member's
        // task_changed is exactly the signal an Epic's fold/land/verification
        // state may have moved, so refetch alongside the Task-list update.
        refreshEpics();
      }
      // Hard-delete (issue #162): drop the Task from local state so the
      // board/graph lose it too — no workspaceId to filter on (the message
      // only carries the id), but filtering a Task that isn't in the current
      // Workspace's list is a no-op. Close the detail modal if it was open on
      // the deleted Task, rather than leaving it stranded on stale data.
      if (msg.type === 'task_removed') {
        setTasks((current) => (current ?? []).filter((t) => t.id !== msg.id));
        setFetchedTask((current) => (current && current.id === msg.id ? null : current));
        // If the focused Ticket's Task was hard-deleted, step back to the Deck
        // rather than stranding the URL on a dead /task/:id. Refs keep this out
        // of the subscription's deps so a navigation never re-subscribes the ws.
        if (routeRef.current.task === msg.id) {
          navigate({ ...routeRef.current, task: null }, { replace: true });
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
    };
  }, [refresh, refreshEpics, authed, activeWorkspaceId]);

  const periodCost = usePeriodCost(authed === true, tasks, activeWorkspaceId);

  // The focused Ticket (route.task), resolved to its Task: the live one from
  // the Workspace list when present, else the fetched cache. Deriving it (vs.
  // holding a copy in state) keeps one source of truth — the URL — so Back,
  // a bookmark, and a socket update can never disagree with the open modal.
  const openTask = useMemo<Task | null>(() => {
    if (route.task === null) return null;
    return (
      (tasks ?? []).find((t) => t.id === route.task) ??
      (fetchedTask && fetchedTask.id === route.task ? fetchedTask : null)
    );
  }, [route.task, tasks, fetchedTask]);

  // Fetch the focused Ticket's Task only when it isn't in the loaded list (an
  // EpicPeek deep-link into another Epic, a cross-Workspace or dropped-off id).
  // An in-list id needs no fetch — the poll/socket already keep it fresh.
  useEffect(() => {
    if (route.task === null) {
      setFetchedTask(null);
      fetchedTaskIdRef.current = null;
      return;
    }
    if ((tasks ?? []).some((t) => t.id === route.task)) return;
    // Fetch once per focused id — the socket's task_changed keeps the cached
    // Ticket fresh thereafter, so a later `tasks` reference change must not
    // refetch (or re-toast on failure). The ref, not fetchedTask, gates this:
    // a failed fetch leaves fetchedTask null but must still not retry-spam.
    if (fetchedTaskIdRef.current === route.task) return;
    fetchedTaskIdRef.current = route.task;
    let live = true;
    api.task(route.task).then((t) => live && setFetchedTask(t), toastError);
    return () => {
      live = false;
    };
  }, [route.task, tasks]);

  // The rail's cobalt "Needs you" badge (DESIGN.md §5): Tasks awaiting review
  // (the review gate) plus afk Runs that escalated to a human — the two states
  // that want an operator's eyes now. Derived from `deckSections` (not a local
  // predicate) so the badge is the exact count of the Deck's Needs-you section:
  // a hand-rolled `state === 'awaiting-review' || escalated` filter drifts —
  // it keeps counting a terminal Task still flagged `escalated` (and Epic
  // members that render in their band), so the badge stuck above the real item
  // count. One source of truth means the number always matches what's shown.
  const needsYouCount = useMemo(
    () => deckSections(tasks ?? [], epics, Date.now()).needsYou.length,
    [tasks, epics],
  );

  // EpicPeek's deep-link into the Ticket, and TaskDetail's skip-holder link:
  // both navigate to /task/:id so the focus is a real, bookmarkable route.
  const openTaskById = (taskId: number) => navigate({ ...route, task: taskId });
  // A Deck/Table/Graph row's click target — the one seam every surface's
  // `onOpen(task)` shares, so a row always opens the same /task/:id route.
  const openRow = (t: Task) => openTaskById(t.id);

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
    view === 'deck' && !!config && shouldShowRunHint(taskList, config.autoRunner, runHintDismissed);
  const dismissRunHint = () => {
    storeDismissed(localStorage, RUN_HINT_DISMISSED_KEY);
    setRunHintDismissed(true);
  };
  const showReviewHint = view === 'deck' && shouldShowReviewHint(taskList, reviewHintDismissed);
  const dismissReviewHint = () => {
    storeDismissed(localStorage, REVIEW_HINT_DISMISSED_KEY);
    setReviewHintDismissed(true);
  };

  // Picking a view is real navigation — push, so Back returns to the
  // previous view rather than leaving the app. It also closes any open Ticket
  // (clears route.task): choosing a rail destination leaves the focused Task
  // behind, and the sibling "Focus on board" handler clears it in step.
  const pickView = (v: View) => {
    navigate({ ...route, view: v, task: null });
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
    // The old Workspace's Epics (and any peek/focus onto one of them) are
    // meaningless once scoped elsewhere — drop them rather than flash stale
    // Epic state over the new board until refreshEpics resolves.
    setEpics([]);
    setOpenEpic(null);
    setFocusEpic(null);
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
        setEpics([]);
        setOpenEpic(null);
        setFocusEpic(null);
      }
    }
    // Programmatic redirect off the deleted Workspace's page, not a place the
    // operator chose to visit — replace, no history entry.
    navigate({ ...route, view: 'deck', task: null }, { replace: true });
  };

  // Collapsed items keep their accessible name and gain a native tooltip;
  // when the label is visible neither is needed — below the breakpoint the
  // drawer shows labels, so the attributes must not apply there.
  // Collapsed, the icon-only button has no visible text, so it needs an
  // aria-label/title. Fold the Deck's "Needs you" count into the label there:
  // the visual pill is suppressed at 48px, but a screen-reader operator — for
  // whom the collapsed rail is the whole nav — still hears the attention count.
  const railItemName = (label: string, needsYou: number | null = null) =>
    railCollapsed && railDesktop
      ? { 'aria-label': needsYou !== null ? `${label}, ${needsYou} needs you` : label, title: label }
      : {};

  // Hidden, not unmounted, when collapsed: keyboard order and focus
  // behavior stay identical in both widths.
  const railLabel = railCollapsed ? 'rail:hidden' : '';

  const navItems = (
    <>
      <nav aria-label="Views" className="flex flex-col gap-4 rail:flex-1">
        {RAIL_GROUPS.map((group) => {
          // Wire each group's uppercase Label header to its buttons so a screen
          // reader announces the Workspace grouping the sighted user sees
          // (role="group" + aria-labelledby), not a flat list.
          const groupId = `rail-group-${group.label.toLowerCase()}`;
          return (
            <div key={group.label} role="group" aria-labelledby={groupId} className="flex flex-col gap-0.5">
              {/* Uppercase Label group header (DESIGN.md §5), the shared
                  sectionLabel register. Hidden — not unmounted — when the rail
                  collapses to icons, so the icon-only nav keeps its order and
                  grouping gap without a header. */}
              <div id={groupId} className={`${sectionLabel} px-2.5 pb-1 ${railCollapsed ? 'rail:hidden' : ''}`}>
                {group.label}
              </div>
              {group.views.map((v) => {
                // The Deck carries the cobalt "Needs you" count; other items none
                // (the absence is the default). Suppressed when the rail is a
                // strip of icons — there's no room for a numeric pill at 48px.
                const needsYou = v === 'deck' && needsYouCount > 0 ? needsYouCount : null;
                return (
                  <button
                    key={v}
                    aria-current={view === v ? 'page' : undefined}
                    {...railItemName(VIEW_LABELS[v], needsYou)}
                    className={railItem(view === v, railCollapsed)}
                    onClick={() => pickView(v)}
                  >
                    <Icon name={v} />
                    <span className={railLabel}>{VIEW_LABELS[v]}</span>
                    {needsYou !== null && (
                      <span
                        aria-label={`${needsYou} needs you`}
                        className={`${railBadge} ${railCollapsed ? 'rail:hidden' : ''}`}
                      >
                        {needsYou}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          );
        })}
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
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:inline-flex focus:min-h-11 focus:items-center focus:rounded-md focus:bg-surface focus:px-4 focus:font-medium focus:text-ink focus:shadow-card"
      >
        Skip to content
      </a>
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
        {/* The status strip (DESIGN.md §5): status, not navigation — the
            auto-runner master switch, the running/machine ceiling, and today's
            cost, in hairline-separated clusters; then the theme cycle, the
            global Settings icon, Log out, and the one primary action. It pins
            with the rail while only the working area below scrolls. */}
        <header
          aria-label="Status"
          className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-hairline bg-shell px-6 py-2.5"
        >
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
          {config && <span aria-hidden="true" className="h-5 w-px shrink-0 bg-hairline" />}
          {config && (
            <span className="flex items-center gap-2 text-muted">
              <span
                aria-hidden="true"
                className={`size-[7px] rounded-full ${runningCount > 0 ? 'bg-running-dot' : 'bg-faint'}`}
              />
              <span>
                <span className={`font-semibold ${runningCount > 0 ? 'text-ink' : 'text-muted'}`}>
                  {runningCount}/{config.autoRunner.maxConcurrentRuns}
                </span>{' '}
                running
              </span>
            </span>
          )}
          {config && cost24h && (
            <span aria-hidden="true" className="h-5 w-px shrink-0 bg-hairline" />
          )}
          {cost24h && (
            <span className="text-muted" title="Cost over the last 24 hours">
              <span className="font-semibold tabular-nums text-ink">{cost24h}</span> today
            </span>
          )}
          <div className="flex-1" />
          <button
            aria-label={THEME_LABELS[theme]}
            title={THEME_LABELS[theme]}
            className={`${touchTarget} rounded-md text-muted transition-colors duration-150 hover:bg-raised hover:text-ink`}
            onClick={cycleTheme}
          >
            <Icon name={THEME_ICONS[theme]} />
          </button>
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

        {error && <div role="alert" className="mx-6 mt-4 rounded-lg bg-fail-tint px-4 py-2 text-fail">{error}</div>}

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
          {openTask ? (
            // The Ticket page is its own full-bleed surface (crumb bar, its
            // own scroll region, its own review-gate footer) — it replaces
            // the padded <main> view-switch below entirely rather than
            // layering over it, so it isn't fighting the view's own padding
            // (issue #183). It keeps the same skip-link target (`#main-
            // content`) the <main> below carries when no Ticket is open.
            <TicketPage
              task={openTask}
              onEdit={setEditing}
              onChanged={refresh}
              onClose={() => navigate({ ...route, task: null }, { replace: true })}
              onOpenTask={openTaskById}
            />
          ) : (
            <main id="main-content" tabIndex={-1} className="h-full min-w-0 overflow-y-auto px-6 py-5">
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
                  {view === 'deck' && (
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
                      <Deck
                        tasks={taskList}
                        loading={tasks === null}
                        epics={epics}
                        onOpen={openRow}
                        onOpenTask={openTaskById}
                        onChanged={refresh}
                        onNewTask={() => setEditing('new')}
                        onOpenEpic={setOpenEpic}
                        onForceLandEpic={forceLandEpic}
                        onShowRecent={() => pickView('table')}
                        focusEpic={focusEpic}
                        onClearFocus={() => setFocusEpic(null)}
                      />
                    </>
                  )}
                  {view === 'activity' && <ActivityView config={config} />}
                  {view === 'table' && (
                    <TableView
                      workspaceId={activeWorkspaceId}
                      onOpen={openRow}
                      filters={route.table}
                      onFiltersChange={setTableFilters}
                      epics={epics}
                      onForceLandEpic={forceLandEpic}
                    />
                  )}
                  {view === 'graph' && (
                    <GraphView
                      tasks={taskList}
                      loading={tasks === null}
                      onOpen={openRow}
                    />
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
          )}

          {!noWorkspaces && (
            <ConversationLauncher
              config={config}
              workspace={workspaces.find((w) => w.id === activeWorkspaceId) ?? null}
            />
          )}
        </div>
      </div>

      {openEpic && activeWorkspaceId !== null && (
        <EpicPeek
          epic={openEpic}
          workspaceId={activeWorkspaceId}
          onOpenTask={openTaskById}
          onFocus={(epicRef) => {
            const target = epics.find((e) => e.ref === epicRef) ?? null;
            setFocusEpic(target);
            setOpenEpic(null);
            // "Focus on board" is a real navigation to the Deck view (the
            // only surface focus-mode applies to), mirroring pickView.
            navigate({ ...route, view: 'deck', task: null });
          }}
          onClose={() => setOpenEpic(null)}
          onChanged={refreshEpics}
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
