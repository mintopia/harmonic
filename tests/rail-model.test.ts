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
  it('orders the rail: Board/Conversations/Graph/Activity, then Tasks/Timeline/Stats, then Operations/API/Settings; global Settings stays a header icon', () => {
    expect(VIEWS).toEqual(['board', 'conversations', 'graph', 'activity', 'table', 'timeline', 'stats', 'operations', 'api', 'settings', 'workspace']);
  });

  it('omits global Settings from the rail — its entry moved to a header icon (issue #63)', () => {
    expect(RAIL_VIEWS).toEqual(['board', 'conversations', 'graph', 'activity', 'table', 'timeline', 'stats', 'operations', 'api', 'workspace']);
    expect(RAIL_VIEWS).not.toContain('settings');
  });

  it('labels every view', () => {
    for (const v of VIEWS) expect(VIEW_LABELS[v]).toBeTruthy();
    expect(VIEW_LABELS.board).toBe('Board');
    expect(VIEW_LABELS.conversations).toBe('Conversations');
    expect(VIEW_LABELS.api).toBe('API');
    expect(VIEW_LABELS.graph).toBe('Graph');
    expect(VIEW_LABELS.operations).toBe('Operations');
    expect(VIEW_LABELS.timeline).toBe('Timeline');
    expect(VIEW_LABELS.settings).toBe('Settings');
    expect(VIEW_LABELS.workspace).toBe('Settings');
  });

  it('scopes Board/Table/Graph/Stats and the per-Workspace settings page to a Workspace, so the empty state (#68) spares Activity/API/Settings', () => {
    expect(VIEWS.filter(isWorkspaceScopedView)).toEqual(['board', 'conversations', 'graph', 'table', 'timeline', 'stats', 'workspace']);
    expect(isWorkspaceScopedView('activity')).toBe(false);
    expect(isWorkspaceScopedView('api')).toBe(false);
    expect(isWorkspaceScopedView('settings')).toBe(false);
  });
});

describe('rail groups (divider-separated)', () => {
  it('has three groups — Overview, Data, Instance', () => {
    expect(RAIL_GROUPS.map((g) => g.label)).toEqual(['Overview', 'Data', 'Instance']);
  });

  it('groups the live overview surfaces, the per-task data surfaces, then the instance surfaces', () => {
    expect(RAIL_GROUPS[0]!.views).toEqual(['board', 'conversations', 'graph', 'activity']);
    expect(RAIL_GROUPS[1]!.views).toEqual(['table', 'timeline', 'stats']);
    expect(RAIL_GROUPS[2]!.views).toEqual(['operations', 'api', 'workspace']);
  });

  it('flattens back to RAIL_VIEWS in the same order — the rail-grouping coherence invariant', () => {
    expect(RAIL_GROUPS.flatMap((g) => g.views)).toEqual(RAIL_VIEWS);
  });

  it('excludes settings from every group', () => {
    for (const group of RAIL_GROUPS) expect(group.views).not.toContain('settings');
  });
});
