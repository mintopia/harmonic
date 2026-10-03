import { describe, it, expect } from 'vitest';
import { gitlabRepository } from '../src/repository/gitlab.js';

describe('GitLab Code Repository', () => {
  it('openPR creates an MR from the branch onto the base', async () => {
    const calls: Array<{ args: string[]; cwd: string }> = [];
    const output = 'Creating merge request for b into main in g/r\n\n!7 T\nhttps://gitlab.example/g/r/-/merge_requests/7\n';
    const repo = gitlabRepository('/repo', async (args, cwd) => (calls.push({ args, cwd }), output));
    expect(repo.kind).toBe('gitlab');
    expect(await repo.openPR({ branch: 'b', baseBranch: 'main', title: 'T', body: 'B' })).toBe('https://gitlab.example/g/r/-/merge_requests/7');
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
