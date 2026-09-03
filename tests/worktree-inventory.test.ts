import { describe, expect, it } from 'vitest';
import { WorktreeInventory, type WorktreeInventoryRepository } from '../src/domain/worktree-inventory.js';

function repository(overrides: Partial<WorktreeInventoryRepository>): WorktreeInventoryRepository {
  const unexpected = (name: string) => async () => {
    throw new Error(`unexpected call to ${name}`);
  };
  return {
    listWorktrees: overrides.listWorktrees ?? unexpected('listWorktrees'),
    changeCount: overrides.changeCount ?? unexpected('changeCount'),
    isValidWorktree: overrides.isValidWorktree ?? unexpected('isValidWorktree'),
    pathExists: overrides.pathExists ?? unexpected('pathExists'),
    worktreeSize: overrides.worktreeSize ?? unexpected('worktreeSize'),
  };
}

describe('worktree inventory (issue #482)', () => {
  it('derives every inventory state from the filesystem snapshot and mirrored task rows', async () => {
    const inventory = new WorktreeInventory(
      async () => [{ id: 1, workingDir: '/repo' }],
      async () => [
        { id: 1, workspaceId: 1, origin: 'mirrored', state: 'working', trackerTitle: 'Active issue', trackerParent: null },
        { id: 2, workspaceId: 1, origin: 'mirrored', state: 'done', trackerTitle: 'Completed issue', trackerParent: null },
        { id: 3, workspaceId: 1, origin: 'mirrored', state: 'working', trackerTitle: 'Missing issue', trackerParent: null },
        { id: 4, workspaceId: 1, origin: 'mirrored', state: 'ready', trackerTitle: 'Unreadable issue', trackerParent: null },
      ],
      repository({
        listWorktrees: async () => [
          { path: '/trees/task-1', branch: 'harmonic/task-1' },
          { path: '/trees/task-2', branch: 'harmonic/task-2' },
          { path: '/trees/task-4', branch: 'harmonic/task-4' },
          { path: '/trees/task-99', branch: 'harmonic/task-99' },
          { path: '/trees/scratch', branch: 'operator/wip' },
        ],
        isValidWorktree: async (_repoDir, path) => path !== '/trees/task-4',
        pathExists: async () => true,
        changeCount: async (path) => (path === '/trees/task-1' ? 3 : 0),
        worktreeSize: async () => 42,
      }),
      '/trees',
    );

    await expect(inventory.snapshot()).resolves.toEqual([
      { workspaceId: 1, path: '/trees/task-1', branch: 'harmonic/task-1', subject: { kind: 'task', taskId: 1, title: 'Active issue' }, sizeBytes: 42, dirty: true, changeCount: 3, state: 'Dirty' },
      { workspaceId: 1, path: '/trees/task-2', branch: 'harmonic/task-2', subject: { kind: 'task', taskId: 2, title: 'Completed issue' }, sizeBytes: 42, dirty: false, changeCount: 0, state: 'Stale' },
      { workspaceId: 1, path: '/trees/task-4', branch: 'harmonic/task-4', subject: { kind: 'task', taskId: 4, title: 'Unreadable issue' }, sizeBytes: null, dirty: null, changeCount: null, state: 'Unreadable' },
      { workspaceId: 1, path: '/trees/task-99', branch: 'harmonic/task-99', subject: null, sizeBytes: 42, dirty: false, changeCount: 0, state: 'Orphan' },
      { workspaceId: 1, path: '/trees/scratch', branch: 'operator/wip', subject: null, sizeBytes: 42, dirty: false, changeCount: 0, state: 'Orphan' },
      { workspaceId: 1, path: '/trees/task-3', branch: 'harmonic/task-3', subject: { kind: 'task', taskId: 3, title: 'Missing issue' }, sizeBytes: null, dirty: null, changeCount: null, state: 'Missing' },
    ]);
  });

  it('never reports the base checkout as an orphan even though git lists it first', async () => {
    const inventory = new WorktreeInventory(
      async () => [{ id: 1, workingDir: '/repo' }],
      async () => [],
      repository({
        listWorktrees: async () => [
          { path: '/repo', branch: 'develop' },
          { path: '/trees/task-7', branch: 'harmonic/task-7' },
        ],
        isValidWorktree: async () => true,
        changeCount: async () => 0,
        worktreeSize: async () => 42,
      }),
      '/trees',
    );

    await expect(inventory.snapshot()).resolves.toEqual([
      { workspaceId: 1, path: '/trees/task-7', branch: 'harmonic/task-7', subject: null, sizeBytes: 42, dirty: false, changeCount: 0, state: 'Orphan' },
    ]);
  });
});
