import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ROUTE,
  DEFAULT_TABLE_FILTERS,
  LAST_ROUTE_KEY,
  loadLastRoute,
  parseRoute,
  scopeSwitchRoute,
  serializeRoute,
  storeLastRoute,
  type Route,
} from '../web/src/router-model.js';

const workspace = (view: Route['view'] = 'board'): Route => ({
  ...DEFAULT_ROUTE, scope: { kind: 'workspace', workspaceId: 42 }, view,
});

describe('path routes', () => {
  it.each([
    ['/', 'board'], ['/tasks', 'table'], ['/activity', 'activity'], ['/timeline', 'timeline'],
    ['/stats', 'stats'], ['/operations', 'operations'], ['/api', 'api'], ['/settings', 'settings'],
  ] as const)('parses global %s', (path, view) => {
    expect(parseRoute(path, '').scope).toEqual({ kind: 'global' });
    expect(parseRoute(path, '').view).toBe(view);
  });

  it.each([
    ['board', 'board'], ['conversations', 'conversations'], ['graph', 'graph'], ['activity', 'activity'],
    ['tasks', 'table'], ['timeline', 'timeline'], ['stats', 'stats'], ['files', 'files'],
    ['operations', 'operations'], ['settings', 'workspace'],
  ] as const)('parses workspace %s', (segment, view) => {
    const route = parseRoute(`/workspace/42/${segment}`, '');
    expect(route).toMatchObject({ scope: { kind: 'workspace', workspaceId: 42 }, view });
  });

  it('drops retired view and identity query parameters', () => {
    const route = parseRoute('/tasks', '?view=board&task=12&conversation=4');
    expect(route).toMatchObject({ scope: { kind: 'global' }, view: 'table', task: null, conversation: null });
    expect(serializeRoute(route)).toBe('/tasks');
  });

  it('keeps filters, but only filters, in the query string', () => {
    const route = parseRoute('/workspace/42/tasks', '?q=retry&state=working&sort=cost&order=asc');
    expect(route.table).toEqual({ ...DEFAULT_TABLE_FILTERS, search: 'retry', state: ['working'], sortBy: 'cost', order: 'asc' });
    expect(serializeRoute(route)).toBe('/workspace/42/tasks?state=working&q=retry&sort=cost&order=asc');
  });

  it('uses nested workspace paths for task, epic, conversation, and file selections', () => {
    expect(parseRoute('/workspace/42/task/12/timeline', '')).toMatchObject({ task: 12, panel: { kind: 'timeline' } });
    expect(parseRoute('/workspace/42/epic/7/attempt/3', '')).toMatchObject({ epic: 7, panel: { kind: 'attempt', attemptNumber: 3 } });
    expect(parseRoute('/workspace/42/conversations/8', '')).toMatchObject({ conversation: 8, view: 'conversations' });
    expect(serializeRoute({ ...workspace('files'), file: 'src/app.ts' })).toBe('/workspace/42/files/src/app.ts');
  });

  it('round-trips canonical locations and rejects invalid workspace ids', () => {
    for (const route of [DEFAULT_ROUTE, workspace('graph'), { ...workspace(), task: 5, panel: { kind: 'changes' } } as Route]) {
      const url = serializeRoute(route);
      const parsed = new URL(url, 'http://harmonic.local');
      expect(parseRoute(parsed.pathname, parsed.search)).toEqual(route);
    }
    expect(parseRoute('/workspace/0/tasks', '')).toEqual(DEFAULT_ROUTE);
  });
});

describe('scope switching', () => {
  it('maps shared pages and falls back for scope-only pages', () => {
    expect(scopeSwitchRoute(workspace('table'), { kind: 'global' }).view).toBe('table');
    expect(scopeSwitchRoute(workspace('graph'), { kind: 'global' }).view).toBe('board');
    expect(scopeSwitchRoute({ ...DEFAULT_ROUTE, view: 'api' }, { kind: 'workspace', workspaceId: 7 })).toMatchObject({ view: 'board', scope: { kind: 'workspace', workspaceId: 7 } });
    expect(scopeSwitchRoute({ ...DEFAULT_ROUTE, view: 'settings' }, { kind: 'workspace', workspaceId: 7 }).view).toBe('workspace');
  });
});

describe('last route storage', () => {
  it('restores a valid stored path and falls back to Dashboard', () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) };
    storeLastRoute(storage, workspace('stats'));
    expect(values.get(LAST_ROUTE_KEY)).toBe('/workspace/42/stats');
    expect(loadLastRoute(storage)).toMatchObject({ scope: { kind: 'workspace', workspaceId: 42 }, view: 'stats' });
    values.set(LAST_ROUTE_KEY, 'https://bad.example/');
    expect(loadLastRoute(storage)).toEqual(DEFAULT_ROUTE);
  });
});
