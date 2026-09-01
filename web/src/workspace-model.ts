import type { Workspace } from './types.js';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export const ACTIVE_WORKSPACE_KEY = 'harmonic.active-workspace';

export function loadActiveWorkspaceId(storage: StorageLike): number | null {
  try {
    const raw = storage.getItem(ACTIVE_WORKSPACE_KEY);
    const id = raw ? Number(raw) : NaN;
    return Number.isFinite(id) ? id : null;
  } catch {
    return null;
  }
}

export function storeActiveWorkspaceId(storage: StorageLike, id: number): void {
  try {
    storage.setItem(ACTIVE_WORKSPACE_KEY, String(id));
  } catch {
  }
}

/** The persisted id if it still names a real Workspace, else the first
 * (oldest, i.e. the default) Workspace, else null when the list is empty
 * (still loading). */
export function resolveActiveWorkspace(workspaces: Workspace[], persistedId: number | null): Workspace | null {
  if (workspaces.length === 0) return null;
  const persisted = persistedId !== null ? workspaces.find((w) => w.id === persistedId) : undefined;
  return persisted ?? workspaces[0]!;
}

/** Whether to show the full-screen "No workspace open" empty state:
 * the list has finished loading and come back empty — genuine first launch, or
 * after deleting the last Workspace. Gated on `loaded` so the initial
 * `[]` before the first fetch resolves never flashes the empty state over the
 * board. */
export function hasNoWorkspaces(workspaces: Workspace[], loaded: boolean): boolean {
  return loaded && workspaces.length === 0;
}
