import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { epicRefreshWorktreePath, sweepOrphanedEpicRefreshWorktrees } from '../src/execution/epic-refresh-sweep.js';
import { trackerRef } from '../src/tracker/adapter.js';

const tmpDirs: string[] = [];

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

function makeFixture(): { repo: string; worktreesDir: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'harmonic-refresh-sweep-')));
  tmpDirs.push(root);
  const repo = join(root, 'repo');
  const worktreesDir = join(root, 'worktrees');
  mkdirSync(repo);
  mkdirSync(worktreesDir);
  git(repo, 'init', '-b', 'develop');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(repo, 'shared.txt'), 'base\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', 'init');
  git(repo, 'branch', 'epic/5');
  git(repo, 'branch', 'epic/6');
  git(repo, 'checkout', 'epic/5');
  writeFileSync(join(repo, 'shared.txt'), 'epic side\n');
  git(repo, 'commit', '-am', 'epic side');
  git(repo, 'checkout', 'develop');
  writeFileSync(join(repo, 'shared.txt'), 'develop side\n');
  git(repo, 'commit', '-am', 'develop side');
  git(repo, 'checkout', '--detach');
  return { repo, worktreesDir };
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('sweepOrphanedEpicRefreshWorktrees', () => {
  it('removes an epic-refresh worktree left with an in-progress merge and prunes its registration', async () => {
    const { repo, worktreesDir } = makeFixture();
    const orphan = epicRefreshWorktreePath(worktreesDir, trackerRef(5));
    git(repo, 'worktree', 'add', orphan, 'epic/5');
    expect(() => git(orphan, 'merge', 'develop')).toThrow();
    expect(git(orphan, 'status', '--porcelain')).toContain('UU shared.txt');

    await expect(sweepOrphanedEpicRefreshWorktrees(repo, worktreesDir)).resolves.toEqual([orphan]);

    expect(existsSync(orphan)).toBe(false);
    expect(git(repo, 'worktree', 'list').split('\n').filter(Boolean)).toHaveLength(1);
    expect(git(repo, 'branch', '--list', 'epic/5')).toContain('epic/5');
  });

  it('leaves task worktrees and epic-refresh-named worktrees outside the managed directory alone', async () => {
    const { repo, worktreesDir } = makeFixture();
    const task = join(worktreesDir, 'task-12');
    const foreign = join(realpathSync(tmpdir()), `epic-refresh-foreign-${process.pid}`);
    tmpDirs.push(foreign);
    git(repo, 'worktree', 'add', task, 'epic/6');
    git(repo, 'worktree', 'add', '--detach', foreign, 'develop');

    await expect(sweepOrphanedEpicRefreshWorktrees(repo, worktreesDir)).resolves.toEqual([]);

    expect(existsSync(task)).toBe(true);
    expect(existsSync(foreign)).toBe(true);
  });
});
