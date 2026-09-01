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

// The Dependency Graph is the only surface that pulls in elkjs (the app's single
// heaviest asset), and it's rarely opened — so it's code-split out of the main
// bundle and loads on first visit.
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
    // Re-selecting the active view (or otherwise settling on the URL we're
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

// The Board renders every open task, grouped into Attention / Running / Pending,
// so it can't show a single page — but it still fetches through the paginated
// contract (ADR-0045), walking the open list in bounded pages and assembling the
// whole set rather than pulling it back in one unbounded response.
const BOARD_PAGE = 100;
async function fetchOpenTasks(workspaceId: number): Promise<Task[]> {
  const all: Task[] = [];
  for (let offset = 0; ; offset += BOARD_PAGE) {
    const { tasks, total } = await api.tasks({ workspaceId, state: 'open', limit: BOARD_PAGE, offset });
    all.push(...tasks);
    if (tasks.length === 0 || all.length >= total) return all;
  }
}

// The Board folds every derived Epic into its focus/peek chrome, so — like the
// task list — it walks the paginated Epic contract (ADR-0045, issue #351) in
// bounded pages and assembles the whole set rather than pulling it back in one
// unbounded response.
async function fetchAllEpics(workspaceId: number): Promise<Epic[]> {
  const all: Epic[] = [];
  for (let offset = 0; ; offset += BOARD_PAGE) {
    const { epics, total } = await api.epics(workspaceId, { limit: BOARD_PAGE, offset });
    all.push(...epics);
    if (epics.length === 0 || all.length >= total) return all;
  }
}

/** Cost over the trailing 24h, scoped to the active Workspace — the status strip's period cost. */
function usePeriodCost(authed: boolean, tasks: Task[] | null, workspaceId: number | null) {
  const [cost, setCost] = useState<Cost | null>(null);
  // Runs finishing move cost, and every finish changes the running count;
  // together with the task count this catches the transitions that matter.
  const shape = tasks ? `${tasks.length}:${tasks.filter((t) => t.state === 'working').length}` : '';
  // The shape-driven refresh goes through this debounced loader (rebuilt per
  // Workspace below). /api/stats is a heavy, event-loop-blocking aggregate, so a
  // task_changed burst — an epic integrating fires one per member — must fold into a
  // single trailing fetch, not one aggregate per frame. Held in a ref so the
  // debounce instance survives shape changes and can actually coalesce them.
  const refresh = useRef<(() => void) | null>(null);
  const shapeSettled = useRef(false);
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
        .catch(() => {}); // status readout only — never worth an alert
    };
    const debounced = debounce(load, 1000);
    refresh.current = debounced;
    shapeSettled.current = false;
    load(); // eager on mount / Workspace switch; the debounce only guards bursts
    const timer = setInterval(load, 60_000);
    return () => {
      clearInterval(timer);
      debounced.cancel();
      refresh.current = null;
    };
  }, [authed, workspaceId]);
  // A post-mount shape change (a run started or finished) pokes the debounced
  // refresh. The shape present at (re)mount is skipped — the effect above
  // already did the eager load for it.
  useEffect(() => {
    if (!shapeSettled.current) {
      shapeSettled.current = true;
      return;
    }
    refresh.current?.();
  }, [shape]);
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
  // caches a Task that isn't in the current Workspace's list (the focused-Epic
  // deep-link, a cross-Workspace id) so the derived `openTask` below can still
  // resolve it; a Task that IS in the list stays live off the poll/socket.
  const [fetchedTask, setFetchedTask] = useState<Task | null>(null);
  // Parallel-Epic read model (issue #167, ADR-0026): the active Workspace's
  // derived Epic list, feeding the Board's bands and the "Needs you" count. The
  // focused Epic is the URL (`/epic/:ref`, ADR-0017), not local state.
  const [epics, setEpics] = useState<Epic[]>([]);
  const [route, navigate] = useRoute();
  const view = route.view;
  // Latest route for the ws subscription's task_removed handler, which lives
  // outside React's render scope and must not put `route` in its effect deps
  // (that would re-subscribe on every navigation).
  const routeRef = useRef(route);
  // eslint-disable-next-line react/refs -- latest-route ref, deliberately synced during render so the ws handler reads it without re-subscribing
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
  const [escalationHintDismissed, setEscalationHintDismissed] = useState(() =>
    loadDismissed(localStorage, ESCALATION_HINT_DISMISSED_KEY),
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
      // Open work only: blocked-ness and epic-frontier correctness are
      // server-derived (openBlockerCount/blockedOnFailed), so the lean open list
      // carries everything the sections need without the terminal history that
      // made the full fetch slow (ADR-0045). The Graph self-fetches its whole
      // graph (#348); a focused terminal Ticket hydrates from its item GET.
      const tasks = await fetchOpenTasks(activeWorkspaceId);
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
  // longer derives (e.g. it fully integrated and dropped off the list).
  const refreshEpics = useCallback(async () => {
    if (activeWorkspaceId === null) return;
    try {
      setEpics(await fetchAllEpics(activeWorkspaceId));
    } catch {
      // Soft-fail: see comment above.
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
    // A member merge fires a burst of task_changed in quick succession, and each
    // one used to trigger its own api.epics() round trip. Debounce them into a
    // single trailing refetch so the firehose folds to one request per burst;
    // the Task-list updates below still apply immediately, per event.
    const debouncedRefreshEpics = debounce(refreshEpics, 250);
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
        // Keep a focused closed Task available after removing it from the
        // Deck's open-only collection. The route stays on its Ticket without
        // an unnecessary follow-up fetch; a pre-existing cached Ticket still
        // refreshes through the same path.
        setFetchedTask((current) =>
          current?.id === msg.task.id || routeRef.current.task === msg.task.id ? msg.task : current,
        );
        // Keep the Epic bands live (ADR-0026): a member's task_changed is
        // exactly the signal an Epic's fold/integrate/verification state may
        // have moved, so refetch alongside the Task-list update.
        debouncedRefreshEpics();
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

  // Fetch the focused Ticket's Task only when it isn't in the loaded list (the
  // focused-Epic deep-link into another Epic, a cross-Workspace or dropped-off id).
  // An in-list id needs no fetch — the poll/socket already keep it fresh.
  useLiveEffect((live) => {
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
    api.task(route.task).then((t) => live() && setFetchedTask(t), toastError);
  }, [route.task, tasks]);

  // The rail's indigo "Needs you" badge (DESIGN.md §5): escalated Tasks and
  // Epics — what wants an operator's eyes now (ADR-0041). Derived from
  // `boardSections` (not a local predicate) so the badge is the exact count of
  // the Board's Attention section: a hand-rolled filter drifts — it keeps
  // counting an Epic's own driver ticket, so the badge stuck above the real item
  // count. One source of truth means the number always matches what's shown.
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
  const runningCount = taskList.filter((t) => t.state === 'working').length;
  const cost24h = formatCost(periodCost);

  // The one cold-start bridge: a ready task won't start on its own while the
  // auto-runner is off, so point at the fix until the first run is seen. Once a
  // ticket escalates the run hint retires and the escalation hint takes over —
  // the two never show at once (see onboarding-model).
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

  // Picking a view is real navigation — push, so Back returns to the
  // previous view rather than leaving the app. It also closes any open Ticket
  // (clears route.task): choosing a rail destination leaves the focused Task
  // behind, and the sibling "Focus on board" handler clears it in step.
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

  // Force a tracker re-poll now (rescan the repo + mirror), then re-fetch the
  // board so mirrored changes appear immediately instead of on the next interval.
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
    // The old Workspace's Epics are meaningless once scoped elsewhere — drop
    // them rather than flash stale Epic state over the new board until
    // refreshEpics resolves.
    setEpics([]);
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

  // Deleting from the Workspace page (#64): drop it, then return to the board of
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

        {/* Mounted here, not at the end of the return: the toast stack anchors
            itself to the header's bottom edge (see toast.tsx). */}
        <Toaster />

        {/* The below-header region, and the Conversation's positioning
            context. The shell pins the header and scrolls only this, so the
            region's own top edge *is* the header's bottom edge at every
            viewport — which is what lets the docked panel inset off it
            without knowing the header's height. That height is not a
            constant to hardcode: the header sits at the viewport top on the
            rail, drops below the drawer under 900px, and wraps to two rows
            under ~520px (63 → 121 → 165px measured). */}
        <div className="relative min-h-0 flex-1">
          {route.epic !== null && activeWorkspaceId !== null ? (
            // The Epic summary page (ADR-0015/0017) is its own full-bleed surface,
            // keyed by ref off the `/epic/:ref` route — the one rich Epic surface,
            // reached from the Tasks-list Epic row, the Board band header, and a
            // child Ticket's parent-Epic breadcrumb. Like the Ticket page it
            // replaces the padded <main> view-switch and keeps the `#main-content`
            // skip target.
            <EpicPage
              epicRef={route.epic}
              workspaceId={activeWorkspaceId}
              onClose={() => navigate({ ...route, epic: null, panel: NO_SELECTION }, { replace: true })}
              onOpenTask={openTaskById}
              selection={route.panel}
              onSelect={(panel) => navigate({ ...route, panel })}
            />
          ) : openTask ? (
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
              onClose={() => navigate({ ...route, task: null, panel: NO_SELECTION }, { replace: true })}
              onOpenTask={openTaskById}
              selection={route.panel}
              onSelect={(panel) => navigate({ ...route, panel })}
              onOpenEpic={openEpicByRef}
              parentEpicRef={epics.find((e) => e.members.some((m) => m.taskId === openTask.id))?.ref ?? null}
              error={error}
            />
          ) : (
            // Full-view surface (issue: shared crumb bar): the breadcrumb is
            // pinned above the scrolling <main> — the same shrink-0 crumb /
            // flex-1 scroll split the Ticket page uses — so every view carries
            // the same navigation header and full-height views (Graph) still
            // fill the region below it without fighting a sticky in-flow crumb.
            <div className="flex h-full flex-col">
              {/* Global Settings is a header-icon surface outside the Workspace
                  nav hierarchy, so it carries no breadcrumb. */}
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
                    // Manual tracker refresh lives in the crumb bar's trailing
                    // edge — header chrome, not a control floating over the
                    // Board — and only when this Workspace mirrors a tracker.
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
