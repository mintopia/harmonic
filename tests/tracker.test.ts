import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { resolveTrackerAdapter } from '../src/tracker/adapter.js';
import { githubAdapter, type GhRunner } from '../src/tracker/github.js';
import { gitlabAdapter, type Fetcher } from '../src/tracker/gitlab.js';
import { localMarkdownAdapter } from '../src/tracker/local-markdown.js';

// A real `gh issue view --json` payload, trimmed to the fields the adapter reads.
const issue29 = {
  number: 29,
  title: 'Tracker Adapter interface + GitHub adapter',
  state: 'OPEN',
  body: 'Blocked by: nothing native here',
  createdAt: '2026-08-06T10:00:00Z',
  closedAt: null,
  labels: [{ name: 'ready-for-agent' }, { name: 'wayfinder:map' }],
  assignees: [],
  comments: [{ author: { login: 'mintopia' }, body: 'first', createdAt: '2026-08-06T12:00:00Z' }],
  parent: { number: 19, title: 'Wayfinder', state: 'OPEN' },
  blockedBy: { nodes: [], totalCount: 0 },
  blocking: {
    nodes: [{ number: 30, title: 'Mirror tracker issues', state: 'OPEN' }],
    totalCount: 1,
  },
  url: 'https://github.com/mintopia/harmonic/issues/29',
};

/** Fake `gh`: returns canned JSON for reads, records writes. */
function fakeGh() {
  const calls: string[][] = [];
  const run: GhRunner = async (args) => {
    calls.push(args);
    if (args[0] === 'issue' && args[1] === 'list') return JSON.stringify([issue29]);
    if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify(issue29);
    return ''; // edit / close write nothing
  };
  return { run, calls };
}

describe('github tracker adapter', () => {
  it('scan normalises the native fields incl. url + directional edges', async () => {
    const { run } = fakeGh();
    const t = (await githubAdapter('/repo', run).scan())[0]!;
    expect(t).toMatchObject({
      number: 29,
      state: 'open',
      url: 'https://github.com/mintopia/harmonic/issues/29',
      parent: 19,
      isMap: true,
      labels: ['ready-for-agent', 'wayfinder:map'],
      assignees: [],
    });
    expect(t.blocking).toEqual([{ number: 30, title: 'Mirror tracker issues', state: 'open' }]);
    expect(t.blockedBy).toEqual([]);
    expect(t.comments).toEqual([{ author: 'mintopia', body: 'first', createdAt: '2026-08-06T12:00:00Z' }]);
  });

  it('readTicket reads one fresh issue by number', async () => {
    const { run, calls } = fakeGh();
    const t = await githubAdapter('/repo', run).readTicket({ number: 29, title: '', state: 'open' });
    expect(t.number).toBe(29);
    expect(calls).toContainEqual(['issue', 'view', '29', '--json', expect.any(String)]);
  });

  it('claim assigns the ambient user; close comments then closes', async () => {
    const { run, calls } = fakeGh();
    const gh = githubAdapter('/repo', run);
    const ticket = { number: 29 } as any;
    await gh.claim(ticket);
    await gh.close(ticket, 'done');
    expect(calls).toContainEqual(['issue', 'edit', '29', '--add-assignee', '@me']);
    expect(calls).toContainEqual(['issue', 'close', '29', '--comment', 'done']);
  });

  it('close without a comment just closes', async () => {
    const { run, calls } = fakeGh();
    await githubAdapter('/repo', run).close({ number: 29 } as any, '');
    expect(calls).toContainEqual(['issue', 'close', '29']);
  });
});

describe('resolveTrackerAdapter', () => {
  const mkRepo = (declaration: string) => {
    const root = mkdtempSync(join(tmpdir(), 'harmonic-tracker-'));
    mkdirSync(join(root, 'docs/agents'), { recursive: true });
    writeFileSync(join(root, 'docs/agents/issue-tracker.md'), declaration);
    return root;
  };

  it('resolves GitHub from the repo declaration', async () => {
    const root = mkRepo('# Issue tracker: GitHub\n\nblah');
    try {
      expect((await resolveTrackerAdapter(root)).name).toBe('github');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves local-markdown from the repo declaration', async () => {
    const root = mkRepo('# Issue tracker: local-markdown\n\nPath: tickets\n');
    try {
      expect((await resolveTrackerAdapter(root)).name).toBe('local-markdown');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves GitLab (with token) and rejects it without one', async () => {
    const root = mkRepo('# Issue tracker: GitLab\n\nProject: mintopia/harmonic\n');
    const prev = process.env.GITLAB_TOKEN;
    try {
      process.env.GITLAB_TOKEN = 'glpat-xxx';
      expect((await resolveTrackerAdapter(root)).name).toBe('gitlab');
      delete process.env.GITLAB_TOKEN;
      await expect(resolveTrackerAdapter(root)).rejects.toThrow(/GITLAB_TOKEN/);
    } finally {
      if (prev === undefined) delete process.env.GITLAB_TOKEN;
      else process.env.GITLAB_TOKEN = prev;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects an unknown tracker and a missing declaration', async () => {
    const root = mkRepo('# Issue tracker: Jira\n');
    try {
      await expect(resolveTrackerAdapter(root)).rejects.toThrow(/Jira/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    await expect(resolveTrackerAdapter('/no/such/repo')).rejects.toThrow(/No tracker declaration/);
  });
});

describe('local-markdown tracker adapter', () => {
  // Fixture: 37 blockedBy 29 (declared on 37); 29 blocking is only synthesised.
  // 29 is a Map, parent 19 (which doesn't exist → dangling, dropped).
  const fixture: Record<string, string> = {
    '0029-adapter-interface.md': [
      '---',
      'title: Tracker Adapter interface',
      'state: closed',
      'createdAt: 2026-08-06T10:00:00Z',
      'closedAt: 2026-08-07T09:00:00Z',
      'labels: [wayfinder:map]',
      'assignees: []',
      'parent: 19',
      'blockedBy: []',
      'blocking: []',
      '---',
      '',
      'The interface.',
      '',
      '<!-- comments -->',
      '',
      '### mintopia · 2026-08-07T09:00:00Z',
      'shipped',
    ].join('\n'),
    '0037-local-markdown.md': [
      '---',
      'title: local-markdown tracker adapter',
      'state: open',
      'createdAt: 2026-08-08T10:00:00Z',
      'labels: [ready-for-agent]',
      'assignees: []',
      'blockedBy: [29]',
      '---',
      '',
      'Body here.',
    ].join('\n'),
    'notes.md': 'not a ticket (no numeric prefix)',
  };

  const mkTree = () => {
    const dir = mkdtempSync(join(tmpdir(), 'harmonic-local-md-'));
    for (const [name, body] of Object.entries(fixture)) writeFileSync(join(dir, name), body);
    return dir;
  };

  it('scan mints ids from the filename, parses frontmatter, skips non-tickets', async () => {
    const dir = mkTree();
    try {
      const tickets = (await localMarkdownAdapter(dir).scan()).sort((a, b) => a.number - b.number);
      expect(tickets.map((t) => t.number)).toEqual([29, 37]);
      const t37 = tickets.find((t) => t.number === 37)!;
      expect(t37).toMatchObject({
        title: 'local-markdown tracker adapter',
        state: 'open',
        labels: ['ready-for-agent'],
        parent: null,
        isMap: false,
        body: 'Body here.',
      });
      expect(t37.url).toMatch(/^file:.*0037-local-markdown\.md$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('synthesises directional edges from convention and drops dangling parent', async () => {
    const dir = mkTree();
    try {
      const tickets = await localMarkdownAdapter(dir).scan();
      const t29 = tickets.find((t) => t.number === 29)!;
      const t37 = tickets.find((t) => t.number === 37)!;
      // 37 declares blockedBy 29; the reverse blocking edge is synthesised onto 29.
      expect(t37.blockedBy).toEqual([{ number: 29, title: 'Tracker Adapter interface', state: 'closed' }]);
      expect(t29.blocking).toEqual([{ number: 37, title: 'local-markdown tracker adapter', state: 'open' }]);
      expect(t29.isMap).toBe(true);
      expect(t29.parent).toBeNull(); // 19 doesn't exist in the tree
      expect(t29.comments).toEqual([{ author: 'mintopia', createdAt: '2026-08-07T09:00:00Z', body: 'shipped' }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('claim then close round-trip through the frontmatter', async () => {
    const dir = mkTree();
    try {
      const md = localMarkdownAdapter(dir, { identity: 'jess' });
      const ticket = await md.readTicket({ number: 37, title: '', state: 'open' });
      await md.claim(ticket);
      await md.close(ticket, 'accepted');

      const after = await md.readTicket({ number: 37, title: '', state: 'open' });
      expect(after.state).toBe('closed');
      expect(after.closedAt).not.toBeNull();
      expect(after.assignees).toEqual(['jess']);
      expect(after.comments).toEqual([{ author: 'jess', createdAt: expect.any(String), body: 'accepted' }]);
      // idempotent claim: no duplicate assignee.
      await md.claim(after);
      expect((await md.readTicket({ number: 37, title: '', state: 'open' })).assignees).toEqual(['jess']);
      // the edge survives the rewrite.
      const raw = readFileSync(join(dir, '0037-local-markdown.md'), 'utf8');
      expect(raw).toContain('blockedBy: [29]');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a write preserves pre-existing comments', async () => {
    const dir = mkTree();
    try {
      const md = localMarkdownAdapter(dir, { identity: 'jess' });
      const t29 = await md.readTicket({ number: 29, title: '', state: 'closed' });
      await md.claim(t29); // no new comment — must not drop the existing "shipped"
      const after = await md.readTicket({ number: 29, title: '', state: 'closed' });
      expect(after.comments).toEqual([{ author: 'mintopia', createdAt: '2026-08-07T09:00:00Z', body: 'shipped' }]);
      expect(after.assignees).toEqual(['jess']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('gitlab tracker adapter', () => {
  // 36 (opened) declares `Part of #19` + `Blocked by: #22`; 22 (closed) is the Map.
  const issues: Record<number, any> = {
    36: {
      iid: 36,
      title: 'GitLab tracker adapter',
      state: 'opened',
      description: 'Part of #19\n\nBlocked by: #22',
      created_at: '2026-08-08T10:00:00Z',
      closed_at: null,
      labels: ['ready-for-agent'],
      assignees: [],
      web_url: 'https://gitlab.com/mintopia/harmonic/-/issues/36',
    },
    22: {
      iid: 22,
      title: 'The Tracker Adapter interface',
      state: 'closed',
      description: 'The spine.',
      created_at: '2026-08-06T10:00:00Z',
      closed_at: '2026-08-07T09:00:00Z',
      labels: ['wayfinder:map'],
      assignees: [{ id: 5, username: 'mintopia' }],
      web_url: 'https://gitlab.com/mintopia/harmonic/-/issues/22',
    },
  };

  /** Fake GitLab REST v4: canned reads, recorded writes. */
  function fakeGitlab() {
    const writes: { method: string; path: string }[] = [];
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const fetcher: Fetcher = async (input, init) => {
      const url = String(input);
      const method = (init as any)?.method ?? 'GET';
      const path = url.replace('https://gitlab.com/api/v4', '');
      if (method !== 'GET') writes.push({ method, path });
      if (path === '/user') return json({ id: 7, username: 'harmonic-bot' });
      if (/\/issues\?.*per_page/.test(path)) {
        const page = Number(new URL(url).searchParams.get('page') ?? '1');
        return json(page === 1 ? Object.values(issues) : []);
      }
      const notes = path.match(/\/issues\/(\d+)\/notes/);
      if (notes) {
        if (method === 'POST') return json({});
        return json([
          { body: 'first', system: false, author: { username: 'mintopia' }, created_at: '2026-08-08T12:00:00Z' },
          { body: 'assigned', system: true, author: { username: 'mintopia' }, created_at: '2026-08-08T12:01:00Z' },
        ]);
      }
      const single = path.match(/\/issues\/(\d+)(\?|$)/);
      if (single) return json(issues[Number(single[1])]);
      return json({}, 404);
    };
    return { fetcher, writes };
  }

  const cfg = { project: 'mintopia/harmonic', host: 'https://gitlab.com', token: 'glpat-x' };

  it('scan normalises iid/opened-state and synthesises directional edges', async () => {
    const { fetcher } = fakeGitlab();
    const tickets = await gitlabAdapter(cfg, fetcher).scan();
    const t36 = tickets.find((t) => t.number === 36)!;
    const t22 = tickets.find((t) => t.number === 22)!;
    expect(t36).toMatchObject({
      number: 36,
      state: 'open', // 'opened' → open
      parent: 19, // body-line `Part of #19`
      isMap: false,
      labels: ['ready-for-agent'],
      url: 'https://gitlab.com/mintopia/harmonic/-/issues/36',
    });
    expect(t36.blockedBy).toEqual([{ number: 22, title: 'The Tracker Adapter interface', state: 'closed' }]);
    // reverse edge synthesised onto 22
    expect(t22.blocking).toEqual([{ number: 36, title: 'GitLab tracker adapter', state: 'open' }]);
    expect(t22).toMatchObject({ state: 'closed', isMap: true });
    expect(t22.assignees).toEqual(['mintopia']);
  });

  it('readTicket adds non-system comments to the synthesised ticket', async () => {
    const { fetcher } = fakeGitlab();
    const t = await gitlabAdapter(cfg, fetcher).readTicket({ number: 36, title: '', state: 'open' });
    expect(t.number).toBe(36);
    expect(t.comments).toEqual([{ author: 'mintopia', body: 'first', createdAt: '2026-08-08T12:00:00Z' }]);
  });

  it('claim unions our id onto the current assignees; close comments then closes', async () => {
    const { fetcher, writes } = fakeGitlab();
    const gl = gitlabAdapter(cfg, fetcher);
    await gl.claim({ number: 36 } as any);
    await gl.close({ number: 36 } as any, 'done');
    expect(await gl.whoami()).toBe('harmonic-bot');
    const put = writes.find((w) => w.method === 'PUT' && w.path.includes('assignee_ids'))!;
    expect(put.path).toContain('7'); // our user id assigned
    expect(writes.some((w) => w.method === 'POST' && /\/issues\/36\/notes\?body=done/.test(w.path))).toBe(true);
    expect(writes.some((w) => w.method === 'PUT' && /\/issues\/36\?state_event=close/.test(w.path))).toBe(true);
  });
});
