import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { formatCost } from './cost';
import type { Task, Workspace } from './types';
import { AppSidebar } from './components/AppSidebar';
import { AppContent } from './components/AppContent';
import { AppContextProvider } from './app-context';
import { Login } from './components/Login';
import { UpdateBanner } from './components/UpdateBanner';
import { AboutOverlay } from './components/AboutOverlay';
import { HeaderStatusBar } from './components/HeaderStatusBar';
import { NewWorkspaceForm } from './components/WorkspaceSwitcher';
import { TaskForm } from './components/TaskForm';
import { isWorkspaceScopedView, loadRailCollapsed, storeRailCollapsed } from './rail-model';
import type { View } from './rail-model';
import { NO_SELECTION, scopeSwitchRoute, type TableFilters } from './router-model';
import { hasNoWorkspaces } from './workspace-model';
import { applyTheme, loadTheme, nextTheme, storeTheme, type ThemePref } from './theme';
import {
  loadDismissed,
  shouldShowEscalationHint,
  shouldShowRunHint,
  storeDismissed,
  RUN_HINT_DISMISSED_KEY,
  ESCALATION_HINT_DISMISSED_KEY,
} from './onboarding-model';
import { btnQuiet } from './ui';
import { Toaster, toastError } from './toast';
import { ReviewLiveRegions } from './components/ReviewLiveRegions';
import { useAuth } from './useAuth';
import { useRoute } from './useRoute';
import { useRailBreakpoint } from './useRailBreakpoint';
import { useAppSync } from './useAppSync';
import { usePendingPermissionAlerts } from './usePendingPermissionAlerts';
import { useHostLoad } from './useHostLoad';
import { useFleetActivity } from './useFleetActivity';
import { usePeriodCost } from './usePeriodCost';

export function App() {
  const { authed, passwordSet, login, logout } = useAuth();
  const [route, navigate] = useRoute();
  const view = route.view;
  const railDesktop = useRailBreakpoint();

  const [menuOpen, setMenuOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState(() => loadRailCollapsed(localStorage));
  const [theme, setTheme] = useState<ThemePref>(() => loadTheme(localStorage));
  const [runHintDismissed, setRunHintDismissed] = useState(() =>
    loadDismissed(localStorage, RUN_HINT_DISMISSED_KEY),
  );
  const [escalationHintDismissed, setEscalationHintDismissed] = useState(() =>
    loadDismissed(localStorage, ESCALATION_HINT_DISMISSED_KEY),
  );
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);
  const [editing, setEditing] = useState<Task | 'new' | null>(null);
  const [conversationToOpen, setConversationToOpen] = useState<number | null>(null);
  const handleConversationOpened = useCallback(() => setConversationToOpen(null), []);

  useEffect(() => {
    applyTheme(document.documentElement, theme);
  }, [theme]);

  const {
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
  } = useAppSync({
    authed,
    route,
    navigate,
    onEscalationHandled: () => {
      storeDismissed(localStorage, ESCALATION_HINT_DISMISSED_KEY);
      setEscalationHintDismissed(true);
    },
  });

  const pendingPermissionAlerts = usePendingPermissionAlerts(authed, activeWorkspaceId);
  const hostLoad = useHostLoad(authed, activeWorkspaceId);
  const globalRunningCount = useFleetActivity(authed);
  const periodCost = usePeriodCost(authed === true, tasks, activeWorkspaceId);

  // Only the initial landing on the sole Workspace's board is automatic — once
  // decided, an operator who explicitly navigates back to the global Dashboard
  // (e.g. via the Workspace switcher's "Global" option) must be able to stay
  // there, so this must not re-fire on every subsequent `route` change.
  const initialWorkspaceRedirectDone = useRef(false);
  useEffect(() => {
    if (!workspacesLoaded || initialWorkspaceRedirectDone.current) return;
    initialWorkspaceRedirectDone.current = true;
    if (workspaces.length === 1 && route.scope.kind === 'global' && route.view === 'board') {
      navigate(scopeSwitchRoute(route, { kind: 'workspace', workspaceId: workspaces[0]!.id }), { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires once, guarded by the ref; `route`/`navigate` deliberately excluded so later route changes don't retrigger it
  }, [workspacesLoaded, workspaces]);

  // A Ticket deep-link (a Board/Table/Graph row, a child-task link on the Epic
  // page): navigate to /task/:id, clearing any focused Epic so the two pathname
  // surfaces stay mutually exclusive (ADR-0017).
  const openTaskById = (taskId: number) => navigate({ ...route, task: taskId, epic: null, panel: NO_SELECTION });
  // A Board/Table/Graph row's click target — the one seam every surface's
  // `onOpen(task)` shares, so a row always opens the same /task/:id route.
  const openRow = (t: Task) => openTaskById(t.id);
  // An Epic's click target (ADR-0017): the Tasks-list Epic row, the Board band
  // header, and a Ticket's parent-Epic link all open the Epic summary page
  // at /epic/:ref, clearing any focused Ticket.
  const openEpicByRef = (ref: number) => navigate({ ...route, epic: ref, task: null, panel: NO_SELECTION });
  const pickConversation = useCallback(
    (conversationId: number | null) => navigate({ ...route, conversation: conversationId }),
    [navigate, route],
  );
  const expandConversation = useCallback(
    (conversationId: number | null) =>
      navigate({ ...route, view: 'conversations', conversation: conversationId, task: null, epic: null, panel: NO_SELECTION }),
    [navigate, route],
  );

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
  if (!authed) return <Login onLoggedIn={login} />;

  const taskList = tasks ?? [];
  const noWorkspaces = hasNoWorkspaces(workspaces, workspacesLoaded);
  const showWorkspaceEmptyState = noWorkspaces && (view === 'board' || (route.scope.kind === 'workspace' && isWorkspaceScopedView(view)));
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
    navigate({
      ...route,
      view: v,
      task: null,
      epic: null,
      conversation: view === 'conversations' ? null : route.conversation,
      panel: NO_SELECTION,
      file: null,
    });
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


  const switchWorkspace = (id: number) => {
    navigate(scopeSwitchRoute(route, { kind: 'workspace', workspaceId: id }));
    setTasks(null);
    setEpics([]);
    setMenuOpen(false);
  };
  const switchGlobal = () => {
    navigate(scopeSwitchRoute(route, { kind: 'global' }));
    setMenuOpen(false);
  };
  const openGlobalActivity = () => {
    navigate({ ...scopeSwitchRoute(route, { kind: 'global' }), view: 'activity' });
    setTasks(null);
    setMenuOpen(false);
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
    <AppContextProvider value={{ config, workspace: activeWorkspace, refresh }}>
    <div className="flex min-h-screen flex-col rail:h-screen rail:overflow-hidden rail:flex-row">
      <ReviewLiveRegions polite={politeReviewAnnouncement} assertive={assertiveMergeAnnouncement} />
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:inline-flex focus:min-h-11 focus:items-center focus:rounded-md focus:bg-surface focus:px-4 focus:font-medium focus:text-ink focus:shadow-card"
      >
        Skip to content
      </a>
      {menuOpen && (
        <button
          type="button"
          aria-label="Close menu"
          tabIndex={-1}
          className="fixed inset-0 z-40 bg-black/40 rail:hidden"
          onClick={() => setMenuOpen(false)}
        />
      )}
      <AppSidebar
        railCollapsed={railCollapsed}
        railDesktop={railDesktop}
        menuOpen={menuOpen}
        onClose={() => setMenuOpen(false)}
        instanceName={instanceName}
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
        onSwitch={switchWorkspace}
        onGlobal={switchGlobal}
        onCreated={handleWorkspaceCreated}
        view={view}
        scope={route.scope}
        needsYouCount={needsYouCount}
        onPickView={pickView}
        onToggleRail={toggleRail}
        config={config}
        globalRunningCount={globalRunningCount}
        cost24h={cost24h}
        hostLoad={hostLoad}
        theme={theme}
        passwordSet={passwordSet}
        globalPaused={globalPaused}
        globalPausePending={globalPausePending}
        trackerEnabled={activeWorkspace?.trackerEnabled ?? false}
        refreshingTracker={refreshingTracker}
        onAutoRunnerChange={(enabled) =>
          api.updateConfig({ autoRunner: { enabled } }).then(setConfig, toastError)
        }
        onGlobalPauseChange={setFleetPaused}
        onRefreshTracker={refreshTracker}
        onThemeCycle={cycleTheme}
        onSettingsClick={() => pickView('settings')}
        onLogout={logout}
        onOpenAbout={() => setAboutOpen(true)}
        onOpenActivity={openGlobalActivity}
      />

      <div className="group/shell flex min-h-0 min-w-0 flex-1 flex-col">
        <HeaderStatusBar
          config={config}
          runningCount={globalRunningCount}
          cost24h={cost24h}
          hostLoad={hostLoad}
          theme={theme}
          view={view}
          passwordSet={passwordSet}
          globalPaused={globalPaused}
          globalPausePending={globalPausePending}
          trackerEnabled={activeWorkspace?.trackerEnabled ?? false}
          refreshingTracker={refreshingTracker}
          menuOpen={menuOpen}
          onMenuToggle={() => setMenuOpen((open) => !open)}
          onAutoRunnerChange={(enabled) =>
            api.updateConfig({ autoRunner: { enabled } }).then(setConfig, toastError)
          }
          onGlobalPauseChange={setFleetPaused}
          onRefreshTracker={refreshTracker}
          onThemeCycle={cycleTheme}
          onSettingsClick={() => pickView('settings')}
          onLogout={logout}
          onNewTask={() => setEditing('new')}
          onOpenAbout={() => setAboutOpen(true)}
          onOpenActivity={openGlobalActivity}
        />
        <UpdateBanner
          update={update}
          pending={updatePending}
          onArm={() => changeUpdate(api.armUpdate)}
          onCancel={() => changeUpdate(api.cancelUpdate)}
          onDismiss={() => changeUpdate(api.dismissUpdate)}
        />
        {aboutOpen && (
          <AboutOverlay
            appName={instanceName}
            currentVersion={update?.currentVersion ?? null}
            update={update}
            pending={updatePending}
            onArm={() => changeUpdate(api.armUpdate)}
            onCheckForUpdates={() => changeUpdate(api.checkUpdate)}
            onClose={() => setAboutOpen(false)}
          />
        )}

        <Toaster />

        {pendingPermissionAlerts.length > 0 && (
          <div role="alert" className="shrink-0 border-b border-await bg-await-tint px-6 py-2.5 text-small">
            {pendingPermissionAlerts.map(({ permission, conversationTitle }) => (
              <div key={permission.reqId} className="flex items-center gap-3 py-0.5">
                <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-await-dot" />
                <p className="min-w-0 flex-1 text-ink">
                  <span className="font-semibold">{conversationTitle} needs your permission</span>
                  {permission.request.toolCall?.title && <> to {permission.request.toolCall.title}</>}
                </p>
                <button
                  type="button"
                  aria-label={`Open conversation ${conversationTitle}`}
                  className={`${btnQuiet} shrink-0 text-await hover:text-ink`}
                  onClick={() => {
                    setConversationToOpen(permission.conversationId);
                    navigate({ ...route, conversation: permission.conversationId });
                  }}
                >
                  Answer →
                </button>
              </div>
            ))}
          </div>
        )}

        <AppContent
          route={route}
          navigate={navigate}
          activeWorkspaceId={activeWorkspaceId}
          activeWorkspace={activeWorkspace}
          openTask={openTask}
          epics={epics}
          error={error}
          showRunHint={showRunHint}
          dismissRunHint={dismissRunHint}
          showEscalationHint={showEscalationHint}
          dismissEscalationHint={dismissEscalationHint}
          showWorkspaceEmptyState={showWorkspaceEmptyState}
          setCreatingWorkspace={setCreatingWorkspace}
          taskList={taskList}
          tasks={tasks}
          hasHistory={hasHistory}
          config={config}
          hostLoad={hostLoad}
          pendingPermissionAlerts={pendingPermissionAlerts}
          noWorkspaces={noWorkspaces}
          view={view}
          workspaces={workspaces}
          conversationToOpen={conversationToOpen}
          runningCount={runningCount}
          onEdit={setEditing}
          onChanged={refresh}
          onOpenTask={openTaskById}
          onOpenRow={openRow}
          onOpenEpic={openEpicByRef}
          pickView={pickView}
          switchWorkspace={switchWorkspace}
          setTableFilters={setTableFilters}
          setConfig={setConfig}
          handleWorkspaceSaved={handleWorkspaceSaved}
          handleWorkspaceDeleted={handleWorkspaceDeleted}
          handleConversationOpened={handleConversationOpened}
          expandConversation={expandConversation}
          pickConversation={pickConversation}
        />
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
    </AppContextProvider>
  );
}
