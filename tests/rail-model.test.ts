import { describe, expect, it } from 'vitest';
import {
  GLOBAL_RAIL_GROUPS,
  GLOBAL_RAIL_VIEWS,
  GLOBAL_VIEW_LABELS,
  RAIL_COLLAPSED_KEY,
  WORKSPACE_RAIL_GROUPS,
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

  it('scopes only views without a Global form to a Workspace, so the empty state spares shared Timeline and Stats views', () => {
    expect(VIEWS.filter(isWorkspaceScopedView)).toEqual(['board', 'conversations', 'graph', 'table', 'files', 'workspace']);
    expect(isWorkspaceScopedView('activity')).toBe(false);
    expect(isWorkspaceScopedView('timeline')).toBe(false);
    expect(isWorkspaceScopedView('stats')).toBe(false);
    expect(isWorkspaceScopedView('api')).toBe(false);
    expect(isWorkspaceScopedView('settings')).toBe(false);
  });
});

describe('rail groups drive the divider structure', () => {
  const groupViews = (groups: typeof GLOBAL_RAIL_GROUPS) => groups.map((g) => g.views);

  it('splits the workspace rail into three divided groups in display order', () => {
    expect(groupViews(WORKSPACE_RAIL_GROUPS)).toEqual([
      ['board', 'conversations', 'table', 'files'],
      ['activity', 'graph', 'timeline', 'stats'],
      ['operations', 'workspace'],
    ]);
  });

  it('splits the global rail into three divided groups in display order', () => {
    expect(groupViews(GLOBAL_RAIL_GROUPS)).toEqual([
      ['board', 'table'],
      ['activity', 'timeline', 'stats'],
      ['operations', 'api', 'settings'],
    ]);
  });

  it('every grouped view stays within its scope validation set', () => {
    for (const v of WORKSPACE_RAIL_GROUPS.flatMap((g) => g.views)) expect(WORKSPACE_RAIL_VIEWS).toContain(v);
    for (const v of GLOBAL_RAIL_GROUPS.flatMap((g) => g.views)) expect(GLOBAL_RAIL_VIEWS).toContain(v);
  });

  it('labels the global board as Dashboard and statistics fully', () => {
    expect(GLOBAL_VIEW_LABELS.board).toBe('Dashboard');
    expect(VIEW_LABELS.stats).toBe('Statistics');
  });
});
