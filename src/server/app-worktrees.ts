import { resolve } from 'node:path';
import { dropIndexForPath } from '../execution/code-index.js';
import { isInside, WorktreeReconciler } from '../domain/worktree-reconciler.js';
import { worktreeId, WorktreeInventory } from '../domain/worktree-inventory.js';
import { Git } from '../execution/git.js';
import { DomainError } from '../domain/errors.js';
import type { TaskRow } from '../db/schema.js';
import type { WorkspaceService } from '../domain/workspaces.js';
import type { TaskService } from '../domain/tasks.js';
import type { EventBus } from './bus.js';

export interface WorktreeServices {
  worktreeInventory: WorktreeInventory;
  publishWorktrees: () => Promise<void>;
  forceCleanupWorktree: (id: string, workspaceId?: number) => Promise<boolean | null>;
  dirtyWorktreeFiles: (id: string, workspaceId?: number) => Promise<string[] | null>;
  reconcileWorktrees: (workspaceId?: number) => Promise<Awaited<ReturnType<WorktreeReconciler['reconcile']>>>;
  worktreesReconciledAt: () => number | null;
}

export function createWorktreeServices(deps: {
  workspaces: WorkspaceService;
  tasks: TaskService;
  bus: EventBus;
  worktreesDir: string;
  managedWorktreesRoot: string;
}): WorktreeServices {
  const { workspaces, tasks, bus, worktreesDir, managedWorktreesRoot } = deps;
  const worktreeInventory = new WorktreeInventory(
    () => workspaces.list(),
    () => tasks.list(),
    Git,
    worktreesDir,
  );
  const worktreeReconciler = new WorktreeReconciler(
    async () => {
      const openTasks = await tasks.list({ state: 'open' });
      return openTasks
        .filter((task): task is TaskRow & { workspaceId: number } => task.workspaceId != null)
        .map((task) => ({ id: task.id, workspaceId: task.workspaceId }));
    },
    () => workspaces.list(),
    Git,
    worktreesDir,
    dropIndexForPath,
  );
  const publishWorktrees = async (): Promise<void> => {
    bus.emit('worktrees', await worktreeInventory.snapshot());
  };
  const forceCleanupWorktree = async (id: string, workspaceId?: number): Promise<boolean | null> => {
    const entry = (await worktreeInventory.snapshot()).find(
      (candidate) => worktreeId(candidate) === id,
    );
    if (!entry || (workspaceId !== undefined && entry.workspaceId !== workspaceId)) return null;

    const worktreePath = resolve(entry.path);
    if (!isInside(managedWorktreesRoot, worktreePath)) {
      throw new DomainError('forbidden', 'worktree is outside Harmonic’s managed worktree root');
    }
    const workspace = await workspaces.get(entry.workspaceId);
    if (!workspace) return false;

    const removed = await Git.removeWorktreeAndDeleteBranch(
      workspace.workingDir,
      worktreePath,
      entry.branch,
      async () => isInside(managedWorktreesRoot, resolve(worktreePath)),
    );
    if (removed) {
      await dropIndexForPath(worktreePath);
      await publishWorktrees();
    }
    return removed;
  };
  const dirtyWorktreeFiles = async (id: string, workspaceId?: number): Promise<string[] | null> => {
    const entry = (await worktreeInventory.snapshot()).find(
      (candidate) => worktreeId(candidate) === id,
    );
    if (!entry || (workspaceId !== undefined && entry.workspaceId !== workspaceId)) return null;

    const worktreePath = resolve(entry.path);
    if (!isInside(managedWorktreesRoot, worktreePath)) {
      throw new DomainError('forbidden', 'worktree is outside Harmonic’s managed worktree root');
    }
    return entry.dirty ? Git.dirtyFiles(worktreePath) : [];
  };
  type ReconciliationResult = Awaited<ReturnType<WorktreeReconciler['reconcile']>>;
  const reconciliationFlights = new Map<number | null, Promise<ReconciliationResult>>();
  let reconciliation = Promise.resolve();
  const reconcileWorktrees = (workspaceId?: number): Promise<ReconciliationResult> => {
    const key = workspaceId ?? null;
    const existing = reconciliationFlights.get(key);
    if (existing) return existing;
    const next = reconciliation.then(async () => {
      const result = await worktreeReconciler.reconcile(workspaceId);
      await publishWorktrees();
      return result;
    });
    reconciliation = next.then(() => undefined, () => undefined);
    reconciliationFlights.set(key, next);
    const clear = () => {
      if (reconciliationFlights.get(key) === next) reconciliationFlights.delete(key);
    };
    next.then(clear, clear);
    return next;
  };
  return {
    worktreeInventory,
    publishWorktrees,
    forceCleanupWorktree,
    dirtyWorktreeFiles,
    reconcileWorktrees,
    worktreesReconciledAt: () => worktreeReconciler.reconciledAt,
  };
}
