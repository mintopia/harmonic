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
 * action, since it now behaves like Stats rather than like Channels/Log out.
 */
export const VIEWS = ['board', 'table', 'stats', 'api'] as const;
export type View = (typeof VIEWS)[number];
export const VIEW_LABELS: Record<View, string> = {
  board: 'Board',
  table: 'Table',
  stats: 'Stats',
  api: 'API',
};
