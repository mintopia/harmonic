import { describe, it, expect } from 'vitest';
import { githubRepository } from '../src/repository/github.js';

describe('GitHub Code Repository', () => {
  it('openPR creates a PR from the branch onto the base', async () => {
    const calls: string[][] = [];
    await githubRepository('/repo', async (args) => (calls.push(args), '')).openPR({
      branch: 'b',
      baseBranch: 'main',
      title: 'T',
      body: 'B',
    });
    expect(calls).toEqual([['pr', 'create', '--head', 'b', '--base', 'main', '--title', 'T', '--body', 'B']]);
  });

  it('verify reports ok, or the failure reason', async () => {
    expect(await githubRepository('/repo', async () => '{}').verify()).toEqual({ ok: true });
    const failing = githubRepository('/repo', async () => {
      throw new Error('gh: not logged in');
    });
    expect(await failing.verify()).toEqual({ ok: false, reason: 'gh: not logged in' });
  });
});
