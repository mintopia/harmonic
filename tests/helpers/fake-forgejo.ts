import type { TrackerHttp } from '../../src/tracker/kind.js';

export interface FakeIssue {
  number: number;
  title: string;
  state: 'open' | 'closed';
  body: string;
  labels: string[];
  assignees: string[];
  milestone: number | null;
}

export interface FakeContainer {
  id: number;
  title: string;
  state: 'open' | 'closed';
  issues: number[];
}

export interface FakeForgejoOptions {
  issues: FakeIssue[];
  /** issue number -> numbers of the issues that block it */
  dependencies?: Record<number, number[]>;
  milestones?: FakeContainer[];
  me?: string;
  /** false answers dependency requests with 404, as a repo with the feature off does */
  dependenciesEnabled?: boolean;
}

export interface FakeForgejo {
  http: TrackerHttp;
  issues: FakeIssue[];
  milestones: FakeContainer[];
  comments: Array<{ issue: number; body: string }>;
  pulls: unknown[];
  requests: Array<{ method: string; path: string; auth: string | null }>;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export const issue = (number: number, title: string, over: Partial<FakeIssue> = {}): FakeIssue => ({
  number,
  title,
  state: 'open',
  body: '',
  labels: [],
  assignees: [],
  milestone: null,
  ...over,
});

/** An in-memory Forgejo REST API for `owner/name`, served through an injected fetch. */
export function fakeForgejo(options: FakeForgejoOptions): FakeForgejo {
  const fake: FakeForgejo = {
    http: undefined as never,
    issues: options.issues,
    milestones: options.milestones ?? [],
    comments: [],
    pulls: [],
    requests: [],
  };
  const me = options.me ?? 'harmonic-bot';
  const rawIssue = (i: FakeIssue) => ({
    number: i.number,
    title: i.title,
    state: i.state,
    body: i.body,
    created_at: '2026-01-01T00:00:00Z',
    closed_at: i.state === 'closed' ? '2026-01-02T00:00:00Z' : null,
    labels: i.labels.map((name) => ({ name })),
    assignees: i.assignees.map((login) => ({ login })),
    html_url: `https://forge.test/owner/name/issues/${i.number}`,
    milestone: i.milestone === null ? null : { id: i.milestone },
  });
  const rawContainer = (c: FakeContainer) => ({
    id: c.id,
    title: c.title,
    description: '',
    state: c.state,
    created_at: '2026-01-01T00:00:00Z',
    closed_at: null,
    html_url: `https://forge.test/owner/name/${c.id}`,
  });
  const page = <T>(items: T[], params: URLSearchParams): T[] => {
    const limit = Number(params.get('limit') ?? 50);
    const n = Number(params.get('page') ?? 1);
    return items.slice((n - 1) * limit, n * limit);
  };

  fake.http = async (url, init) => {
    const method = init?.method ?? 'GET';
    const u = new URL(url);
    const path = u.pathname.replace(/^\/api\/v1/, '');
    const auth = new Headers(init?.headers).get('authorization');
    fake.requests.push({ method, path, auth });
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    let m: RegExpExecArray | null;

    if (path === '/user') return auth === 'token good' ? json({ login: me }) : json({ message: 'unauthorized' }, 401);
    if (method === 'GET' && path === '/repos/owner/name/issues') {
      const milestone = u.searchParams.get('milestones');
      const wanted = fake.issues.filter((i) => milestone === null || i.milestone === Number(milestone));
      return json(page(wanted.map(rawIssue), u.searchParams));
    }
    if ((m = /^\/repos\/owner\/name\/issues\/(\d+)$/.exec(path))) {
      const found = fake.issues.find((i) => i.number === Number(m![1]));
      if (!found) return json({ message: 'not found' }, 404);
      if (method === 'PATCH') {
        if (body.state) found.state = body.state;
        if (body.assignees) found.assignees = body.assignees;
      }
      return json(rawIssue(found));
    }
    if ((m = /^\/repos\/owner\/name\/issues\/(\d+)\/comments$/.exec(path))) {
      if (method === 'POST') {
        fake.comments.push({ issue: Number(m[1]), body: body.body });
        return json({}, 201);
      }
      return json(
        page(
          fake.comments.filter((c) => c.issue === Number(m![1])).map((c) => ({ body: c.body, created_at: '2026-01-03T00:00:00Z', user: { login: me } })),
          u.searchParams,
        ),
      );
    }
    if ((m = /^\/repos\/owner\/name\/issues\/(\d+)\/dependencies$/.exec(path))) {
      if (options.dependenciesEnabled === false) return json({ message: 'dependencies disabled' }, 404);
      const blockers = (options.dependencies?.[Number(m[1])] ?? []).map((n) => rawIssue(fake.issues.find((i) => i.number === n)!));
      return json(page(blockers, u.searchParams));
    }
    if (method === 'GET' && path === '/repos/owner/name/milestones') {
      const state = u.searchParams.get('state');
      return json(page(fake.milestones.filter((c) => !state || c.state === state).map(rawContainer), u.searchParams));
    }
    if (method === 'PATCH' && (m = /^\/repos\/owner\/name\/milestones\/(\d+)$/.exec(path))) {
      const found = fake.milestones.find((c) => c.id === Number(m![1]))!;
      found.state = body.state;
      return json(rawContainer(found));
    }
    if (method === 'POST' && path === '/repos/owner/name/pulls') {
      fake.pulls.push(body);
      return json({ number: 1 }, 201);
    }
    return json({ message: `unhandled ${method} ${path}` }, 500);
  };
  return fake;
}
