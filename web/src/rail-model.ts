type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export const RAIL_COLLAPSED_KEY = 'harmonic.rail-collapsed';

export function loadRailCollapsed(storage: StorageLike): boolean {
  try {
    return storage.getItem(RAIL_COLLAPSED_KEY) === '1';
  } catch (error) {
    console.warn('loadRailCollapsed: storage unavailable', error);
    return false;
  }
}

export function storeRailCollapsed(storage: StorageLike, collapsed: boolean): void {
  try {
    storage.setItem(RAIL_COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch (error) {
    console.warn('storeRailCollapsed: storage unavailable', error);
  }
}

export const VIEWS = ['board', 'conversations', 'graph', 'activity', 'table', 'timeline', 'stats', 'files', 'operations', 'api', 'settings', 'workspace'] as const;
export type View = (typeof VIEWS)[number];

export const GLOBAL_RAIL_VIEWS: readonly View[] = ['board', 'table', 'activity', 'timeline', 'stats', 'operations', 'api', 'settings'];
export const WORKSPACE_RAIL_VIEWS: readonly View[] = ['board', 'conversations', 'graph', 'activity', 'table', 'timeline', 'stats', 'files', 'operations', 'workspace'];

export interface RailGroup {
  label: string;
  views: readonly View[];
}

export const GLOBAL_RAIL_GROUPS: readonly RailGroup[] = [
  { label: 'Overview', views: ['board', 'table'] },
  { label: 'Insights', views: ['activity', 'timeline', 'stats'] },
  { label: 'Instance', views: ['operations', 'api', 'settings'] },
];
export const WORKSPACE_RAIL_GROUPS: readonly RailGroup[] = [
  { label: 'Overview', views: ['board', 'conversations', 'table', 'files'] },
  { label: 'Insights', views: ['activity', 'graph', 'timeline', 'stats'] },
  { label: 'Instance', views: ['operations', 'workspace'] },
];

/**
 * Views without a Global form yield to the "No workspace open" empty state.
 */
export function isWorkspaceScopedView(view: View): boolean {
  return (
    view === 'board' || view === 'conversations' || view === 'table' || view === 'graph' || view === 'files' || view === 'workspace'
  );
}
export const VIEW_LABELS: Record<View, string> = {
  board: 'Board',
  activity: 'Activity',
  timeline: 'Timeline',
  conversations: 'Conversations',
  table: 'Tasks',
  graph: 'Graph',
  stats: 'Statistics',
  files: 'Files',
  operations: 'Operations',
  api: 'API',
  settings: 'Settings',
  workspace: 'Settings',
};

export const GLOBAL_VIEW_LABELS: Partial<Record<View, string>> = {
  board: 'Dashboard',
};
