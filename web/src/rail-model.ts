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
// Workspace (issue #64) is the per-Workspace settings page, scoped to the
// active Workspace (the switcher above the nav picks which). It sits last, next
// to the global Settings it mirrors — Settings holds machine + default config,
// Workspace holds one Workspace's identity and its overrides of those defaults.
export const VIEWS = ['board', 'activity', 'table', 'stats', 'api', 'settings', 'workspace'] as const;
export type View = (typeof VIEWS)[number];

/**
 * Views shown as left-rail nav items. Global Settings (issue #63, ADR 0012)
 * is deliberately absent: its entry moved to a header icon next to the theme
 * toggle, leaving the rail for the working views plus the per-Workspace
 * settings page. 'settings' stays a real View — reachable, just not from here.
 */
export const RAIL_VIEWS: readonly View[] = VIEWS.filter((v) => v !== 'settings');

/**
 * Views scoped to the active Workspace (ADR-0008): they read the active
 * Workspace's Tasks/stats and go blank without one, so with zero Workspaces
 * they yield to the "No workspace open" empty state (#68). Activity is
 * instance-wide (every process across Workspaces), and API/Settings are
 * global, so those still render on a fresh, workspace-less instance.
 */
export function isWorkspaceScopedView(view: View): boolean {
  return view === 'board' || view === 'table' || view === 'stats' || view === 'workspace';
}
export const VIEW_LABELS: Record<View, string> = {
  board: 'Board',
  activity: 'Activity',
  table: 'Table',
  stats: 'Stats',
  api: 'API',
  settings: 'Settings',
  workspace: 'Workspace',
};
