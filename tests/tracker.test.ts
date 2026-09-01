import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { logger } from '../src/logger.js';
import { resolveTracker, resolveTrackerAdapter } from '../src/tracker/adapter.js';
import { githubAdapter, type GhRunner } from '../src/tracker/github.js';
import { gitlabAdapter, type GlabRunner } from '../src/tracker/gitlab.js';
import { localMarkdownAdapter } from '../src/tracker/local-markdown.js';

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

function fakeGh() {
  const calls: string[][] = [];
  const run: GhRunner = async (args) => {
    calls.push(args);
    if (args[0] === 'issue' && args[1] === 'list') return JSON.stringify([issue29]);
    if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify(issue29);
    return '';
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

  it('scan asks gh for well past the old 1000-issue cap', async () => {
    const { run, calls } = fakeGh();
    await githubAdapter('/repo', run).scan();
    const call = calls.find((c) => c[0] === 'issue' && c[1] === 'list')!;
    const limit = Number(call[call.indexOf('--limit') + 1]);
    expect(limit).toBeGreaterThan(1000);
  });

  it('warns loudly (never truncates silently) when the safety valve is hit', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    let limitUsed = 0;
    const run: GhRunner = async (args) => {
      if (args[0] === 'issue' && args[1] === 'list') {
        limitUsed = Number(args[args.indexOf('--limit') + 1]);
        return JSON.stringify(Array.from({ length: limitUsed }, (_, i) => ({ ...issue29, number: i + 1 })));
      }
      return '';
    };
    const tickets = await githubAdapter('/repo', run).scan();
    expect(tickets).toHaveLength(limitUsed);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(String(limitUsed)));
    warnSpy.mockRestore();
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

  it('resolves local-markdown case- and separator-insensitively ("Local Markdown")', async () => {
    const root = mkRepo('# Issue tracker: Local Markdown\n\nblah\n');
    try {
      expect((await resolveTrackerAdapter(root)).name).toBe('local-markdown');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves GitLab from the repo declaration (auth via glab, no token)', async () => {
    const root = mkRepo('# Issue tracker: GitLab\n\nProject: mintopia/harmonic\n');
    try {
      expect((await resolveTrackerAdapter(root)).name).toBe('gitlab');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('infers the GitLab project from the git remote when the doc omits it', async () => {
    const root = mkRepo('# Issue tracker: GitLab\n\nIssues live in cloud-agent/base.\n');
    execFileSync('git', ['-C', root, 'init', '-q']);
    execFileSync('git', ['-C', root, 'remote', 'add', 'origin', 'git@gitlab.com:cloud-agent/base.git']);
    try {
      expect((await resolveTrackerAdapter(root)).name).toBe('gitlab');
    } finally {
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

describe('resolveTracker (Resolved Tracker surface, issue #83)', () => {
  const mkRepo = (declaration: string) => {
    const root = mkdtempSync(join(tmpdir(), 'harmonic-resolved-'));
    mkdirSync(join(root, 'docs/agents'), { recursive: true });
    writeFileSync(join(root, 'docs/agents/issue-tracker.md'), declaration);
    return root;
  };

  it('resolves to the adapter display label on success', async () => {
    const root = mkRepo('# Issue tracker: GitHub\n');
    try {
      expect(await resolveTracker(root)).toEqual({ ok: true, name: 'github', label: 'GitHub' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('labels local-markdown as "Local Markdown"', async () => {
    const root = mkRepo('# Issue tracker: Local Markdown\n');
    try {
      expect(await resolveTracker(root)).toMatchObject({ ok: true, name: 'local-markdown', label: 'Local Markdown' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports "no-declaration" when the repo has no issue-tracker.md', async () => {
    expect(await resolveTracker('/no/such/repo')).toMatchObject({ ok: false, code: 'no-declaration' });
  });

  it('reports "unsupported" for a declared name no adapter serves', async () => {
    const root = mkRepo('# Issue tracker: Jira\n');
    try {
      const res = await resolveTracker(root);
      expect(res).toMatchObject({ ok: false, code: 'unsupported' });
      if (!res.ok) expect(res.reason).toMatch(/Jira/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports "misconfigured" for a GitLab declaration with no project and no remote', async () => {
    const root = mkRepo('# Issue tracker: GitLab\n\nIssues live somewhere.\n');
    try {
      expect(await resolveTracker(root)).toMatchObject({ ok: false, code: 'misconfigured' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('local-markdown tracker adapter (mattpocock format)', () => {
  const fixture: Record<string, string> = {
    '01-adapter-interface.md': [
      '# 01 — Tracker Adapter interface',
      '',
      '**What to build:** the normalised Ticket shape and the read path.',
      '',
      '**Blocked by:** None — can start immediately.',
      '',
      '**Status:** ready-for-agent',
      '',
      '- [ ] scan returns tickets',
      '- [ ] readTicket by number',
    ].join('\n'),
    '02-local-markdown.md': [
      '# 02 — local-markdown tracker adapter',
      '',
      '**What to build:** read mattpocock tickets from disk.',
      '',
      '**Blocked by:** 01',
      '',
      '**Status:** ready-for-agent',
      '',
      '- [x] parse heading',
      '- [X] parse status',
    ].join('\n'),
    'notes.md': 'not a ticket (no numeric prefix)',
  };

  const specBody = ['# Spec: local-markdown tracker', '', 'The problem and the solution.'].join('\n');

  const mkTree = (feature = 'harmonic-v1', withSpec = true) => {
    const root = mkdtempSync(join(tmpdir(), 'harmonic-local-md-'));
    const issues = join(root, feature, 'issues');
    mkdirSync(issues, { recursive: true });
    for (const [name, body] of Object.entries(fixture)) writeFileSync(join(issues, name), body);
    if (withSpec) writeFileSync(join(root, feature, 'spec.md'), specBody);
    return root;
  };

  it('scan mints ids from the filename, parses the prose fields, skips non-tickets', async () => {
    const root = mkTree();
    try {
      const tickets = (await localMarkdownAdapter(root).scan()).sort((a, b) => a.number - b.number);
      expect(tickets.map((t) => t.number)).toEqual([0, 1, 2]);
      const t1 = tickets.find((t) => t.number === 1)!;
      expect(t1).toMatchObject({
        title: 'Tracker Adapter interface',
        state: 'open',
        labels: ['ready-for-agent'],
        assignees: [],
        parent: 0,
        isMap: false,
        comments: [],
      });
      expect(t1.body).toContain('**What to build:**');
      expect(t1.body).not.toMatch(/^# 01/);
      expect(t1.url).toMatch(/^file:.*01-adapter-interface\.md$/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('surfaces spec.md as the wayfinder Map (id 0) that every issue parents to', async () => {
    const root = mkTree();
    try {
      const tickets = await localMarkdownAdapter(root).scan();
      const map = tickets.find((t) => t.number === 0)!;
      expect(map).toMatchObject({ isMap: true, title: 'local-markdown tracker', parent: null });
      expect(map.body).toBe('The problem and the solution.');
      expect(map.url).toMatch(/spec\.md$/);
      expect(tickets.filter((t) => !t.isMap).every((t) => t.parent === 0)).toBe(true);
      expect(map.blockedBy).toEqual([]);
      expect(map.blocking).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('no spec.md → no Map, and issues have a null parent', async () => {
    const root = mkTree('harmonic-v1', false);
    try {
      const tickets = await localMarkdownAdapter(root).scan();
      expect(tickets.some((t) => t.isMap)).toBe(false);
      expect(tickets.map((t) => t.number).sort((a, b) => a - b)).toEqual([1, 2]);
      expect(tickets.every((t) => t.parent === null)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('synthesises directional edges; a ticket closes when all its checkboxes are ticked', async () => {
    const root = mkTree();
    try {
      const tickets = await localMarkdownAdapter(root).scan();
      const t1 = tickets.find((t) => t.number === 1)!;
      const t2 = tickets.find((t) => t.number === 2)!;
      expect(t2.blockedBy).toEqual([{ number: 1, title: 'Tracker Adapter interface', state: 'open' }]);
      expect(t1.blocking).toEqual([{ number: 2, title: 'local-markdown tracker adapter', state: 'closed' }]);
      expect(t1.blockedBy).toEqual([]);
      expect(t2.state).toBe('closed');
      expect(t2.closedAt).not.toBeNull();
      expect(t2.labels).toEqual(['ready-for-agent']);
      expect(t1.state).toBe('open');
      expect(t1.closedAt).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('completeness comes from the checkboxes; Status is the fallback when there are none', async () => {
    const root = mkdtempSync(join(tmpdir(), 'harmonic-local-md-'));
    const issues = join(root, 'f', 'issues');
    mkdirSync(issues, { recursive: true });
    const t = (n: number, status: string, ...lines: string[]) =>
      writeFileSync(join(issues, `0${n}-t.md`), [`# 0${n} — T${n}`, '', `**Status:** ${status}`, '', ...lines].join('\n'));
    t(1, 'ready-for-agent', '- [x] a', '- [ ] b');
    t(2, 'ready-for-agent', '- [x] a', '- [X] b');
    t(3, 'done');
    t(4, 'ready-for-agent');
    t(5, 'done', '- [ ] a');
    try {
      const byNum = new Map((await localMarkdownAdapter(root).scan()).map((x) => [x.number, x.state]));
      expect([byNum.get(1), byNum.get(2), byNum.get(3), byNum.get(4), byNum.get(5)]).toEqual([
        'open',
        'closed',
        'closed',
        'open',
        'closed',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('writes close and reopen lifecycle transitions to Status while claim/release remain local-only', async () => {
    const root = mkTree();
    try {
      const md = localMarkdownAdapter(root);
      const file = join(root, 'harmonic-v1', 'issues', '01-adapter-interface.md');
      const before = readFileSync(file, 'utf8');
      const ticket = await md.readTicket({ number: 1, title: '', state: 'open' });
      await md.claim(ticket);
      await md.release(ticket);
      await md.close(ticket, 'accepted');
      expect(readFileSync(file, 'utf8')).not.toBe(before);
      expect(readFileSync(file, 'utf8')).toContain('**Status:** closed');
      expect((await md.readTicket({ number: 1, title: '', state: 'open' })).state).toBe('closed');

      await md.reopen(ticket, 'premature');
      expect(readFileSync(file, 'utf8')).toContain('**Status:** open');
      const after = await md.readTicket({ number: 1, title: '', state: 'closed' });
      expect(after.assignees).toEqual([]);
      expect(after.state).toBe('open');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('explicit Status is authoritative over ticked boxes; reopen round-trips to open (#237)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'harmonic-local-md-'));
    const issues = join(root, 'f', 'issues');
    mkdirSync(issues, { recursive: true });
    const t = (n: number, status: string, ...lines: string[]) =>
      writeFileSync(join(issues, `0${n}-t.md`), [`# 0${n} — T${n}`, '', `**Status:** ${status}`, '', ...lines].join('\n'));
    t(1, 'open', '- [x] a', '- [X] b');
    t(2, 'closed', '- [x] a', '- [X] b');
    writeFileSync(join(issues, '03-t.md'), ['# 03 — T3', '', '- [x] a', '- [X] b'].join('\n'));
    try {
      const byNum = new Map((await localMarkdownAdapter(root).scan()).map((x) => [x.number, x.state]));
      expect([byNum.get(1), byNum.get(2), byNum.get(3)]).toEqual(['open', 'closed', 'closed']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reopen makes an all-ticked ticket parse open again — no churn (#237)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'harmonic-local-md-'));
    const issues = join(root, 'f', 'issues');
    mkdirSync(issues, { recursive: true });
    const file = join(issues, '01-t.md');
    writeFileSync(file, ['# 01 — T1', '', '**Status:** closed', '', '- [x] a', '- [X] b'].join('\n'));
    try {
      const md = localMarkdownAdapter(root);
      expect((await md.readTicket({ number: 1, title: '', state: 'open' })).state).toBe('closed');
      await md.reopen({ number: 1, title: '', state: 'closed' }, 'premature');
      expect(readFileSync(file, 'utf8')).toContain('- [x] a');
      expect(readFileSync(file, 'utf8')).toContain('**Status:** open');
      expect((await md.readTicket({ number: 1, title: '', state: 'closed' })).state).toBe('open');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  const addFeatureB = (root: string) => {
    const issuesB = join(root, 'feature-b', 'issues');
    mkdirSync(issuesB, { recursive: true });
    writeFileSync(join(issuesB, '01-foo.md'), '# 01 — Foo\n\n**Blocked by:** None\n\n**Status:** ready-for-agent\n');
    writeFileSync(join(issuesB, '02-bar.md'), '# 02 — Bar\n\n**Blocked by:** 01\n\n**Status:** ready-for-agent\n');
    writeFileSync(join(root, 'feature-b', 'spec.md'), '# Spec: feature B\n\nBody.');
  };

  it('aggregates coexisting feature specs, namespacing ids per feature', async () => {
    const root = mkTree('feature-a');
    try {
      addFeatureB(root);

      const tickets = (await localMarkdownAdapter(root).scan()).sort((a, b) => a.number - b.number);
      expect(tickets.map((t) => t.number)).toEqual([0, 1, 2, 10000, 10001, 10002]);
      expect(tickets.filter((t) => t.isMap).map((t) => t.number)).toEqual([0, 10000]);
      expect(tickets.find((t) => t.number === 1)!.parent).toBe(0);
      expect(tickets.find((t) => t.number === 10001)!.parent).toBe(10000);
      expect(tickets.find((t) => t.number === 10002)!.blockedBy).toEqual([
        { number: 10001, title: 'Foo', state: 'open' },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps a feature\'s ids stable across an earlier-sorting insertion via featureIndex', async () => {
    const root = mkTree('m-feature');
    const store = new Map<string, number>();
    const featureIndex = async (slug: string) => store.get(slug) ?? (store.set(slug, store.size), store.size - 1);
    try {
      const before = new Map(
        (await localMarkdownAdapter(root, { featureIndex }).scan()).map((t) => [t.url, t.number]),
      );

      const issuesA = join(root, 'a-feature', 'issues');
      mkdirSync(issuesA, { recursive: true });
      writeFileSync(join(issuesA, '01-new.md'), '# 01 — New\n\n**Status:** ready-for-agent\n');

      const after = await localMarkdownAdapter(root, { featureIndex }).scan();
      for (const t of after) if (before.has(t.url)) expect(t.number).toBe(before.get(t.url));
      const priorRefs = new Set(before.values());
      const aIds = after.filter((t) => t.url.includes('/a-feature/')).map((t) => t.number);
      expect(aIds.length).toBe(1);
      for (const id of aIds) expect(priorRefs.has(id)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('gitlab tracker adapter', () => {
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

  function fakeGlab() {
    const writes: { method: string; path: string }[] = [];
    const run: GlabRunner = async (args) => {
      const xi = args.indexOf('-X');
      const method = xi === -1 ? 'GET' : args[xi + 1]!;
      const path = '/' + args[args.length - 1]!.replace(/^projects\/[^/]+\//, '');
      if (method !== 'GET') writes.push({ method, path });
      if (args[args.length - 1] === 'user') return JSON.stringify({ id: 7, username: 'harmonic-bot' });
      if (/^\/issues\?.*per_page/.test(path)) {
        const page = Number(new URLSearchParams(path.split('?')[1]).get('page') ?? '1');
        return JSON.stringify(page === 1 ? Object.values(issues) : []);
      }
      const notes = path.match(/\/issues\/(\d+)\/notes/);
      if (notes) {
        if (method === 'POST') return JSON.stringify({});
        return JSON.stringify([
          { body: 'first', system: false, author: { username: 'mintopia' }, created_at: '2026-08-08T12:00:00Z' },
          { body: 'assigned', system: true, author: { username: 'mintopia' }, created_at: '2026-08-08T12:01:00Z' },
        ]);
      }
      const single = path.match(/\/issues\/(\d+)(\?|$)/);
      if (single) return JSON.stringify(issues[Number(single[1])]);
      return JSON.stringify({});
    };
    return { run, writes };
  }

  const cfg = { project: 'mintopia/harmonic', repoRoot: '/repo' };

  it('scan normalises iid/opened-state and synthesises directional edges', async () => {
    const { run } = fakeGlab();
    const tickets = await gitlabAdapter(cfg, run).scan();
    const t36 = tickets.find((t) => t.number === 36)!;
    const t22 = tickets.find((t) => t.number === 22)!;
    expect(t36).toMatchObject({
      number: 36,
      state: 'open',
      parent: 19,
      isMap: false,
      labels: ['ready-for-agent'],
      url: 'https://gitlab.com/mintopia/harmonic/-/issues/36',
    });
    expect(t36.blockedBy).toEqual([{ number: 22, title: 'The Tracker Adapter interface', state: 'closed' }]);
    expect(t22.blocking).toEqual([{ number: 36, title: 'GitLab tracker adapter', state: 'open' }]);
    expect(t22).toMatchObject({ state: 'closed', isMap: true });
    expect(t22.assignees).toEqual(['mintopia']);
  });

  it('readTicket adds non-system comments to the synthesised ticket', async () => {
    const { run } = fakeGlab();
    const t = await gitlabAdapter(cfg, run).readTicket({ number: 36, title: '', state: 'open' });
    expect(t.number).toBe(36);
    expect(t.comments).toEqual([{ author: 'mintopia', body: 'first', createdAt: '2026-08-08T12:00:00Z' }]);
  });

  it('claim unions our id onto the current assignees; close comments then closes', async () => {
    const { run, writes } = fakeGlab();
    const gl = gitlabAdapter(cfg, run);
    await gl.claim({ number: 36 } as any);
    await gl.close({ number: 36 } as any, 'done');
    const put = writes.find((w) => w.method === 'PUT' && w.path.includes('assignee_ids'))!;
    expect(put.path).toContain('7');
    expect(writes.some((w) => w.method === 'POST' && /\/issues\/36\/notes\?body=done/.test(w.path))).toBe(true);
    expect(writes.some((w) => w.method === 'PUT' && /\/issues\/36\?state_event=close/.test(w.path))).toBe(true);
  });

  it('scan follows pages past the old 1000-issue (10-page) cap', async () => {
    const totalIssues = 1250;
    const run: GlabRunner = async (args) => {
      const path = args[args.length - 1]!;
      const page = Number(new URLSearchParams(path.split('?')[1]).get('page') ?? '1');
      const start = (page - 1) * 100;
      const batch = Array.from({ length: Math.max(0, Math.min(100, totalIssues - start)) }, (_, i) => ({
        ...issues[36],
        iid: start + i + 1,
      }));
      return JSON.stringify(batch);
    };
    const tickets = await gitlabAdapter(cfg, run).scan();
    expect(tickets).toHaveLength(totalIssues);
  });

  it('warns loudly (never truncates silently) when the page safety valve is hit', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const run: GlabRunner = async (args) => {
      const path = args[args.length - 1]!;
      const page = Number(new URLSearchParams(path.split('?')[1]).get('page') ?? '1');
      const start = (page - 1) * 100;
      return JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ ...issues[36], iid: start + i + 1 })));
    };
    const tickets = await gitlabAdapter(cfg, run).scan();
    expect(tickets.length).toBeGreaterThan(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('safety valve'));
    warnSpy.mockRestore();
  });
});
