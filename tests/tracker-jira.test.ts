import { describe, it, expect } from 'vitest';
import { resolveTrackerAdapter, trackerRef, type TicketRef, type WritableTrackerAdapter } from '../src/tracker/adapter.js';
import { jiraKind } from '../src/tracker/jira.js';
import { parseBlockedByLines, parseBlockedBySection, parsePartOfParent } from '../src/tracker/relationships.js';

interface Call {
  method: string;
  pathname: string;
  search: URLSearchParams;
  headers: Record<string, string>;
  body: any;
}

const status = (name: string, key: string) => ({ name, statusCategory: { key } });
const TODO = status('To Do', 'new');
const DONE = status('Done', 'done');

const issue = (key: string, over: Record<string, unknown> = {}, summary = key.toLowerCase()) => ({
  key,
  fields: {
    summary,
    status: TODO,
    description: '',
    created: '2026-01-01T00:00:00Z',
    resolutiondate: null,
    labels: ['ready-for-agent'],
    assignee: null,
    issuetype: { name: 'Task' },
    issuelinks: [],
    ...over,
  },
});

interface FakeOpts {
  issues?: any[];
  transitions?: any[];
  me?: any;
  pages?: any[][];
  failMyself?: boolean;
  failTransition?: boolean;
  comments?: any[];
}

function fake(opts: FakeOpts = {}) {
  const calls: Call[] = [];
  const issues = opts.issues ?? [];
  const http = async (url: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const call: Call = {
      method: init?.method ?? 'GET',
      pathname: u.pathname.replace('/rest/api/2', ''),
      search: u.searchParams,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    const empty = () => new Response(null, { status: 204 });
    const p = call.pathname;
    if (p === '/search' || p === '/search/jql') {
      if (opts.pages) {
        const index = calls.filter((c) => c.pathname === p).length - 1;
        const page = opts.pages[index] ?? [];
        return ok(p === '/search/jql'
          ? { issues: page, ...(index < opts.pages.length - 1 && { nextPageToken: `tok${index + 1}` }) }
          : { total: opts.pages.flat().length, issues: page });
      }
      return ok(p === '/search/jql' ? { issues } : { total: issues.length, issues });
    }
    if (p === '/myself') return opts.failMyself ? new Response('Unauthorized', { status: 401 }) : ok(opts.me ?? { accountId: 'acc-1', name: 'jsmith', displayName: 'J Smith' });
    if (/\/assignee$/.test(p)) return empty();
    if (/\/comment$/.test(p)) return call.method === 'POST' ? ok({}) : ok({ comments: opts.comments ?? [] });
    if (/\/transitions$/.test(p)) {
      if (call.method === 'POST') return opts.failTransition ? new Response('boom', { status: 400 }) : empty();
      return ok({ transitions: opts.transitions ?? [] });
    }
    const m = /\/issue\/([^/]+)$/.exec(p);
    if (m) return ok(issues.find((i) => i.key === m[1]));
    return new Response('nope', { status: 404 });
  };
  return { http, calls, of: (path: string, method = 'GET') => calls.filter((c) => c.pathname === path && c.method === method) };
}

const cloudSettings = {
  baseUrl: 'https://acme.atlassian.net/',
  authMode: 'cloud',
  email: 'me@acme.test',
  projectKey: 'PROJ',
  secretName: 'JIRA_TOKEN',
};
const dcSettings = { baseUrl: 'https://jira.acme.test', authMode: 'datacenter', projectKey: 'PROJ', secretName: 'JIRA_TOKEN' };

function make(settings: Record<string, unknown>, f: ReturnType<typeof fake>) {
  return jiraKind.create({ settings: jiraKind.settings.parse(settings), secrets: { JIRA_TOKEN: 'tok' }, repoRoot: '/repo', http: f.http }) as WritableTrackerAdapter;
}
const ref = (key: string): TicketRef => ({ ref: trackerRef(key), title: key, state: 'open' });

describe('jira settings', () => {
  it('cloud requires an email', () => {
    expect(jiraKind.settings.safeParse({ ...cloudSettings, email: undefined }).success).toBe(false);
    expect(jiraKind.settings.safeParse(cloudSettings).success).toBe(true);
  });
  it('datacenter needs no email and trims the trailing slash', () => {
    expect(jiraKind.settings.parse({ ...dcSettings, baseUrl: 'https://jira.acme.test/' })).toMatchObject({ baseUrl: 'https://jira.acme.test' });
  });
  it('rejects unknown keys', () => {
    expect(jiraKind.settings.safeParse({ ...dcSettings, nope: 1 }).success).toBe(false);
  });
  it('declares its capabilities and is never a repository', () => {
    expect(jiraKind.capabilities).toEqual({ close: true, reopen: true, claim: true, transition: true, epicSources: ['issue-type'] });
  });
  it('create throws a clear error when the secret is missing', () => {
    expect(() => jiraKind.create({ settings: jiraKind.settings.parse(dcSettings), secrets: {}, repoRoot: '/r', http: fake().http })).toThrow(/JIRA_TOKEN/);
  });
  it('resolveTrackerAdapter passes workspace secrets to create', async () => {
    const adapter = await resolveTrackerAdapter('/nonexistent', undefined, {
      configured: { kind: 'jira', settings: dcSettings },
      secrets: { JIRA_TOKEN: 'tok' },
    });
    expect(adapter.name).toBe('jira');
    await expect(resolveTrackerAdapter('/nonexistent', undefined, { configured: { kind: 'jira', settings: dcSettings } })).rejects.toMatchObject({ code: 'misconfigured' });
  });
});

describe('jira auth and errors', () => {
  it('cloud sends Basic email:token', async () => {
    const f = fake();
    await make(cloudSettings, f).scan();
    expect(f.calls[0]!.headers.Authorization).toBe(`Basic ${Buffer.from('me@acme.test:tok').toString('base64')}`);
    expect(f.calls[0]!.headers.accept).toBe('application/json');
  });
  it('datacenter sends a Bearer PAT', async () => {
    const f = fake();
    await make(dcSettings, f).scan();
    expect(f.calls[0]!.headers.Authorization).toBe('Bearer tok');
  });
  it('non-2xx responses throw with status and body', async () => {
    const f = fake({ failTransition: true, transitions: [] });
    await expect(make(dcSettings, f).readTicket(ref('NOPE-1'))).rejects.toThrow();
    const a = make(dcSettings, fake({ failMyself: true }));
    await expect(a.claim(ref('PROJ-1'))).rejects.toThrow(/401 Unauthorized/);
  });
});

describe('jira scan', () => {
  it('composes JQL from the triage labels and extraJql', async () => {
    const f = fake();
    await make({ ...dcSettings, extraJql: 'component = web' }, f).scan();
    const q = f.of('/search')[0]!.search;
    expect(q.get('jql')).toBe(
      'project = PROJ AND labels in ("ready-for-agent", "ready-for-human", "epic", "wayfinder:map") AND (component = web)',
    );
    expect(q.get('maxResults')).toBe('100');
    expect(q.get('fields')).toContain('issuelinks');
  });
  it('keeps ORDER BY outside the extraJql parentheses', async () => {
    const f = fake();
    await make({ ...dcSettings, extraJql: 'component = web ORDER BY created DESC' }, f).scan();
    expect(f.of('/search')[0]!.search.get('jql')).toMatch(/AND \(component = web\) ORDER BY created DESC$/);
  });
  it('omits the extra clause when none is configured', async () => {
    const f = fake();
    await make(dcSettings, f).scan();
    expect(f.of('/search')[0]!.search.get('jql')).not.toContain('AND (');
  });
  it('normalises tickets in one request per page', async () => {
    const f = fake({
      issues: [
        issue('PROJ-1', { description: 'hello', assignee: { displayName: 'J Smith' }, labels: ['wayfinder:map'] }),
        issue('PROJ-2', { status: DONE, resolutiondate: '2026-01-05T00:00:00Z' }),
      ],
    });
    const [a, b] = await make(cloudSettings, f).scan();
    expect(f.calls).toHaveLength(1);
    expect(a).toMatchObject({
      ref: 'PROJ-1',
      state: 'open',
      body: 'hello',
      assignees: ['J Smith'],
      isMap: true,
      url: 'https://acme.atlassian.net/browse/PROJ-1',
      comments: [],
      closedAt: null,
    });
    expect(b).toMatchObject({ state: 'closed', closedAt: '2026-01-05T00:00:00Z' });
  });
  it('pages via startAt', async () => {
    const mk = (from: number, n: number) => Array.from({ length: n }, (_, i) => issue(`PROJ-${from + i}`));
    const f = fake({ pages: [mk(1, 100), mk(101, 5)] });
    const tickets = await make(dcSettings, f).scan();
    expect(tickets).toHaveLength(105);
    expect(f.of('/search').map((c) => c.search.get('startAt'))).toEqual(['0', '100']);
  });
  it('cloud searches /search/jql and pages by nextPageToken', async () => {
    const mk = (from: number, n: number) => Array.from({ length: n }, (_, i) => issue(`PROJ-${from + i}`));
    const f = fake({ pages: [mk(1, 100), mk(101, 5)] });
    const tickets = await make(cloudSettings, f).scan();
    expect(tickets).toHaveLength(105);
    expect(f.of('/search')).toHaveLength(0);
    expect(f.of('/search/jql').map((c) => c.search.get('nextPageToken'))).toEqual([null, 'tok1']);
  });
  it('ignores body tokens that look like keys outside the project', async () => {
    const f = fake({ issues: [issue('PROJ-2', { description: 'Depends on UTF-8 handling and PROJ-1' })] });
    const [t] = await make(dcSettings, f).scan();
    expect(t!.blockedBy.map((b) => b.ref)).toEqual(['PROJ-1']);
  });
  it('maps native parent, blockedBy and blocking', async () => {
    const f = fake({
      issues: [
        issue('PROJ-2', {
          parent: { key: 'PROJ-1' },
          issuelinks: [
            { type: { inward: 'is blocked by', outward: 'blocks' }, inwardIssue: { key: 'PROJ-3', fields: { summary: 'three', status: DONE } } },
            { type: { inward: 'is blocked by', outward: 'blocks' }, outwardIssue: { key: 'PROJ-4', fields: { summary: 'four', status: TODO } } },
            { type: { inward: 'is cloned by', outward: 'clones' }, outwardIssue: { key: 'PROJ-9', fields: { summary: 'nine', status: TODO } } },
          ],
        }),
      ],
    });
    const [t] = await make(cloudSettings, f).scan();
    expect(t!.parent).toBe('PROJ-1');
    expect(t!.blockedBy).toEqual([{ ref: 'PROJ-3', title: 'three', state: 'closed' }]);
    expect(t!.blocking).toEqual([{ ref: 'PROJ-4', title: 'four', state: 'open' }]);
  });
  it('adds the epic label for Epic issue types', async () => {
    const f = fake({ issues: [issue('PROJ-1', { issuetype: { name: 'epic' } }), issue('PROJ-2', { issuetype: { name: 'Epic' }, labels: ['epic'] })] });
    const [a, b] = await make(cloudSettings, f).scan();
    expect(a!.labels).toEqual(['ready-for-agent', 'epic']);
    expect(b!.labels).toEqual(['epic']);
  });
  it('adds body-derived edges without duplicating native ones or self', async () => {
    const f = fake({
      issues: [
        issue('PROJ-1', {}, 'one'),
        issue('PROJ-2', {
          description: 'Part of PROJ-1\n\nBlocked by: PROJ-1, PROJ-5, PROJ-2, PROJ-7',
          issuelinks: [{ type: { inward: 'is blocked by', outward: 'blocks' }, inwardIssue: { key: 'PROJ-7', fields: { summary: 'seven', status: TODO } } }],
        }),
      ],
    });
    const [, t] = await make(cloudSettings, f).scan();
    expect(t!.parent).toBe('PROJ-1');
    expect(t!.blockedBy.map((r) => r.ref)).toEqual(['PROJ-7', 'PROJ-1', 'PROJ-5']);
    expect(t!.blockedBy[1]).toMatchObject({ title: 'one', state: 'open' });
  });
});

describe('jira readTicket', () => {
  it('reads the issue and its comments', async () => {
    const f = fake({
      issues: [issue('PROJ-1')],
      comments: [
        { author: { displayName: 'Ann' }, body: 'first', created: '2026-01-02T00:00:00Z' },
        { author: { name: 'bob' }, body: 'second', created: '2026-01-03T00:00:00Z' },
      ],
    });
    const t = await make(cloudSettings, f).readTicket(ref('PROJ-1'));
    expect(t.ref).toBe('PROJ-1');
    expect(t.comments).toEqual([
      { author: 'Ann', body: 'first', createdAt: '2026-01-02T00:00:00Z' },
      { author: 'bob', body: 'second', createdAt: '2026-01-03T00:00:00Z' },
    ]);
  });
});

describe('jira claim and release', () => {
  it('cloud assigns by accountId', async () => {
    const f = fake();
    await make(cloudSettings, f).claim(ref('PROJ-1'));
    expect(f.of('/issue/PROJ-1/assignee', 'PUT')[0]!.body).toEqual({ accountId: 'acc-1' });
  });
  it('datacenter assigns by name', async () => {
    const f = fake();
    await make(dcSettings, f).claim(ref('PROJ-1'));
    expect(f.of('/issue/PROJ-1/assignee', 'PUT')[0]!.body).toEqual({ name: 'jsmith' });
  });
  it('caches /myself', async () => {
    const f = fake();
    const a = make(dcSettings, f);
    await a.claim(ref('PROJ-1'));
    await a.claim(ref('PROJ-2'));
    expect(f.of('/myself')).toHaveLength(1);
  });
  it('release unassigns only when assigned to me', async () => {
    const mine = fake({ issues: [issue('PROJ-1', { assignee: { accountId: 'acc-1' } })] });
    await make(cloudSettings, mine).release(ref('PROJ-1'));
    expect(mine.of('/issue/PROJ-1/assignee', 'PUT')[0]!.body).toEqual({ accountId: null });

    const dc = fake({ issues: [issue('PROJ-1', { assignee: { name: 'jsmith' } })] });
    await make(dcSettings, dc).release(ref('PROJ-1'));
    expect(dc.of('/issue/PROJ-1/assignee', 'PUT')[0]!.body).toEqual({ name: null });

    const other = fake({ issues: [issue('PROJ-1', { assignee: { accountId: 'someone-else' } })] });
    await make(cloudSettings, other).release(ref('PROJ-1'));
    expect(other.of('/issue/PROJ-1/assignee', 'PUT')).toHaveLength(0);

    const none = fake({ issues: [issue('PROJ-1')] });
    await make(cloudSettings, none).release(ref('PROJ-1'));
    expect(none.of('/issue/PROJ-1/assignee', 'PUT')).toHaveLength(0);
  });
  it('claim transitions to pickupStatus when configured', async () => {
    const f = fake({
      issues: [issue('PROJ-1')],
      transitions: [
        { id: '31', name: 'Start', to: status('In Progress', 'indeterminate') },
        { id: '11', name: 'Done', to: DONE },
      ],
    });
    await make({ ...dcSettings, pickupStatus: 'in progress' }, f).claim(ref('PROJ-1'));
    expect(f.of('/issue/PROJ-1/transitions', 'POST')[0]!.body).toEqual({ transition: { id: '31' } });
  });
  it('claim skips the pickup transition when already there, unavailable, or failing', async () => {
    const already = fake({ issues: [issue('PROJ-1', { status: status('In Progress', 'indeterminate') })] });
    await make({ ...dcSettings, pickupStatus: 'In Progress' }, already).claim(ref('PROJ-1'));
    expect(already.of('/issue/PROJ-1/transitions', 'POST')).toHaveLength(0);

    const none = fake({ issues: [issue('PROJ-1')], transitions: [{ id: '11', name: 'Done', to: DONE }] });
    await expect(make({ ...dcSettings, pickupStatus: 'In Progress' }, none).claim(ref('PROJ-1'))).resolves.toBeUndefined();
    expect(none.of('/issue/PROJ-1/transitions', 'POST')).toHaveLength(0);

    const failing = fake({ issues: [issue('PROJ-1')], failTransition: true, transitions: [{ id: '31', name: 'Start', to: status('In Progress', 'indeterminate') }] });
    await expect(make({ ...dcSettings, pickupStatus: 'In Progress' }, failing).claim(ref('PROJ-1'))).resolves.toBeUndefined();
  });
});

describe('jira close and reopen', () => {
  const transitions = [
    { id: '11', name: 'Start', to: status('In Progress', 'indeterminate') },
    { id: '21', name: 'Won\'t do', to: status('Rejected', 'done') },
    { id: '22', name: 'Finish', to: status('Resolved', 'done') },
    { id: '41', name: 'Back', to: status('Backlog', 'new') },
  ];

  const open = [issue('PROJ-1', { status: status('In Progress', 'indeterminate') })];
  it('close transitions first, then comments, using the configured doneStatus (case-insensitive)', async () => {
    const f = fake({ transitions, issues: open });
    await make({ ...dcSettings, doneStatus: 'resolved' }, f).close(ref('PROJ-1'), 'shipped');
    expect(f.calls.map((c) => `${c.method} ${c.pathname}`)).toEqual([
      'GET /issue/PROJ-1',
      'GET /issue/PROJ-1/transitions',
      'POST /issue/PROJ-1/transitions',
      'POST /issue/PROJ-1/comment',
    ]);
    expect(f.calls[2]!.body).toEqual({ transition: { id: '22' } });
    expect(f.calls[3]!.body).toEqual({ body: 'shipped' });
  });
  it('close falls back to the first done-category transition', async () => {
    const f = fake({ transitions, issues: open });
    await make(dcSettings, f).close(ref('PROJ-1'), '');
    expect(f.of('/issue/PROJ-1/comment', 'POST')).toHaveLength(0);
    expect(f.of('/issue/PROJ-1/transitions', 'POST')[0]!.body).toEqual({ transition: { id: '21' } });
  });
  it('reopen uses the configured status, else the first new-category transition', async () => {
    const named = fake({ transitions, issues: open });
    await make({ ...dcSettings, reopenStatus: 'In Progress' }, named).reopen(ref('PROJ-1'), 'again');
    expect(named.of('/issue/PROJ-1/transitions', 'POST')[0]!.body).toEqual({ transition: { id: '11' } });

    const fallback = fake({ transitions, issues: open });
    await make(dcSettings, fallback).reopen(ref('PROJ-1'), '');
    expect(fallback.of('/issue/PROJ-1/transitions', 'POST')[0]!.body).toEqual({ transition: { id: '41' } });
  });
  it('a configured status that is unavailable falls back to the category', async () => {
    const f = fake({ transitions, issues: open });
    await make({ ...dcSettings, doneStatus: 'Nonexistent' }, f).close(ref('PROJ-1'), '');
    expect(f.of('/issue/PROJ-1/transitions', 'POST')[0]!.body).toEqual({ transition: { id: '21' } });
  });
  it('throws listing the available transitions when none match', async () => {
    const f = fake({ issues: open, transitions: [{ id: '11', name: 'Start', to: status('In Progress', 'indeterminate') }] });
    await expect(make(dcSettings, f).close(ref('PROJ-1'), '')).rejects.toThrow(/Start -> In Progress/);
    expect(f.of('/issue/PROJ-1/transitions', 'POST')).toHaveLength(0);
  });
  it('is a no-op without a comment when the ticket is already in the target category', async () => {
    const f = fake({ transitions, issues: [issue('PROJ-1', { status: DONE })] });
    await make(dcSettings, f).close(ref('PROJ-1'), 'dup');
    expect(f.of('/issue/PROJ-1/comment', 'POST')).toHaveLength(0);
    expect(f.of('/issue/PROJ-1/transitions', 'POST')).toHaveLength(0);
  });
  it('posts no comment when no transition is available', async () => {
    const f = fake({ issues: open, transitions: [] });
    await expect(make(dcSettings, f).close(ref('PROJ-1'), 'x')).rejects.toThrow();
    expect(f.of('/issue/PROJ-1/comment', 'POST')).toHaveLength(0);
  });
});

describe('jira verify', () => {
  it('is ok when /myself answers', async () => {
    const f = fake();
    await expect(make(dcSettings, f).verify!()).resolves.toEqual({ ok: true });
    expect(f.calls[0]!.pathname).toBe('/myself');
  });
  it('reports the HTTP failure and never throws', async () => {
    const res = await make(dcSettings, fake({ failMyself: true })).verify!();
    expect(res).toMatchObject({ ok: false });
    if (!res.ok) expect(res.reason).toMatch(/401/);
  });
});

describe('relationship parsers with Jira keys', () => {
  it('reads keys in Blocked by lines, sections and Part of', () => {
    expect(parseBlockedByLines('Blocked by: PROJ-1, ABC_D-22 and blocks PROJ-3', 'jira')).toEqual(['PROJ-1', 'ABC_D-22']);
    expect(parseBlockedBySection('## Blocked by\n- PROJ-4\n- PROJ-5\n\nPROJ-6', 'jira')).toEqual(['PROJ-4', 'PROJ-5']);
    expect(parsePartOfParent('Part of epic PROJ-9', 'jira')).toBe('PROJ-9');
    expect(parsePartOfParent('nothing here PROJ-9', 'jira')).toBeNull();
  });
  it('keeps the numeric default', () => {
    expect(parseBlockedByLines('Blocked by #1, #2')).toEqual([1, 2]);
    expect(parsePartOfParent('Part of #7')).toBe(7);
  });
});

describe('jira lifecycle writes are idempotent', () => {
  const transitions = [{ id: '22', name: 'Finish', to: status('Resolved', 'done') }];

  it('close on an already-done issue neither transitions nor comments', async () => {
    const done = [issue('PROJ-1', { status: status('Resolved', 'done') })];
    const f = fake({ transitions, issues: done });
    await make(dcSettings, f).close!(ref('PROJ-1'), 'shipped');
    expect(f.calls.map((c) => `${c.method} ${c.pathname}`)).toEqual(['GET /issue/PROJ-1']);
  });

  it('a failed transition posts no comment', async () => {
    const f = fake({ transitions, issues: [issue('PROJ-1', { status: status('In Progress', 'indeterminate') })], failTransition: true });
    await expect(make(dcSettings, f).close!(ref('PROJ-1'), 'shipped')).rejects.toThrow();
    expect(f.of('/issue/PROJ-1/comment', 'POST')).toEqual([]);
  });

  it('identify names the account', async () => {
    expect(await make(cloudSettings, fake()).identify!()).toBe('J Smith');
    expect(await make(dcSettings, fake()).identify!()).toBe('J Smith');
  });
});
