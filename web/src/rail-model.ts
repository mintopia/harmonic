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

export const VIEWS = ['board', 'conversations', 'graph', 'activity', 'table', 'timeline', 'stats', 'operations', 'api', 'settings', 'workspace'] as const;
export type View = (typeof VIEWS)[number];

/**
 * Views shown as left-rail nav items. Global Settings
 * is deliberately absent: its entry moved to a header icon next to the theme
 * toggle, leaving the rail for the working views plus the per-Workspace
 * settings page. 'settings' stays a real View — reachable, just not from here.
 */
export const RAIL_VIEWS: readonly View[] = VIEWS.filter((v) => v !== 'settings');

/**
 * Rail grouping: the rail's two labelled groups —
 * Workspace-scoped working views, then instance/global surfaces. 'settings'
 * is deliberately absent — it's a status-strip icon, not a rail item.
 */
export interface RailGroup {
  label: string;
  views: readonly View[];
}

/** The rail's three divider-separated groups: the live overview surfaces, then
 * the per-task data surfaces, then the instance surfaces (Operations, the API
 * surface, and the per-Workspace Settings page). Labels are accessible names
 * only — the rail renders each group as a divider, not a heading. Global
 * Settings stays a status-strip icon, not a rail item. */
export const RAIL_GROUPS: readonly RailGroup[] = [
  { label: 'Overview', views: ['board', 'conversations', 'graph', 'activity'] },
  { label: 'Data', views: ['table', 'timeline', 'stats'] },
  { label: 'Instance', views: ['operations', 'api', 'workspace'] },
];

/**
 * Views scoped to the active Workspace: they read the active
 * Workspace's Tasks/stats and go blank without one, so with zero Workspaces
 * they yield to the "No workspace open" empty state. Activity is
 * instance-wide (every process across Workspaces), and API/Settings are
 * global, so those still render on a fresh, workspace-less instance.
 */
export function isWorkspaceScopedView(view: View): boolean {
  return (
    view === 'board' || view === 'timeline' || view === 'conversations' || view === 'table' || view === 'graph' || view === 'stats' || view === 'workspace'
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
  operations: 'Operations',
  api: 'API',
  settings: 'Settings',
  workspace: 'Settings',
};
