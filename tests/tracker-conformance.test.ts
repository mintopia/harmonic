import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TRACKER_KINDS } from '../src/tracker/kinds.js';
import type { CliRunner, TrackerKind } from '../src/tracker/kind.js';
import type { TrackerAdapter } from '../src/tracker/adapter.js';

/** Three tickets every kind is seeded with: #1 open, #2 open and blocked by #1, #3 closed. */
interface Harness {
  adapter: TrackerAdapter;
  /** Ticket numbers the adapter has closed / reopened since creation. */
  closed(): number[];
  reopened(): number[];
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

  it('scan returns every ticket with portable number, title and state', async () => {
    const tickets = await harness().adapter.scan();
    expect(tickets.map((t) => [t.number, t.title, t.state]).sort((a, b) => Number(a[0]) - Number(b[0]))).toEqual([
      [1, 'Alpha', 'open'],
      [2, 'Beta', 'open'],
      [3, 'Gamma', 'closed'],
    ]);
  });

  it('reads blocked-by relationships directionally', async () => {
    const byNumber = new Map((await harness().adapter.scan()).map((t) => [t.number, t]));
    expect(byNumber.get(2)!.blockedBy.map((r) => r.number)).toEqual([1]);
    expect(byNumber.get(1)!.blockedBy).toEqual([]);
    expect(byNumber.get(1)!.blocking.map((r) => r.number)).toEqual([2]);
  });

  it('readTicket returns the same identity as scan', async () => {
    const { adapter } = harness();
    const ticket = await adapter.readTicket({ number: 2, title: 'Beta', state: 'open' });
    expect([ticket.number, ticket.title, ticket.blockedBy.map((r) => r.number)]).toEqual([2, 'Beta', [1]]);
  });

  it('declares close and reopen exactly when the adapter implements them', () => {
    const { adapter } = harness();
    expect(typeof adapter.close === 'function').toBe(kind.capabilities.close);
    expect(typeof adapter.reopen === 'function').toBe(kind.capabilities.reopen);
  });

  it('close and reopen reach the backend', async () => {
    const h = harness();
    if (kind.capabilities.close) {
      await h.adapter.close!({ number: 1, title: 'Alpha', state: 'open' }, 'done');
      expect(h.closed()).toEqual([1]);
    }
    if (kind.capabilities.reopen) {
      await h.adapter.reopen!({ number: 3, title: 'Gamma', state: 'closed' }, 'again');
      expect(h.reopened()).toEqual([3]);
    }
  });

  it('claim and release never throw', async () => {
    const { adapter } = harness();
    const ref = { number: 1, title: 'Alpha', state: 'open' as const };
    await expect(adapter.claim(ref)).resolves.toBeUndefined();
    await expect(adapter.release(ref)).resolves.toBeUndefined();
  });
});
