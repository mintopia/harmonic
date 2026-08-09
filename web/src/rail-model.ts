/**
 * Rail collapse persistence (DESIGN.md § Navigation, issue 21): the
 * desktop rail remembers icon-width vs expanded across reloads. Storage
 * is injected so the node-side test project can exercise the logic;
 * the app passes window.localStorage.
 */
type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export const RAIL_COLLAPSED_KEY = 'harmonic.rail-collapsed';

export function loadRailCollapsed(storage: StorageLike): boolean {
  try {
    return storage.getItem(RAIL_COLLAPSED_KEY) === '1';
  } catch {
    return false; // private browsing etc. — default expanded
  }
}

export function storeRailCollapsed(storage: StorageLike, collapsed: boolean): void {
  try {
    storage.setItem(RAIL_COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch {
    // best-effort: losing persistence must not break the toggle
  }
}

/**
 * Primary nav views (issue 5): API joins Board/Table/Stats as a full working
 * view — the former Keys modal is promoted here, not left as a pinned-bottom
 * action, since it now behaves like Stats rather than like Log out.
 * Settings (issue 6) joins the same way, as the operator config editor;
 * the former Channels modal now lives inside Settings as Notifications.
 */
// Activity (issue #52) joins as a primary view beside the Board: the
// instance-wide live view of every in-flight process across Workspaces, so it
// sits high in the rail next to the queue it complements.
export const VIEWS = ['board', 'activity', 'table', 'stats', 'api', 'settings'] as const;
export type View = (typeof VIEWS)[number];

/**
 * Views scoped to the active Workspace (ADR-0008): they read the active
 * Workspace's Tasks/stats and go blank without one, so with zero Workspaces
 * they yield to the "No workspace open" empty state (#68). Activity is
 * instance-wide (every process across Workspaces), and API/Settings are
 * global, so those still render on a fresh, workspace-less instance.
 */
export function isWorkspaceScopedView(view: View): boolean {
  return view === 'board' || view === 'table' || view === 'stats';
}
export const VIEW_LABELS: Record<View, string> = {
  board: 'Board',
  activity: 'Activity',
  table: 'Table',
  stats: 'Stats',
  api: 'API',
  settings: 'Settings',
};
