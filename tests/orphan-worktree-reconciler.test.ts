import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OrphanWorktreeReconciler } from '../src/domain/orphan-worktree-reconciler.js';
import { Git } from '../src/execution/git.js';

const tempDirs: string[] = [];
const tempDir = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};
const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('orphan worktree reconcile (issue #304)', () => {
  it('removes only unowned managed worktrees and their checked-out branches', async () => {
    const managedRoot = '/harmonic/worktrees';
    const removed: Array<{ repoDir: string; path: string; branch: string | null }> = [];
    const reconciler = new OrphanWorktreeReconciler(
      {
        listWorktreeOwners: async () => [
          { worktreePath: join(managedRoot, 'run-2') },
          { worktreePath: join(managedRoot, 'run-4') },
        ],
      },
      { listAllRunning: async () => [{ id: 3 }] },
      async () => [{ workingDir: '/repo' }],
      {
        listWorktrees: async () => [
          { path: join(managedRoot, 'run-1'), branch: 'harmonic/task-1-run-1' },
          { path: join(managedRoot, 'run-2'), branch: 'harmonic/task-2-run-1' },
          { path: join(managedRoot, 'verify-3'), branch: null },
          { path: join(managedRoot, 'run-4'), branch: 'harmonic/task-4-run-1' },
          { path: '/repo/operator-worktree', branch: 'operator/wip' },
        ],
        removeWorktreeAndDeleteBranch: async (repoDir, path, branch) => {
          removed.push({ repoDir, path, branch });
          return true;
        },
      },
      managedRoot,
    );

    await expect(reconciler.reconcile()).resolves.toEqual({ removed: 1 });
    expect(removed).toEqual([
      { repoDir: '/repo', path: join(managedRoot, 'run-1'), branch: 'harmonic/task-1-run-1' },
    ]);
  });

  it('rechecks ownership under the repository lock before removal', async () => {
    const managedRoot = '/harmonic/worktrees';
    let claimed = false;
    const reconciler = new OrphanWorktreeReconciler(
      { listWorktreeOwners: async () => (claimed ? [{ worktreePath: join(managedRoot, 'run-1') }] : []) },
      { listAllRunning: async () => [] },
      async () => [{ workingDir: '/repo' }],
      {
        listWorktrees: async () => [{ path: join(managedRoot, 'run-1'), branch: 'harmonic/task-1-run-1' }],
        removeWorktreeAndDeleteBranch: async (_repoDir, _path, _branch, beforeRemove) => {
          claimed = true;
          return beforeRemove();
        },
      },
      managedRoot,
    );

    await expect(reconciler.reconcile()).resolves.toEqual({ removed: 0 });
  });

  it('removes a real orphaned worktree and its dangling branch', async () => {
    const repo = tempDir('harmonic-orphan-repo-');
    execFileSync('git', ['init', '-b', 'main', repo], { encoding: 'utf8' });
    git(repo, 'config', 'user.name', 'Test');
    git(repo, 'config', 'user.email', 'test@example.com');
    writeFileSync(join(repo, 'README.md'), '# repo\n');
    git(repo, 'add', 'README.md');
    git(repo, 'commit', '-m', 'init');
    const managedRoot = tempDir('harmonic-orphan-worktrees-');
    const orphan = join(managedRoot, 'run-1');
    git(repo, 'worktree', 'add', '-b', 'harmonic/task-1-run-1', orphan);

    const reconciler = new OrphanWorktreeReconciler(
      { listWorktreeOwners: async () => [] },
      { listAllRunning: async () => [] },
      async () => [{ workingDir: repo }],
      Git,
      managedRoot,
    );

    await expect(reconciler.reconcile()).resolves.toEqual({ removed: 1 });
    expect(existsSync(orphan)).toBe(false);
    expect(git(repo, 'branch', '--list', 'harmonic/task-1-run-1')).toBe('');
  });
});
