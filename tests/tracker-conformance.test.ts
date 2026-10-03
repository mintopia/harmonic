import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TRACKER_KINDS } from '../src/tracker/kinds.js';
import type { CliRunner, TrackerKind } from '../src/tracker/kind.js';
import { type TrackerAdapter, trackerRef } from '../src/tracker/adapter.js';
import { fakeForgejo, issue } from './helpers/fake-forgejo.js';

/** Three tickets every kind is seeded with: #1 open, #2 open and blocked by #1, #3 closed. */
interface Harness {
  adapter: TrackerAdapter;
  /** Ticket numbers the adapter has closed / reopened since creation. */
  closed(): number[];
  reopened(): number[];
  /** The tracker's ref for seeded ticket n (`1`, or `PROJ-1` on Jira). */
  ref?(n: number): string;
}

const noHttp = async (): Promise<Response> => {
  throw new Error('unexpected http call');
};

const ghIssue = (number: number, title: string, over: Record<string, unknown> = {}) => ({
  number,
  title,
  state: 'OPEN',
  body: '',
  createdAt: '2026-01-01T00:00:00Z',
  closedAt: null,
  labels: [],
  assignees: [],
  comments: [],
  parent: null,
  blockedBy: null,
  blocking: null,
  url: `https://example.test/${number}`,
  ...over,
});

function githubHarness(kind: TrackerKind<any>): Harness {
  const issues = [
    ghIssue(1, 'Alpha', { blocking: { nodes: [{ number: 2, title: 'Beta', state: 'OPEN' }] } }),
    ghIssue(2, 'Beta', { body: 'Blocked by: #1' }),
    ghIssue(3, 'Gamma', { state: 'CLOSED', closedAt: '2026-01-02T00:00:00Z' }),
  ];
  const closed: number[] = [];
  const reopened: number[] = [];
  const run: CliRunner = async (args) => {
    if (args[0] === 'issue' && args[1] === 'list') return JSON.stringify(issues);
    if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify(issues.find((i) => i.number === Number(args[2])));
    if (args[0] === 'issue' && args[1] === 'close') closed.push(Number(args[2]));
    if (args[0] === 'issue' && args[1] === 'reopen') reopened.push(Number(args[2]));
    return '';
  };
  const adapter = kind.create({ settings: kind.settings.parse({}), secrets: {}, repoRoot: '/repo', http: noHttp, run });
  return { adapter, closed: () => closed, reopened: () => reopened };
}

function gitlabHarness(kind: TrackerKind<any>): Harness {
  const glIssue = (iid: number, title: string, state: string, description: string) => ({
    iid,
    title,
    state,
    description,
    created_at: '2026-01-01T00:00:00Z',
    closed_at: state === 'closed' ? '2026-01-02T00:00:00Z' : null,
    labels: [],
    assignees: [],
    web_url: `https://example.test/${iid}`,
  });
  const issues = [glIssue(1, 'Alpha', 'opened', ''), glIssue(2, 'Beta', 'opened', 'Blocked by #1'), glIssue(3, 'Gamma', 'closed', '')];
  const closed: number[] = [];
  const reopened: number[] = [];
  const run: CliRunner = async (args) => {
    const endpoint = args.at(-1)!;
    if (endpoint.includes('state_event=close')) closed.push(Number(/issues\/(\d+)/.exec(endpoint)![1]));
    else if (endpoint.includes('state_event=reopen')) reopened.push(Number(/issues\/(\d+)/.exec(endpoint)![1]));
    else if (endpoint === 'user') return JSON.stringify({ id: 9, username: 'me' });
    else if (/\/issues\/\d+\/notes/.test(endpoint)) return '[]';
    else if (/\/issues\/\d+$/.test(endpoint)) return JSON.stringify(issues.find((i) => endpoint.endsWith(`/${i.iid}`)));
    else if (/\/issues\?/.test(endpoint)) return JSON.stringify(issues);
    return '';
  };
  const adapter = kind.create({ settings: kind.settings.parse({ project: 'g/r' }), secrets: {}, repoRoot: '/repo', http: noHttp, run });
  return { adapter, closed: () => closed, reopened: () => reopened };
}

function forgejoHarness(kind: TrackerKind<any>): Harness {
  const fake = fakeForgejo({
    issues: [issue(1, 'Alpha'), issue(2, 'Beta', { body: 'Blocked by: #1' }), issue(3, 'Gamma', { state: 'closed' })],
  });
  const adapter = kind.create({
    settings: kind.settings.parse({ baseUrl: 'https://forge.test', repo: 'owner/name' }),
    secrets: { FORGEJO_TOKEN: 'good' },
    repoRoot: '/repo',
    http: fake.http,
  });
  const initiallyClosed = new Set([3]);
  return {
    adapter,
    closed: () => fake.issues.filter((i) => i.state === 'closed' && !initiallyClosed.has(i.number)).map((i) => i.number),
    reopened: () => fake.issues.filter((i) => i.state === 'open' && initiallyClosed.has(i.number)).map((i) => i.number),
  };
}

function jiraHarness(kind: TrackerKind<any>): Harness {
  const jiraIssue = (n: number, summary: string, done: boolean, links: unknown[] = []) => ({
    key: `PROJ-${n}`,
    fields: {
      summary,
      status: { name: done ? 'Done' : 'To Do', statusCategory: { key: done ? 'done' : 'new' } },
      description: '',
      created: '2026-01-01T00:00:00Z',
      resolutiondate: done ? '2026-01-02T00:00:00Z' : null,
      labels: [],
      assignee: null,
      issuetype: { name: 'Task' },
      issuelinks: links,
    },
  });
  const linked = (n: number, summary: string) => ({ key: `PROJ-${n}`, fields: { summary, status: { name: 'To Do', statusCategory: { key: 'new' } } } });
  const blockLink = (direction: 'in' | 'out', n: number, summary: string) => ({
    type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
    ...(direction === 'in' ? { inwardIssue: linked(n, summary) } : { outwardIssue: linked(n, summary) }),
  });
  const issues = [
    jiraIssue(1, 'Alpha', false, [blockLink('out', 2, 'Beta')]),
    jiraIssue(2, 'Beta', false, [blockLink('in', 1, 'Alpha')]),
    jiraIssue(3, 'Gamma', true),
  ];
  const closed: number[] = [];
  const reopened: number[] = [];
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  const http = async (url: string, init?: RequestInit): Promise<Response> => {
    const { pathname } = new URL(url);
    const method = init?.method ?? 'GET';
    const key = /\/issue\/PROJ-(\d+)/.exec(pathname)?.[1];
    const n = Number(key);
    if (pathname.endsWith('/search') || pathname.endsWith('/search/jql')) return json({ startAt: 0, total: issues.length, issues });
    if (pathname.endsWith('/myself')) return json({ accountId: 'me', displayName: 'Me' });
    if (pathname.endsWith('/comment')) return json(method === 'POST' ? {} : { comments: [] });
    if (pathname.endsWith('/assignee')) return new Response(null, { status: 204 });
    if (pathname.endsWith('/transitions')) {
      if (method === 'POST') {
        (n === 3 ? reopened : closed).push(n);
        return new Response(null, { status: 204 });
      }
      return json({
        transitions: [
          { id: '11', name: 'Done', to: { name: 'Done', statusCategory: { key: 'done' } } },
          { id: '21', name: 'Reopen', to: { name: 'To Do', statusCategory: { key: 'new' } } },
        ],
      });
    }
    if (key) return json(issues.find((i) => i.key === `PROJ-${n}`));
    return new Response('not found', { status: 404 });
  };
  const settings = kind.settings.parse({
    baseUrl: 'https://example.atlassian.net',
    authMode: 'cloud',
    email: 'me@example.test',
    projectKey: 'PROJ',
    secretName: 'JIRA_TOKEN',
  });
  const adapter = kind.create({ settings, secrets: { JIRA_TOKEN: 'tok' }, repoRoot: '/repo', http });
  return { adapter, closed: () => closed, reopened: () => reopened, ref: (n) => `PROJ-${n}` };
}

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function localMarkdownHarness(kind: TrackerKind<any>): Harness {
  const root = mkdtempSync(join(tmpdir(), 'harmonic-conformance-'));
  roots.push(root);
  const issues = join(root, '.scratch', 'issues');
  mkdirSync(issues, { recursive: true });
  const files = {
    '01-alpha.md': '# 01 — Alpha\n\n**Status:** open\n',
    '02-beta.md': '# 02 — Beta\n\n**Status:** open\n**Blocked by:** 01\n',
    '03-gamma.md': '# 03 — Gamma\n\n**Status:** closed\n',
  };
  for (const [name, body] of Object.entries(files)) writeFileSync(join(issues, name), body);
  const status = (name: string) => /\*\*Status:\*\*\s*(\w+)/.exec(readFileSync(join(issues, name), 'utf8'))![1];
  const adapter = kind.create({ settings: kind.settings.parse({}), secrets: {}, repoRoot: root, http: noHttp });
  const initiallyClosed = new Set([3]);
  const named = (n: number) => Object.keys(files)[n - 1]!;
  return {
    adapter,
    closed: () => [1, 2, 3].filter((n) => status(named(n)) === 'closed' && !initiallyClosed.has(n)),
    reopened: () => [1, 2, 3].filter((n) => status(named(n)) === 'open' && initiallyClosed.has(n)),
  };
}

const HARNESSES: Record<string, (kind: TrackerKind<any>) => Harness> = {
  github: githubHarness,
  gitlab: gitlabHarness,
  forgejo: forgejoHarness,
  jira: jiraHarness,
  'local-markdown': localMarkdownHarness,
};

describe('tracker kind registry', () => {
  it('has a conformance harness for every registered kind', () => {
    expect(TRACKER_KINDS.map((k) => k.id).sort()).toEqual(Object.keys(HARNESSES).sort());
  });

  it('registers each id once', () => {
    const ids = TRACKER_KINDS.map((k) => k.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe.each(TRACKER_KINDS.map((k) => [k.id, k] as const))('tracker conformance: %s', (id, kind) => {
  const harness = () => HARNESSES[id]!(kind);
  const refFor = (h: Harness, n: number) => h.ref?.(n) ?? String(n);

  it('scan returns every ticket with portable number, title and state', async () => {
    const h = harness();
    const tickets = await h.adapter.scan();
    expect(tickets.map((t) => [t.ref, t.title, t.state]).sort((a, b) => a[0]!.localeCompare(b[0]!))).toEqual([
      [refFor(h, 1), 'Alpha', 'open'],
      [refFor(h, 2), 'Beta', 'open'],
      [refFor(h, 3), 'Gamma', 'closed'],
    ]);
  });

  it('reads blocked-by relationships directionally', async () => {
    const h = harness();
    const r = (n: number) => trackerRef(refFor(h, n));
    const byNumber = new Map((await h.adapter.scan()).map((t) => [t.ref, t]));
    expect(byNumber.get(r(2))!.blockedBy.map((x) => x.ref)).toEqual([r(1)]);
    expect(byNumber.get(r(1))!.blockedBy).toEqual([]);
    expect(byNumber.get(r(1))!.blocking.map((x) => x.ref)).toEqual([r(2)]);
  });

  it('readTicket returns the same identity as scan', async () => {
    const h = harness();
    const ticket = await h.adapter.readTicket({ ref: trackerRef(refFor(h, 2)), title: 'Beta', state: 'open' });
    expect([ticket.ref, ticket.title, ticket.blockedBy.map((r) => r.ref)]).toEqual([refFor(h, 2), 'Beta', [refFor(h, 1)]]);
  });

  it('declares close and reopen exactly when the adapter implements them', () => {
    const { adapter } = harness();
    expect(typeof adapter.close === 'function').toBe(kind.capabilities.close);
    expect(typeof adapter.reopen === 'function').toBe(kind.capabilities.reopen);
  });

  it('close and reopen reach the backend', async () => {
    const h = harness();
    if (kind.capabilities.close) {
      await h.adapter.close!({ ref: trackerRef(refFor(h, 1)), title: 'Alpha', state: 'open' }, 'done');
      expect(h.closed()).toEqual([1]);
    }
    if (kind.capabilities.reopen) {
      await h.adapter.reopen!({ ref: trackerRef(refFor(h, 3)), title: 'Gamma', state: 'closed' }, 'again');
      expect(h.reopened()).toEqual([3]);
    }
  });

  it('claim and release never throw', async () => {
    const h = harness();
    const { adapter } = h;
    const ref = { ref: trackerRef(refFor(h, 1)), title: 'Alpha', state: 'open' as const };
    await expect(adapter.claim(ref)).resolves.toBeUndefined();
    await expect(adapter.release(ref)).resolves.toBeUndefined();
  });
});
