import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, expect } from 'vitest';
import { gitRepository } from '../src/repository/git.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function clone(): { bare: string; work: string } {
  const root = mkdtempSync(join(tmpdir(), 'repo-git-'));
  dirs.push(root);
  const bare = join(root, 'origin.git');
  const work = join(root, 'work');
  git(root, 'init', '--bare', '-b', 'main', bare);
  git(root, 'clone', bare, work);
  git(work, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-m', 'init');
  git(work, 'push', 'origin', 'HEAD:main');
  git(work, 'checkout', '-b', 'feature');
  git(work, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-m', 'work');
  return { bare, work };
}

describe('plain git Code Repository', () => {
  it('openPR pushes the branch to origin', async () => {
    const { bare, work } = clone();
    const repo = gitRepository(work);
    expect(repo.kind).toBe('git');
    expect(await repo.openPR({ branch: 'feature', baseBranch: 'main', title: 'T', body: 'B' })).toBeNull();
    expect(git(bare, 'branch', '--list', 'feature')).toContain('feature');
    expect(git(bare, 'rev-parse', 'feature').trim()).toBe(git(work, 'rev-parse', 'feature').trim());
  });

  it('openPR rejects a branch that looks like an option', async () => {
    const calls: string[][] = [];
    const repo = gitRepository('/repo', async (args) => (calls.push(args), ''));
    await expect(repo.openPR({ branch: '--force', baseBranch: 'main', title: 'T', body: 'B' })).rejects.toThrow(/Invalid branch/);
    expect(calls).toEqual([]);
  });

  it('verify is ok with a reachable origin and fails without one', async () => {
    const { work } = clone();
    expect(await gitRepository(work).verify()).toEqual({ ok: true });
    git(work, 'remote', 'remove', 'origin');
    const result = await gitRepository(work).verify();
    expect(result.ok).toBe(false);
  });
});
