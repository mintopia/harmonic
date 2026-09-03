import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorktreeReconciler, type WorktreeRepository } from '../src/domain/worktree-reconciler.js';
import { Git } from '../src/execution/git.js';

const tempDirs: string[] = [];
const tempDir = (prefix: string) => {
  // realpath so paths match git's canonical worktree paths (macOS /var → /private/var symlink).
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
};
const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakeGit(overrides: Partial<WorktreeRepository>): WorktreeRepository {
  const unexpected = (name: string) => async () => {
    throw new Error(`unexpected call to ${name}`);
  };
  return {
    listWorktrees: overrides.listWorktrees ?? unexpected('listWorktrees'),
    isDirty: overrides.isDirty ?? unexpected('isDirty'),
    isValidWorktree: overrides.isValidWorktree ?? unexpected('isValidWorktree'),
    addWorktreeCheckout: overrides.addWorktreeCheckout ?? unexpected('addWorktreeCheckout'),
    branchExists: overrides.branchExists ?? unexpected('branchExists'),
    removeWorktreeAndDeleteBranch: overrides.removeWorktreeAndDeleteBranch ?? unexpected('removeWorktreeAndDeleteBranch'),
  };
}

describe('worktree reconciler (issue #386, ADR-0010)', () => {
  it('leaves a dirty worktree of a terminal task on disk', async () => {
    const managedRoot = '/harmonic/worktrees';
    const path = join(managedRoot, 'task-5');
    const removeWorktreeAndDeleteBranch = vi.fn();

    const reconciler = new WorktreeReconciler(
      async () => [],
      async () => [{ id: 1, workingDir: '/repo' }],
      fakeGit({
        listWorktrees: async () => [{ path, branch: 'harmonic/task-5' }],
        isValidWorktree: async () => true,
        isDirty: async () => true,
        removeWorktreeAndDeleteBranch,
      }),
      managedRoot,
    );

    await expect(reconciler.reconcile()).resolves.toEqual({ removed: 0, recreated: 0, flagged: 1 });
    expect(removeWorktreeAndDeleteBranch).not.toHaveBeenCalled();
  });

  it('leaves an unreadable worktree of a terminal task on disk', async () => {
    const managedRoot = '/harmonic/worktrees';
    const path = join(managedRoot, 'task-9');
    const removeWorktreeAndDeleteBranch = vi.fn();

    const reconciler = new WorktreeReconciler(
      async () => [],
      async () => [{ id: 1, workingDir: '/repo' }],
      fakeGit({
        listWorktrees: async () => [{ path, branch: 'harmonic/task-9' }],
        isValidWorktree: async () => false,
        removeWorktreeAndDeleteBranch,
      }),
      managedRoot,
    );

    await expect(reconciler.reconcile()).resolves.toEqual({ removed: 0, recreated: 0, flagged: 1 });
    expect(removeWorktreeAndDeleteBranch).not.toHaveBeenCalled();
  });

  it('removes a clean worktree of a terminal task and reaps its index, rechecking under the lock', async () => {
    const managedRoot = '/harmonic/worktrees';
    const path = join(managedRoot, 'task-2');
    const reaped: string[] = [];
    let beforeRemoveResult: boolean | undefined;

    const reconciler = new WorktreeReconciler(
      async () => [],
      async () => [{ id: 1, workingDir: '/repo' }],
      fakeGit({
        listWorktrees: async () => [{ path, branch: 'harmonic/task-2' }],
        isValidWorktree: async () => true,
        isDirty: async () => false,
        removeWorktreeAndDeleteBranch: async (repoDir, worktreePath, branch, beforeRemove) => {
          beforeRemoveResult = await beforeRemove();
          expect(repoDir).toBe('/repo');
          expect(worktreePath).toBe(path);
          expect(branch).toBe('harmonic/task-2');
          return beforeRemoveResult;
        },
      }),
      managedRoot,
      async (absPath) => {
        reaped.push(absPath);
      },
    );

    await expect(reconciler.reconcile()).resolves.toEqual({ removed: 1, recreated: 0, flagged: 0 });
    expect(beforeRemoveResult).toBe(true);
    expect(reaped).toEqual([path]);
  });

  it('recreates a live task worktree via addWorktreeCheckout when its branch still exists', async () => {
    const managedRoot = '/harmonic/worktrees';
    const path = join(managedRoot, 'task-7');
    const addWorktreeCheckout = vi.fn(async () => {});

    const reconciler = new WorktreeReconciler(
      async () => [{ id: 7, workspaceId: 1 }],
      async () => [{ id: 1, workingDir: '/repo' }],
      fakeGit({
        listWorktrees: async () => [],
        isValidWorktree: async () => false,
        branchExists: async () => true,
        addWorktreeCheckout,
      }),
      managedRoot,
    );

    await expect(reconciler.reconcile()).resolves.toEqual({ removed: 0, recreated: 1, flagged: 0 });
    expect(addWorktreeCheckout).toHaveBeenCalledWith('/repo', path, 'harmonic/task-7');
  });

  it('leaves a live task worktree that is present but unreadable, never discarding it', async () => {
    const managedRoot = tempDir('harmonic-reconcile-unreadable-');
    const path = join(managedRoot, 'task-7');
    mkdirSync(path);
    const addWorktreeCheckout = vi.fn(async () => {});

    const reconciler = new WorktreeReconciler(
      async () => [{ id: 7, workspaceId: 1 }],
      async () => [{ id: 1, workingDir: '/repo' }],
      fakeGit({
        listWorktrees: async () => [],
        isValidWorktree: async () => false,
        addWorktreeCheckout,
      }),
      managedRoot,
    );

    await expect(reconciler.reconcile()).resolves.toEqual({ removed: 0, recreated: 0, flagged: 1 });
    expect(addWorktreeCheckout).not.toHaveBeenCalled();
    expect(existsSync(path)).toBe(true);
  });

  it('does NOT recreate a live task worktree when its branch is gone', async () => {
    const managedRoot = '/harmonic/worktrees';
    const addWorktreeCheckout = vi.fn(async () => {});

    const reconciler = new WorktreeReconciler(
      async () => [{ id: 7, workspaceId: 1 }],
      async () => [{ id: 1, workingDir: '/repo' }],
      fakeGit({
        listWorktrees: async () => [],
        isValidWorktree: async () => false,
        branchExists: async () => false,
        addWorktreeCheckout,
      }),
      managedRoot,
    );

    await expect(reconciler.reconcile()).resolves.toEqual({ removed: 0, recreated: 0, flagged: 0 });
    expect(addWorktreeCheckout).not.toHaveBeenCalled();
  });

  it('leaves a managed path that does not parse as task-<id> on disk', async () => {
    const managedRoot = '/harmonic/worktrees';
    const path = join(managedRoot, 'scratch');
    const removeWorktreeAndDeleteBranch = vi.fn();

    const reconciler = new WorktreeReconciler(
      async () => [],
      async () => [{ id: 1, workingDir: '/repo' }],
      fakeGit({
        listWorktrees: async () => [{ path, branch: 'operator/wip' }],
        removeWorktreeAndDeleteBranch,
      }),
      managedRoot,
    );

    await expect(reconciler.reconcile()).resolves.toEqual({ removed: 0, recreated: 0, flagged: 1 });
    expect(removeWorktreeAndDeleteBranch).not.toHaveBeenCalled();
  });

  it('(real git) removes a clean orphaned task-<id> worktree and its dangling branch', async () => {
    const repo = tempDir('harmonic-reconcile-repo-');
    execFileSync('git', ['init', '-b', 'main', repo], { encoding: 'utf8' });
    git(repo, 'config', 'user.name', 'Test');
    git(repo, 'config', 'user.email', 'test@example.com');
    writeFileSync(join(repo, 'README.md'), '# repo\n');
    git(repo, 'add', 'README.md');
    git(repo, 'commit', '-m', 'init');
    const managedRoot = tempDir('harmonic-reconcile-worktrees-');
    const orphan = join(managedRoot, 'task-1');
    git(repo, 'worktree', 'add', '-b', 'harmonic/task-1', orphan);

    const reconciler = new WorktreeReconciler(
      async () => [],
      async () => [{ id: 1, workingDir: repo }],
      Git,
      managedRoot,
    );

    await expect(reconciler.reconcile()).resolves.toEqual({ removed: 1, recreated: 0, flagged: 0 });
    expect(existsSync(orphan)).toBe(false);
    expect(git(repo, 'branch', '--list', 'harmonic/task-1')).toBe('');
  });

  it('(real git) leaves a dirty task-<id> worktree of a terminal task on disk and surfaces it', async () => {
    const repo = tempDir('harmonic-reconcile-repo-');
    execFileSync('git', ['init', '-b', 'main', repo], { encoding: 'utf8' });
    git(repo, 'config', 'user.name', 'Test');
    git(repo, 'config', 'user.email', 'test@example.com');
    writeFileSync(join(repo, 'README.md'), '# repo\n');
    git(repo, 'add', 'README.md');
    git(repo, 'commit', '-m', 'init');
    const managedRoot = tempDir('harmonic-reconcile-worktrees-');
    const dirty = join(managedRoot, 'task-2');
    git(repo, 'worktree', 'add', '-b', 'harmonic/task-2', dirty);
    writeFileSync(join(dirty, 'WIP.md'), 'not yet committed\n');

    const reconciler = new WorktreeReconciler(
      async () => [],
      async () => [{ id: 1, workingDir: repo }],
      Git,
      managedRoot,
    );

    await expect(reconciler.reconcile()).resolves.toEqual({ removed: 0, recreated: 0, flagged: 1 });
    expect(existsSync(dirty)).toBe(true);
    expect(git(repo, 'branch', '--list', 'harmonic/task-2')).not.toBe('');
  });
});
