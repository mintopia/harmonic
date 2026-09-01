import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ROUTE,
  DEFAULT_TABLE_FILTERS,
  parseRoute,
  serializeRoute,
  type Route,
} from '../web/src/router-model.js';

describe('parseRoute', () => {
  it('defaults to the deck with no filters when the query is empty', () => {
    expect(parseRoute('/', '')).toEqual(DEFAULT_ROUTE);
    expect(parseRoute('/', '?')).toEqual(DEFAULT_ROUTE);
  });

  it('reads the active view', () => {
    expect(parseRoute('/', '?view=table').view).toBe('table');
    expect(parseRoute('/', '?view=stats').view).toBe('stats');
    expect(parseRoute('/', '?view=operations').view).toBe('operations');
  });

  it('falls back to the deck for an unknown or missing view', () => {
    expect(parseRoute('/', '?view=bogus').view).toBe('board');
    expect(parseRoute('/', '?view=').view).toBe('board');
  });

  it('parses the board peeked columns, dropping unknown states and duplicates', () => {
    expect(parseRoute('/', '?peek=done,cancelled').peeked).toEqual(['done', 'cancelled']);
    expect(parseRoute('/', '?peek=done,bogus,done').peeked).toEqual(['done']);
    expect(parseRoute('/', '?peek=').peeked).toEqual([]);
  });

  it('drops non-terminal states from peek — only terminal columns are peekable', () => {
    expect(parseRoute('/', '?peek=working,ready,escalated').peeked).toEqual([]);
    expect(parseRoute('/', '?peek=done,working,cancelled').peeked).toEqual(['done', 'cancelled']);
  });

  it('parses table filters and validates each against its allowed set', () => {
    const t = parseRoute('/', '?view=table&state=working&harness=claude&priority=high&sort=cost&order=asc').table;
    expect(t).toEqual({
      state: ['working'],
      harness: ['claude'],
      priority: ['high'],
      search: '',
      sortBy: 'cost',
      order: 'asc',
    });
  });

  it('parses multi-select filters (comma-separated), dropping invalid values and duplicates', () => {
    const t = parseRoute('/', '?view=table&state=working,ready,bogus,working&harness=claude,codex&priority=high,low').table;
    expect(t.state).toEqual(['working', 'ready']);
    expect(t.harness).toEqual(['claude', 'codex']);
    expect(t.priority).toEqual(['high', 'low']);
  });

  it('drops invalid table filter values back to their defaults', () => {
    const t = parseRoute('/', '?state=nope&harness=nope&priority=nope&sort=nope&order=nope').table;
    expect(t).toEqual(DEFAULT_TABLE_FILTERS);
  });

  it('accepts a full URL, a search string, or a bare query', () => {
    expect(parseRoute('/', 'https://host/app?view=stats').view).toBe('stats');
    expect(parseRoute('/', '?view=stats').view).toBe('stats');
    expect(parseRoute('/', 'view=stats').view).toBe('stats');
  });
});

describe('parseRoute — Ticket path (#181)', () => {
  it('reads a focused Task id from /task/:id, defaulting the view to deck', () => {
    const route = parseRoute('/task/172', '');
    expect(route.task).toBe(172);
    expect(route.view).toBe('board');
  });

  it('carries the underlying view alongside the Ticket id', () => {
    const route = parseRoute('/task/172', '?view=table');
    expect(route.task).toBe(172);
    expect(route.view).toBe('table');
  });

  it('rejects a zero, non-numeric, or missing id — no Ticket focused', () => {
    expect(parseRoute('/task/0', '').task).toBeNull();
    expect(parseRoute('/task/abc', '').task).toBeNull();
    expect(parseRoute('/task/', '').task).toBeNull();
  });

  it('has no Ticket focused on the root path', () => {
    expect(parseRoute('/', '').task).toBeNull();
  });
});

describe('parseRoute — Epic summary path (ADR-0017)', () => {
  it('reads a focused Epic ref from /epic/:ref, defaulting the view to deck', () => {
    const route = parseRoute('/epic/421', '');
    expect(route.epic).toBe(421);
    expect(route.task).toBeNull();
    expect(route.view).toBe('board');
  });

  it('carries the underlying view alongside the Epic ref', () => {
    const route = parseRoute('/epic/421', '?view=table');
    expect(route.epic).toBe(421);
    expect(route.view).toBe('table');
  });

  it('rejects a zero, non-numeric, or missing ref — no Epic focused', () => {
    expect(parseRoute('/epic/0', '').epic).toBeNull();
    expect(parseRoute('/epic/abc', '').epic).toBeNull();
    expect(parseRoute('/epic/', '').epic).toBeNull();
  });

  it('has no Epic focused on the root or a Ticket path', () => {
    expect(parseRoute('/', '').epic).toBeNull();
    expect(parseRoute('/task/172', '').epic).toBeNull();
  });
});

describe('serializeRoute', () => {
  it('serializes the all-default deck route to the root path (clean URL)', () => {
    expect(serializeRoute(DEFAULT_ROUTE)).toBe('/');
  });

  it('omits the view param for the deck, emits it otherwise', () => {
    expect(serializeRoute({ ...DEFAULT_ROUTE, view: 'board' })).toBe('/');
    expect(serializeRoute({ ...DEFAULT_ROUTE, view: 'table' })).toBe('/?view=table');
    expect(serializeRoute({ ...DEFAULT_ROUTE, view: 'operations' })).toBe('/?view=operations');
  });

  it('emits peeked columns in TASK_STATES order regardless of input order', () => {
    expect(serializeRoute({ ...DEFAULT_ROUTE, peeked: ['cancelled', 'done'] })).toBe('/?peek=done%2Ccancelled');
  });

  it('omits default-valued table filters', () => {
    expect(serializeRoute({ ...DEFAULT_ROUTE, view: 'table', table: DEFAULT_TABLE_FILTERS })).toBe('/?view=table');
  });

  it('emits only the non-default table filters', () => {
    const route: Route = {
      ...DEFAULT_ROUTE,
      view: 'table',
      table: { state: ['working'], harness: [], priority: [], search: '', sortBy: 'cost', order: 'asc' },
    };
    const parsed = parseRoute('/', serializeRoute(route));
    expect(parsed.table).toEqual(route.table);
    expect(parsed.view).toBe('table');
  });

  it('builds a /task/:id path when a Ticket is focused', () => {
    expect(serializeRoute({ ...DEFAULT_ROUTE, task: 172 })).toBe('/task/172');
  });

  it('carries the underlying view as a query param on the Ticket path', () => {
    expect(serializeRoute({ ...DEFAULT_ROUTE, view: 'table', task: 172 })).toBe('/task/172?view=table');
  });

  it('builds an /epic/:ref path when an Epic is focused (ADR-0017)', () => {
    expect(serializeRoute({ ...DEFAULT_ROUTE, epic: 421 })).toBe('/epic/421');
    expect(serializeRoute({ ...DEFAULT_ROUTE, view: 'table', epic: 421 })).toBe('/epic/421?view=table');
  });
});

describe('search', () => {
  it('parses the q param into table.search', () => {
    expect(parseRoute('/', '?q=rate%20limit').table.search).toBe('rate limit');
  });

  it('defaults to an empty search when q is absent', () => {
    expect(parseRoute('/', '').table.search).toBe('');
  });

  it('serializes a non-empty search to the q param', () => {
    const qs = serializeRoute({
      ...DEFAULT_ROUTE,
      view: 'table',
      table: { ...DEFAULT_TABLE_FILTERS, search: 'boom' },
    });
    expect(qs.includes('q=boom')).toBe(true);
  });

  it('round-trips a search through serialize → parse', () => {
    const route: Route = {
      ...DEFAULT_ROUTE,
      view: 'table',
      table: { ...DEFAULT_TABLE_FILTERS, search: 'rate limit' },
    };
    const url = serializeRoute(route);
    const u = new URL(url, 'http://x');
    expect(parseRoute(u.pathname, u.search)).toEqual(route);
  });
});

describe('round-trip', () => {
  const routes: Route[] = [
    DEFAULT_ROUTE,
    {
      ...DEFAULT_ROUTE,
      view: 'table',
      table: { state: ['working'], harness: ['codex'], priority: ['low'], search: '', sortBy: 'priority', order: 'asc' },
    },
    { ...DEFAULT_ROUTE, peeked: ['done', 'cancelled'] },
    { ...DEFAULT_ROUTE, view: 'stats', peeked: ['done'], table: { ...DEFAULT_TABLE_FILTERS, sortBy: 'cost' } },
    { ...DEFAULT_ROUTE, task: 172 },
    { ...DEFAULT_ROUTE, view: 'table', task: 42, table: { ...DEFAULT_TABLE_FILTERS, priority: ['high'] } },
    {
      ...DEFAULT_ROUTE,
      view: 'stats',
      task: 9,
      peeked: ['done', 'cancelled'],
      table: { ...DEFAULT_TABLE_FILTERS, search: 'timeout', order: 'asc' },
    },
    { ...DEFAULT_ROUTE, epic: 421 },
    { ...DEFAULT_ROUTE, view: 'table', epic: 421, table: { ...DEFAULT_TABLE_FILTERS, priority: ['high'] } },
  ];

  it('serialize → parse is the identity on normalized routes', () => {
    for (const route of routes) {
      const url = serializeRoute(route);
      const u = new URL(url, 'http://x');
      expect(parseRoute(u.pathname, u.search)).toEqual(route);
    }
  });
});

describe('detail-page rail selection (panel)', () => {
  it('parses each panel form on a Ticket or Epic path', () => {
    expect(parseRoute('/task/12', '?panel=stats').panel).toEqual({ kind: 'stats' });
    expect(parseRoute('/task/12', '?panel=timeline').panel).toEqual({ kind: 'timeline' });
    expect(parseRoute('/task/12', '?panel=changes').panel).toEqual({ kind: 'changes' });
    expect(parseRoute('/task/12', '?panel=attempt:3').panel).toEqual({ kind: 'attempt', attemptNumber: 3 });
    expect(parseRoute('/epic/5', '?panel=file:src/a%2Fb.ts').panel).toEqual({ kind: 'file', path: 'src/a/b.ts' });
  });

  it('falls back to the default panel for a malformed or absent value', () => {
    expect(parseRoute('/task/12', '').panel).toEqual({ kind: 'none' });
    expect(parseRoute('/task/12', '?panel=bogus').panel).toEqual({ kind: 'none' });
    expect(parseRoute('/task/12', '?panel=attempt:zero').panel).toEqual({ kind: 'none' });
    expect(parseRoute('/task/12', '?panel=attempt:0').panel).toEqual({ kind: 'none' });
    expect(parseRoute('/task/12', '?panel=file:').panel).toEqual({ kind: 'none' });
  });

  it('ignores a panel outside a detail page', () => {
    expect(parseRoute('/', '?view=table&panel=timeline').panel).toEqual({ kind: 'none' });
  });

  it('round-trips through serializeRoute and omits the default panel', () => {
    const base: Route = { ...DEFAULT_ROUTE, task: 12 };
    expect(serializeRoute(base)).toBe('/task/12');
    for (const panel of [
      { kind: 'stats' },
      { kind: 'timeline' },
      { kind: 'changes' },
      { kind: 'attempt', attemptNumber: 3 },
      { kind: 'file', path: 'web/src/App.tsx' },
    ] as const) {
      const url = serializeRoute({ ...base, panel });
      expect(parseRoute('/task/12', url.slice(url.indexOf('?'))).panel).toEqual(panel);
    }
    expect(serializeRoute({ ...DEFAULT_ROUTE, panel: { kind: 'timeline' } })).toBe('/');
  });
});
