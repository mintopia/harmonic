import { describe, it, expect } from 'vitest';
import { githubRepository } from '../src/repository/github.js';

describe('GitHub Code Repository', () => {
  it('openPR yields null when gh prints no URL', async () => {
    const input = { branch: 'b', baseBranch: 'main', title: 'T', body: 'B' };
    expect(await githubRepository('/repo', async () => '').openPR(input)).toBeNull();
    expect(await githubRepository('/repo', async () => 'no url here\n').openPR(input)).toBeNull();
  });

  it('openPR creates a PR from the branch onto the base', async () => {
    const calls: string[][] = [];
    const url = await githubRepository('/repo', async (args) => (calls.push(args), 'https://github.com/o/r/pull/12\n')).openPR({
      branch: 'b',
      baseBranch: 'main',
      title: 'T',
      body: 'B',
    });
    expect(url).toBe('https://github.com/o/r/pull/12');
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
