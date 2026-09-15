import { describe, expect, it } from 'vitest';
import {
  GLOBAL_RAIL_VIEWS,
  RAIL_COLLAPSED_KEY,
  WORKSPACE_RAIL_VIEWS,
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

describe('scope rails', () => {
  it('keeps Global and Workspace navigation separate', () => {
    expect(GLOBAL_RAIL_VIEWS).toEqual(['board', 'table', 'activity', 'timeline', 'stats', 'operations', 'api', 'settings']);
    expect(WORKSPACE_RAIL_VIEWS).toEqual(['board', 'conversations', 'graph', 'activity', 'table', 'timeline', 'stats', 'files', 'operations', 'workspace']);
    expect(GLOBAL_RAIL_VIEWS).not.toContain('workspace');
    expect(WORKSPACE_RAIL_VIEWS).not.toContain('api');
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

  it('scopes Board/Table/Graph/Stats/Files and the per-Workspace settings page to a Workspace, so the empty state (#68) spares Activity/API/Settings', () => {
    expect(VIEWS.filter(isWorkspaceScopedView)).toEqual(['board', 'conversations', 'graph', 'table', 'timeline', 'stats', 'files', 'workspace']);
    expect(isWorkspaceScopedView('activity')).toBe(false);
    expect(isWorkspaceScopedView('api')).toBe(false);
    expect(isWorkspaceScopedView('settings')).toBe(false);
  });
});
