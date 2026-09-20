import { lazy, Suspense } from 'react';
import { Board } from './Board';
import { EpicPage } from './EpicPage';
import { TicketPage } from './TicketPage';
import { GlobalDashboard } from './GlobalDashboard';
import { ActivityView } from './ActivityView';
import { ConversationLauncher, ConversationsPage } from './ConversationLauncher';
import { TableView } from './TableView';
import { StatsPage } from './StatsPage';
import { FilesPage } from './FilesPage';
import { TimelinePage } from './TimelinePage';
import { OperationsPage } from './OperationsPage';
import { ApiPage } from './ApiPage';
import { SettingsPage } from './SettingsPage';
import { WorkspaceSettingsPage } from './WorkspaceSettingsPage';
import { EmptyState } from './EmptyState';
import type { AppConfig, Task, Workspace } from '../types';
import type { Epic } from '../epic-model';
import type { HostLoad } from '../ws';
import type { View } from '../rail-model';
import { NO_SELECTION, type Route, type TableFilters } from '../router-model';
import { btnPrimary, btnQuiet } from '../ui';
import type { PendingPermissionAlert } from '../usePendingPermissionAlerts';
import type { NavigateFn } from '../useRoute';

const GraphView = lazy(() => import('./GraphView').then((m) => ({ default: m.GraphView })));

interface MainViewContentProps {
  view: View;
  route: Route;
  navigate: NavigateFn;
  activeWorkspaceId: number | null;
  activeWorkspace: Workspace | null;
  epics: Epic[];
  taskList: Task[];
  tasks: Task[] | null;
  hasHistory: boolean | null;
  config: AppConfig | null;
  hostLoad: HostLoad | null;
  pendingPermissionAlerts: PendingPermissionAlert[];
  workspaces: Workspace[];
  runningCount: number;
  onEdit: (task: Task | 'new' | null) => void;
  onOpenTask: (taskId: number) => void;
  onOpenRow: (task: Task) => void;
  onOpenEpic: (ref: number) => void;
  pickView: (v: View) => void;
  switchWorkspace: (id: number) => void;
  setTableFilters: (table: TableFilters) => void;
  setConfig: (config: AppConfig) => void;
  handleWorkspaceSaved: (workspace: Workspace) => void;
  handleWorkspaceDeleted: (id: number) => void;
  pickConversation: (conversationId: number | null) => void;
}

/** The routed page content for the current rail `view` — everything under the
 * chrome (error banner, hints) that `AppContent` renders around it. */
function MainViewContent({
  view,
  route,
  navigate,
  activeWorkspaceId,
  activeWorkspace,
  epics,
  taskList,
  tasks,
  hasHistory,
  config,
  hostLoad,
  pendingPermissionAlerts,
  workspaces,
  runningCount,
  onEdit,
  onOpenTask,
  onOpenRow,
  onOpenEpic,
  pickView,
  switchWorkspace,
  setTableFilters,
  setConfig,
  handleWorkspaceSaved,
  handleWorkspaceDeleted,
  pickConversation,
}: MainViewContentProps) {
  return (
    <>
      {view === 'board' && activeWorkspaceId === null && (
        <GlobalDashboard
          pendingPermissions={pendingPermissionAlerts.length}
          hostLoad={hostLoad}
          onNavigate={(view) => pickView(view)}
          onOpenWorkspace={switchWorkspace}
        />
      )}
      {view === 'board' && activeWorkspaceId !== null && (
        <Board
          tasks={taskList}
          loading={tasks === null}
          epics={epics}
          hasHistory={hasHistory}
          onOpen={onOpenRow}
          onOpenTask={onOpenTask}
          onNewTask={() => onEdit('new')}
          onOpenEpic={(epic) => onOpenEpic(epic.ref)}
        />
      )}
      {view === 'activity' && <ActivityView config={config} workspaceId={activeWorkspaceId} />}
      {view === 'conversations' && (
        <ConversationsPage
          config={config}
          workspace={activeWorkspace}
          conversationId={route.conversation ?? null}
          onConversationChange={pickConversation}
        />
      )}
      {view === 'table' && (
        <TableView
          workspaceId={route.scope.kind === 'global' ? null : activeWorkspaceId}
          workspaces={workspaces}
          epics={route.scope.kind === 'global' ? [] : epics}
          onOpen={onOpenRow}
          onOpenEpic={onOpenEpic}
          filters={route.table}
          onFiltersChange={setTableFilters}
          onNewTask={() => onEdit('new')}
        />
      )}
      {view === 'graph' && (
        <Suspense
          fallback={
            <div className="flex h-full items-center justify-center text-muted">Loading graph…</div>
          }
        >
          <GraphView workspaceId={activeWorkspaceId} epics={epics} onOpen={onOpenRow} />
        </Suspense>
      )}
      {view === 'stats' && <StatsPage workspaceId={activeWorkspaceId} />}
      {view === 'files' && activeWorkspace && (
        <FilesPage workspace={activeWorkspace} selectedPath={route.file ?? null} onSelectFile={(file) => navigate({ ...route, file })} onWorkspaceSaved={handleWorkspaceSaved} />
      )}
      {view === 'timeline' && (
        <TimelinePage workspaceId={activeWorkspaceId} onOpenTask={onOpenTask} />
      )}
      {view === 'operations' && (
        <OperationsPage workspaceId={activeWorkspaceId} tasks={taskList} epics={epics} onOpenTask={onOpenTask} onOpenEpic={onOpenEpic} />
      )}
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
  );
}

interface AppContentProps {
  route: Route;
  navigate: NavigateFn;
  activeWorkspaceId: number | null;
  activeWorkspace: Workspace | null;
  openTask: Task | null;
  epics: Epic[];
  error: string | null;
  showRunHint: boolean;
  dismissRunHint: () => void;
  showEscalationHint: boolean;
  dismissEscalationHint: () => void;
  showWorkspaceEmptyState: boolean;
  setCreatingWorkspace: (creating: boolean) => void;
  taskList: Task[];
  tasks: Task[] | null;
  hasHistory: boolean | null;
  config: AppConfig | null;
  hostLoad: HostLoad | null;
  pendingPermissionAlerts: PendingPermissionAlert[];
  noWorkspaces: boolean;
  view: View;
  workspaces: Workspace[];
  conversationToOpen: number | null;
  runningCount: number;
  onEdit: (task: Task | 'new' | null) => void;
  onChanged: () => void;
  onOpenTask: (taskId: number) => void;
  onOpenRow: (task: Task) => void;
  onOpenEpic: (ref: number) => void;
  pickView: (v: View) => void;
  switchWorkspace: (id: number) => void;
  setTableFilters: (table: TableFilters) => void;
  setConfig: (config: AppConfig) => void;
  handleWorkspaceSaved: (workspace: Workspace) => void;
  handleWorkspaceDeleted: (id: number) => void;
  handleConversationOpened: () => void;
  expandConversation: (conversationId: number | null) => void;
  pickConversation: (conversationId: number | null) => void;
}

export function AppContent({
  route,
  navigate,
  activeWorkspaceId,
  activeWorkspace,
  openTask,
  epics,
  error,
  showRunHint,
  dismissRunHint,
  showEscalationHint,
  dismissEscalationHint,
  showWorkspaceEmptyState,
  setCreatingWorkspace,
  taskList,
  tasks,
  hasHistory,
  config,
  hostLoad,
  pendingPermissionAlerts,
  noWorkspaces,
  view,
  workspaces,
  conversationToOpen,
  runningCount,
  onEdit,
  onChanged,
  onOpenTask,
  onOpenRow,
  onOpenEpic,
  pickView,
  switchWorkspace,
  setTableFilters,
  setConfig,
  handleWorkspaceSaved,
  handleWorkspaceDeleted,
  handleConversationOpened,
  expandConversation,
  pickConversation,
}: AppContentProps) {
  return (
    <div className="relative min-h-0 flex-1">
      {route.epic !== null && activeWorkspaceId !== null ? (
        <EpicPage
          epicRef={route.epic}
          workspaceId={activeWorkspaceId}
          onClose={() => navigate({ ...route, epic: null, panel: NO_SELECTION }, { replace: true })}
          onOpenTask={onOpenTask}
          selection={route.panel}
          onSelect={(panel) => navigate({ ...route, panel })}
        />
      ) : openTask ? (
        <TicketPage
          task={openTask}
          onEdit={onEdit}
          onChanged={onChanged}
          onClose={() => navigate({ ...route, task: null, panel: NO_SELECTION }, { replace: true })}
          onOpenTask={onOpenTask}
          selection={route.panel}
          onSelect={(panel) => navigate({ ...route, panel })}
          onOpenEpic={onOpenEpic}
          parentEpicRef={epics.find((e) => e.members.some((m) => m.taskId === openTask.id))?.ref ?? null}
          error={error}
        />
      ) : (
        <div className="flex h-full flex-col">
          {error && (
            <div role="alert" className="mx-6 mt-4 shrink-0 rounded-lg bg-fail-tint px-4 py-2 text-fail">
              {error}
            </div>
          )}
          {showRunHint && (
            <div className="mx-6 mt-4 flex shrink-0 items-start gap-3 rounded-lg border-l-4 border-l-ready bg-ready-tint px-4 py-2.5 text-small">
              <span
                aria-hidden="true"
                className="mt-1 size-2 shrink-0 rounded-full bg-ready-dot"
              />
              <p className="flex-1 text-ink">
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
            <div className="mx-6 mt-4 flex shrink-0 items-start gap-3 rounded-lg border-l-4 border-l-await bg-await-tint px-4 py-2.5 text-small">
              <span aria-hidden="true" className="mt-1 size-2 shrink-0 rounded-full bg-await-dot" />
              <p className="flex-1 text-ink">
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
            className={`min-h-0 min-w-0 flex-1 ${
              view === 'conversations' || view === 'files' ? 'overflow-hidden' : 'overflow-y-auto px-6 pt-5 pb-16'
            }`}
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
                A workspace points Harmonic at a project directory — its tasks, attempts, and cost all
                scope to it. Open one to get started.
              </EmptyState>
            ) : (
              <MainViewContent
                view={view}
                route={route}
                navigate={navigate}
                activeWorkspaceId={activeWorkspaceId}
                activeWorkspace={activeWorkspace}
                epics={epics}
                taskList={taskList}
                tasks={tasks}
                hasHistory={hasHistory}
                config={config}
                hostLoad={hostLoad}
                pendingPermissionAlerts={pendingPermissionAlerts}
                workspaces={workspaces}
                runningCount={runningCount}
                onEdit={onEdit}
                onOpenTask={onOpenTask}
                onOpenRow={onOpenRow}
                onOpenEpic={onOpenEpic}
                pickView={pickView}
                switchWorkspace={switchWorkspace}
                setTableFilters={setTableFilters}
                setConfig={setConfig}
                handleWorkspaceSaved={handleWorkspaceSaved}
                handleWorkspaceDeleted={handleWorkspaceDeleted}
                pickConversation={pickConversation}
              />
            )}
          </main>
        </div>
      )}

      {!noWorkspaces && view !== 'conversations' && (
        <ConversationLauncher
          config={config}
          workspace={workspaces.find((w) => w.id === activeWorkspaceId) ?? null}
          conversationId={route.conversation}
          openConversationId={conversationToOpen}
          pendingPermission={
            pendingPermissionAlerts.find(({ permission }) => permission.conversationId === conversationToOpen)?.permission ?? null
          }
          onConversationOpened={handleConversationOpened}
          onExpand={expandConversation}
        />
      )}
    </div>
  );
}
