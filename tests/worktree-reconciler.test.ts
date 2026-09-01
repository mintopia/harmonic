import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorktreeReconciler, type WorktreeRepository } from '../src/domain/worktree-reconciler.js';
import type { FlaggedWorktree } from '../src/domain/flagged-worktrees.js';
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

/** A fake satisfying {@link WorktreeRepository} that fails loudly on any method
 * a test did not expect to be exercised — narrower than a full vi mock, but
 * catches an unintended extra call (e.g. `isDirty` short-circuited past by an
 * earlier `isValidWorktree: false`). */
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

function flagStore() {
  let current: readonly FlaggedWorktree[] = [];
  return {
    store: { replace: (flags: readonly FlaggedWorktree[]) => { current = flags; } },
    snapshot: () => current,
  };
}

describe('worktree reconciler (issue #386, ADR-0010)', () => {
  it('flags a dirty worktree of a terminal task and does NOT remove it', async () => {
    const managedRoot = '/harmonic/worktrees';
    const path = join(managedRoot, 'task-5');
    const { store, snapshot } = flagStore();
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
      store,
    );

    await expect(reconciler.reconcile()).resolves.toEqual({ removed: 0, recreated: 0, flagged: 1 });
    expect(removeWorktreeAndDeleteBranch).not.toHaveBeenCalled();
    expect(snapshot()).toEqual([
      { path, repoDir: '/repo', workspaceId: 1, taskId: 5, branch: 'harmonic/task-5', reason: 'dirty' },
    ]);
  });

  it('flags an unreadable worktree of a terminal task and does NOT remove it', async () => {
    const managedRoot = '/harmonic/worktrees';
    const path = join(managedRoot, 'task-9');
    const { store, snapshot } = flagStore();
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
      store,
    );

    await expect(reconciler.reconcile()).resolves.toEqual({ removed: 0, recreated: 0, flagged: 1 });
    expect(removeWorktreeAndDeleteBranch).not.toHaveBeenCalled();
    expect(snapshot()).toEqual([
      { path, repoDir: '/repo', workspaceId: 1, taskId: 9, branch: 'harmonic/task-9', reason: 'unreadable' },
    ]);
  });

  it('removes a clean worktree of a terminal task and reaps its index, rechecking under the lock', async () => {
    const managedRoot = '/harmonic/worktrees';
    const path = join(managedRoot, 'task-2');
    const { store, snapshot } = flagStore();
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
      store,
      async (absPath) => {
        reaped.push(absPath);
      },
    );

    await expect(reconciler.reconcile()).resolves.toEqual({ removed: 1, recreated: 0, flagged: 0 });
    expect(beforeRemoveResult).toBe(true);
    expect(reaped).toEqual([path]);
    expect(snapshot()).toEqual([]);
  });

  it('recreates a live task worktree via addWorktreeCheckout when its branch still exists', async () => {
    const managedRoot = '/harmonic/worktrees';
    const path = join(managedRoot, 'task-7');
    const { store } = flagStore();
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
      store,
    );

    await expect(reconciler.reconcile()).resolves.toEqual({ removed: 0, recreated: 1, flagged: 0 });
    expect(addWorktreeCheckout).toHaveBeenCalledWith('/repo', path, 'harmonic/task-7');
  });

  it('flags a live task worktree that is present but unreadable, never discarding it', async () => {
    // A live Task whose expected path exists on disk but git no longer resolves
    // as a live worktree may still hold uncommitted work. The passive sweep must
    // surface it, not force-delete it (ADR-0010: a crash must not cost work).
    const managedRoot = tempDir('harmonic-reconcile-unreadable-');
    const path = join(managedRoot, 'task-7');
    mkdirSync(path);
    const { store, snapshot } = flagStore();
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
      store,
    );

    await expect(reconciler.reconcile()).resolves.toEqual({ removed: 0, recreated: 0, flagged: 1 });
    expect(addWorktreeCheckout).not.toHaveBeenCalled();
    expect(existsSync(path)).toBe(true);
    expect(snapshot()).toEqual([
      { path, repoDir: '/repo', workspaceId: 1, taskId: 7, branch: 'harmonic/task-7', reason: 'unreadable' },
    ]);
  });

  it('does NOT recreate a live task worktree when its branch is gone', async () => {
    const managedRoot = '/harmonic/worktrees';
    const { store } = flagStore();
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
      store,
    );

    await expect(reconciler.reconcile()).resolves.toEqual({ removed: 0, recreated: 0, flagged: 0 });
    expect(addWorktreeCheckout).not.toHaveBeenCalled();
  });

  it('flags a managed path that does not parse as task-<id> and never removes it', async () => {
    const managedRoot = '/harmonic/worktrees';
    const path = join(managedRoot, 'scratch');
    const { store, snapshot } = flagStore();
    const removeWorktreeAndDeleteBranch = vi.fn();

    const reconciler = new WorktreeReconciler(
      async () => [],
      async () => [{ id: 1, workingDir: '/repo' }],
      fakeGit({
        listWorktrees: async () => [{ path, branch: 'operator/wip' }],
        removeWorktreeAndDeleteBranch,
      }),
      managedRoot,
      store,
    );

    await expect(reconciler.reconcile()).resolves.toEqual({ removed: 0, recreated: 0, flagged: 1 });
    expect(removeWorktreeAndDeleteBranch).not.toHaveBeenCalled();
    expect(snapshot()).toEqual([
      { path, repoDir: '/repo', workspaceId: 1, taskId: null, branch: 'operator/wip', reason: 'unrecognized' },
    ]);
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
    const { store, snapshot } = flagStore();

    const reconciler = new WorktreeReconciler(
      async () => [],
      async () => [{ id: 1, workingDir: repo }],
      Git,
      managedRoot,
      store,
    );

    await expect(reconciler.reconcile()).resolves.toEqual({ removed: 1, recreated: 0, flagged: 0 });
    expect(existsSync(orphan)).toBe(false);
    expect(git(repo, 'branch', '--list', 'harmonic/task-1')).toBe('');
    expect(snapshot()).toEqual([]);
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
    // Uncommitted work in the worktree — a crash must not cost this.
    writeFileSync(join(dirty, 'WIP.md'), 'not yet committed\n');
    const { store, snapshot } = flagStore();

    const reconciler = new WorktreeReconciler(
      async () => [],
      async () => [{ id: 1, workingDir: repo }],
      Git,
      managedRoot,
      store,
    );

    await expect(reconciler.reconcile()).resolves.toEqual({ removed: 0, recreated: 0, flagged: 1 });
    expect(existsSync(dirty)).toBe(true);
    expect(git(repo, 'branch', '--list', 'harmonic/task-2')).not.toBe('');
    expect(snapshot()).toEqual([
      { path: dirty, repoDir: repo, workspaceId: 1, taskId: 2, branch: 'harmonic/task-2', reason: 'dirty' },
    ]);
  });
});
