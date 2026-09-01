import { describe, expect, it } from 'vitest';
import {
  RAIL_COLLAPSED_KEY,
  RAIL_GROUPS,
  RAIL_VIEWS,
  VIEW_LABELS,
  VIEWS,
  isWorkspaceScopedView,
  loadRailCollapsed,
  storeRailCollapsed,
} from '../web/src/rail-model.js';

const memoryStorage = (initial: Record<string, string> = {}) => {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    data,
  };
};

describe('rail collapse persistence', () => {
  it('defaults to expanded when nothing is stored', () => {
    expect(loadRailCollapsed(memoryStorage())).toBe(false);
  });

  it('round-trips the collapsed choice', () => {
    const storage = memoryStorage();
    storeRailCollapsed(storage, true);
    expect(loadRailCollapsed(storage)).toBe(true);
    storeRailCollapsed(storage, false);
    expect(loadRailCollapsed(storage)).toBe(false);
  });

  it('treats unrecognized stored values as the expanded default', () => {
    expect(loadRailCollapsed(memoryStorage({ [RAIL_COLLAPSED_KEY]: 'garbage' }))).toBe(false);
  });

  it('survives a storage that throws (private browsing)', () => {
    const throwing = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    expect(loadRailCollapsed(throwing)).toBe(false);
    expect(() => storeRailCollapsed(throwing, true)).not.toThrow();
  });
});

describe('rail primary views', () => {
  it('promotes API to a primary nav view alongside Board/Table/Stats (issue 5); Activity sits beside the Board (issue #52); Graph joins beside Table (issue #85); Workspace settings is last (issue #64)', () => {
    expect(VIEWS).toEqual(['board', 'activity', 'operations', 'table', 'graph', 'stats', 'api', 'settings', 'workspace']);
  });

  it('omits global Settings from the rail — its entry moved to a header icon (issue #63)', () => {
    expect(RAIL_VIEWS).toEqual(['board', 'activity', 'operations', 'table', 'graph', 'stats', 'api', 'workspace']);
    expect(RAIL_VIEWS).not.toContain('settings');
  });

  it('labels every view', () => {
    for (const v of VIEWS) expect(VIEW_LABELS[v]).toBeTruthy();
    expect(VIEW_LABELS.board).toBe('Board');
    expect(VIEW_LABELS.api).toBe('API');
    expect(VIEW_LABELS.graph).toBe('Graph');
    expect(VIEW_LABELS.operations).toBe('Operations');
    expect(VIEW_LABELS.settings).toBe('Settings');
    expect(VIEW_LABELS.workspace).toBe('Settings');
  });

  it('scopes Board/Table/Graph/Stats and the per-Workspace settings page to a Workspace, so the empty state (#68) spares Activity/API/Settings', () => {
    expect(VIEWS.filter(isWorkspaceScopedView)).toEqual(['board', 'table', 'graph', 'stats', 'workspace']);
    expect(isWorkspaceScopedView('activity')).toBe(false);
    expect(isWorkspaceScopedView('api')).toBe(false);
    expect(isWorkspaceScopedView('settings')).toBe(false);
  });
});

describe('rail groups (issue #181, Paper mockup)', () => {
  it('has two labelled groups — Workspace then Instance', () => {
    expect(RAIL_GROUPS.map((g) => g.label)).toEqual(['Workspace', 'Instance']);
  });

  it('groups the working views under Workspace, and the API surface + per-Workspace Settings page under Instance', () => {
    expect(RAIL_GROUPS[0]!.views).toEqual(['board', 'activity', 'operations', 'table', 'graph', 'stats']);
    expect(RAIL_GROUPS[1]!.views).toEqual(['api', 'workspace']);
  });

  it('flattens back to RAIL_VIEWS in the same order — the rail-grouping coherence invariant', () => {
    expect(RAIL_GROUPS.flatMap((g) => g.views)).toEqual(RAIL_VIEWS);
  });

  it('excludes settings from every group', () => {
    for (const group of RAIL_GROUPS) expect(group.views).not.toContain('settings');
  });
});
