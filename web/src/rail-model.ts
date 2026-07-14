/**
 * Rail collapse persistence (DESIGN.md § Navigation, issue 21): the
 * desktop rail remembers icon-width vs expanded across reloads. Storage
 * is injected so the node-side test project can exercise the logic;
 * the app passes window.localStorage.
 */
type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export const RAIL_COLLAPSED_KEY = 'agentdeck.rail-collapsed';

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
