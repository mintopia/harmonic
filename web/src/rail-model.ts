type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export const RAIL_COLLAPSED_KEY = 'harmonic.rail-collapsed';

export function loadRailCollapsed(storage: StorageLike): boolean {
  try {
    return storage.getItem(RAIL_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

export function storeRailCollapsed(storage: StorageLike, collapsed: boolean): void {
  try {
    storage.setItem(RAIL_COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch {
  }
}

export const VIEWS = ['board', 'conversations', 'graph', 'activity', 'table', 'timeline', 'stats', 'files', 'operations', 'api', 'settings', 'workspace'] as const;
export type View = (typeof VIEWS)[number];

export const GLOBAL_RAIL_VIEWS: readonly View[] = ['board', 'table', 'activity', 'timeline', 'stats', 'operations', 'api', 'settings'];
export const WORKSPACE_RAIL_VIEWS: readonly View[] = ['board', 'conversations', 'graph', 'activity', 'table', 'timeline', 'stats', 'files', 'operations', 'workspace'];
export const RAIL_VIEWS = WORKSPACE_RAIL_VIEWS;

export interface RailGroup {
  label: string;
  views: readonly View[];
}

export const RAIL_GROUPS: readonly RailGroup[] = [
  { label: 'Overview', views: ['board', 'conversations', 'graph', 'activity'] },
  { label: 'Data', views: ['table', 'timeline', 'stats', 'files'] },
  { label: 'Instance', views: ['operations', 'api', 'workspace'] },
];
export const GLOBAL_RAIL_GROUPS: readonly RailGroup[] = [{ label: 'Global', views: GLOBAL_RAIL_VIEWS }];
export const WORKSPACE_RAIL_GROUPS: readonly RailGroup[] = [{ label: 'Workspace', views: WORKSPACE_RAIL_VIEWS }];

/**
 * Views scoped to the active Workspace: they read the active
 * Workspace's Tasks/stats and go blank without one, so with zero Workspaces
 * they yield to the "No workspace open" empty state. Activity is
 * instance-wide (every process across Workspaces), and API/Settings are
 * global, so those still render on a fresh, workspace-less instance.
 */
export function isWorkspaceScopedView(view: View): boolean {
  return (
    view === 'board' || view === 'timeline' || view === 'conversations' || view === 'table' || view === 'graph' || view === 'stats' || view === 'files' || view === 'workspace'
  );
}
export const VIEW_LABELS: Record<View, string> = {
  board: 'Board',
  activity: 'Activity',
  timeline: 'Timeline',
  conversations: 'Conversations',
  table: 'Tasks',
  graph: 'Graph',
  stats: 'Stats',
  files: 'Files',
  operations: 'Operations',
  api: 'API',
  settings: 'Settings',
  workspace: 'Settings',
};
