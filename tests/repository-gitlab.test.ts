import { describe, it, expect } from 'vitest';
import { gitlabRepository } from '../src/repository/gitlab.js';

describe('GitLab Code Repository', () => {
  it('openPR creates an MR from the branch onto the base', async () => {
    const calls: Array<{ args: string[]; cwd: string }> = [];
    const repo = gitlabRepository('/repo', async (args, cwd) => (calls.push({ args, cwd }), ''));
    expect(repo.kind).toBe('gitlab');
    await repo.openPR({ branch: 'b', baseBranch: 'main', title: 'T', body: 'B' });
    expect(calls).toEqual([
      { args: ['mr', 'create', '--source-branch', 'b', '--target-branch', 'main', '--title', 'T', '--description', 'B', '--yes'], cwd: '/repo' },
    ]);
  });

  it('verify reports ok, or the failure reason', async () => {
    expect(await gitlabRepository('/repo', async () => '').verify()).toEqual({ ok: true });
    const failing = gitlabRepository('/repo', async () => {
      throw new Error('glab: not logged in');
    });
    expect(await failing.verify()).toEqual({ ok: false, reason: 'glab: not logged in' });
  });
});
