import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ROUTE,
  DEFAULT_TABLE_FILTERS,
  parseRoute,
  serializeRoute,
  type Route,
} from '../web/src/router-model.js';

describe('parseRoute', () => {
  it('defaults to the board with no filters when the query is empty', () => {
    expect(parseRoute('')).toEqual(DEFAULT_ROUTE);
    expect(parseRoute('?')).toEqual(DEFAULT_ROUTE);
  });

  it('reads the active view', () => {
    expect(parseRoute('?view=table').view).toBe('table');
    expect(parseRoute('?view=stats').view).toBe('stats');
  });

  it('falls back to the board for an unknown or missing view', () => {
    expect(parseRoute('?view=bogus').view).toBe('board');
    expect(parseRoute('?view=').view).toBe('board');
  });

  it('parses the board peeked columns, dropping unknown states and duplicates', () => {
    expect(parseRoute('?peek=completed,failed').peeked).toEqual(['completed', 'failed']);
    expect(parseRoute('?peek=completed,bogus,completed').peeked).toEqual(['completed']);
    expect(parseRoute('?peek=').peeked).toEqual([]);
  });

  it('drops non-terminal states from peek — only terminal columns are peekable', () => {
    // running/ready aren't collapsible columns, so they can never be "peeked".
    expect(parseRoute('?peek=running,ready').peeked).toEqual([]);
    expect(parseRoute('?peek=completed,running,cancelled').peeked).toEqual(['completed', 'cancelled']);
  });

  it('parses table filters and validates each against its allowed set', () => {
    const t = parseRoute('?view=table&state=running&harness=claude&priority=high&sort=cost&order=asc').table;
    expect(t).toEqual({ state: 'running', harness: 'claude', priority: 'high', sortBy: 'cost', order: 'asc' });
  });

  it('drops invalid table filter values back to their defaults', () => {
    const t = parseRoute('?state=nope&harness=nope&priority=nope&sort=nope&order=nope').table;
    expect(t).toEqual(DEFAULT_TABLE_FILTERS);
  });

  it('accepts a full URL, a search string, or a bare query', () => {
    expect(parseRoute('https://host/app?view=stats').view).toBe('stats');
    expect(parseRoute('?view=stats').view).toBe('stats');
    expect(parseRoute('view=stats').view).toBe('stats');
  });
});

describe('serializeRoute', () => {
  it('serializes the all-default board route to an empty string (clean URL)', () => {
    expect(serializeRoute(DEFAULT_ROUTE)).toBe('');
  });

  it('omits the view param for the board, emits it otherwise', () => {
    expect(serializeRoute({ ...DEFAULT_ROUTE, view: 'board' })).toBe('');
    expect(serializeRoute({ ...DEFAULT_ROUTE, view: 'table' })).toBe('?view=table');
  });

  it('emits peeked columns in TASK_STATES order regardless of input order', () => {
    expect(serializeRoute({ ...DEFAULT_ROUTE, peeked: ['failed', 'completed'] })).toBe('?peek=completed%2Cfailed');
  });

  it('omits default-valued table filters', () => {
    expect(serializeRoute({ ...DEFAULT_ROUTE, view: 'table', table: DEFAULT_TABLE_FILTERS })).toBe('?view=table');
  });

  it('emits only the non-default table filters', () => {
    const route: Route = {
      ...DEFAULT_ROUTE,
      view: 'table',
      table: { state: 'running', harness: '', priority: '', sortBy: 'cost', order: 'asc' },
    };
    const parsed = parseRoute(serializeRoute(route));
    expect(parsed.table).toEqual(route.table);
    expect(parsed.view).toBe('table');
  });
});

describe('round-trip', () => {
  const routes: Route[] = [
    DEFAULT_ROUTE,
    { view: 'table', peeked: [], table: { state: 'running', harness: 'codex', priority: 'low', sortBy: 'priority', order: 'asc' } },
    { view: 'board', peeked: ['completed', 'failed', 'cancelled'], table: DEFAULT_TABLE_FILTERS },
    { view: 'stats', peeked: ['completed'], table: { ...DEFAULT_TABLE_FILTERS, sortBy: 'cost' } },
  ];

  it('serialize → parse is the identity on normalized routes', () => {
    for (const route of routes) {
      expect(parseRoute(serializeRoute(route))).toEqual(route);
    }
  });
});
