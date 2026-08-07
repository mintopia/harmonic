import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveTrackerAdapter } from '../src/tracker/adapter.js';
import { githubAdapter, type GhRunner } from '../src/tracker/github.js';

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
