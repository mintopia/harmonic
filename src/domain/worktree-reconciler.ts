import { existsSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { GitError } from './errors.js';
import { forEachYielding } from '../reliability/yield.js';
import { startOperation } from '../telemetry/operations.js';
import type { FlaggedWorktree } from './flagged-worktrees.js';

/** A non-terminal Task the runner may still be, or become, active on. */
export interface ActiveTask {
  id: number;
  workspaceId: number;
}

type ActiveTaskSource = () => Promise<readonly ActiveTask[]>;

export interface ManagedWorkspace {
  id: number;
  workingDir: string;
}

type WorkspaceSource = () => Promise<readonly ManagedWorkspace[]>;

export interface WorktreeRecord {
  path: string;
  branch: string | null;
}

export interface WorktreeRepository {
  listWorktrees(repoDir: string): Promise<readonly WorktreeRecord[]>;
  isDirty(dir: string): Promise<boolean>;
  isValidWorktree(repoDir: string, worktreePath: string): Promise<boolean>;
  addWorktreeCheckout(repoDir: string, worktreePath: string, branch: string): Promise<unknown>;
  branchExists(repoDir: string, branch: string): Promise<boolean>;
  removeWorktreeAndDeleteBranch(
    repoDir: string,
    worktreePath: string,
    branch: string | null,
    beforeRemove: () => Promise<boolean>,
  ): Promise<boolean>;
}

export interface FlaggedWorktreeStore {
  replace(flags: readonly FlaggedWorktree[]): void;
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

const TASK_WORKTREE_NAME = /^task-(\d+)$/;

function parseTaskId(name: string): number | null {
  const match = TASK_WORKTREE_NAME.exec(name);
  return match ? Number(match[1]) : null;
}

/**
 * Boot/periodic worktree reconciliation. A live Task's worktree is recreated
 * when missing; a terminal Task's clean worktree is removed; anything dirty,
 * unreadable, or unrecognized is left on disk and surfaced through `flagStore`
 * for an operator. Only paths under the managed worktree root are ever touched.
 */
export class WorktreeReconciler {
  private readonly managedRoot: string;

  constructor(
    private readonly activeTasks: ActiveTaskSource,
    private readonly workspaces: WorkspaceSource,
    private readonly git: WorktreeRepository,
    worktreesDir: string,
    private readonly flagStore: FlaggedWorktreeStore,
    /** Reap the removed worktree's jCodeMunch index; defaults to a no-op. */
    private readonly reapIndex: (absPath: string) => Promise<void> = async () => {},
  ) {
    this.managedRoot = resolve(worktreesDir);
  }

  private worktreePathForTask(taskId: number): string {
    return join(this.managedRoot, `task-${taskId}`);
  }

  private branchForTask(taskId: number): string {
    return `harmonic/task-${taskId}`;
  }

  async reconcile(): Promise<{ removed: number; recreated: number; flagged: number }> {
    const operation = startOperation({ type: 'worktree.reconcile', attributes: {} });
    try {
      const result = await operation.run(() => this.reconcileAll());
      operation.update({
        'worktree.removed': result.removed,
        'worktree.recreated': result.recreated,
        'worktree.flagged': result.flagged,
      });
      operation.end();
      return result;
    } catch (error) {
      operation.fail(error);
      throw error;
    }
  }

  private async reconcileAll(): Promise<{ removed: number; recreated: number; flagged: number }> {
    const activeByWorkspace = new Map<number, ActiveTask[]>();
    await forEachYielding(await this.activeTasks(), async (task) => {
      const list = activeByWorkspace.get(task.workspaceId) ?? [];
      list.push(task);
      activeByWorkspace.set(task.workspaceId, list);
    });

    let removed = 0;
    let recreated = 0;
    const flags: FlaggedWorktree[] = [];
    let firstError: unknown;

    await forEachYielding(await this.workspaces(), async (workspace) => {
      try {
        const active = activeByWorkspace.get(workspace.id) ?? [];

        let worktrees: readonly WorktreeRecord[];
        try {
          worktrees = await this.git.listWorktrees(workspace.workingDir);
        } catch (error) {
          if (error instanceof GitError && /not a git repository/i.test(`${error.message}\n${error.stderr}`)) return;
          throw error;
        }

        const missing = await this.recreateMissing(workspace, active);
        recreated += missing.recreated;
        flags.push(...missing.flags);
        const activeIds = new Set(active.map((task) => task.id));
        const outcome = await this.removeOrFlag(workspace, worktrees, activeIds);
        removed += outcome.removed;
        flags.push(...outcome.flags);
      } catch (error) {
        firstError ??= error;
      }
    });

    this.flagStore.replace(flags);
    if (firstError !== undefined) throw firstError;
    return { removed, recreated, flagged: flags.length };
  }

  private async recreateMissing(
    workspace: ManagedWorkspace,
    active: readonly ActiveTask[],
  ): Promise<{ recreated: number; flags: FlaggedWorktree[] }> {
    let recreated = 0;
    const flags: FlaggedWorktree[] = [];
    await forEachYielding(active, async (task) => {
      const path = this.worktreePathForTask(task.id);
      if (await this.git.isValidWorktree(workspace.workingDir, path)) return;
      if (existsSync(path)) {
        flags.push({ path, repoDir: workspace.workingDir, workspaceId: workspace.id, taskId: task.id, branch: this.branchForTask(task.id), reason: 'unreadable' });
        return;
      }
      const branch = this.branchForTask(task.id);
      if (!(await this.git.branchExists(workspace.workingDir, branch))) return;
      await this.git.addWorktreeCheckout(workspace.workingDir, path, branch);
      recreated++;
    });
    return { recreated, flags };
  }

  private async removeOrFlag(
    workspace: ManagedWorkspace,
    worktrees: readonly WorktreeRecord[],
    activeIds: ReadonlySet<number>,
  ): Promise<{ removed: number; flags: FlaggedWorktree[] }> {
    let removed = 0;
    const flags: FlaggedWorktree[] = [];
    await forEachYielding(worktrees, async (worktree) => {
      const path = resolve(worktree.path);
      if (!isInside(this.managedRoot, path)) return;
      const taskId = parseTaskId(basename(path));
      if (taskId === null) {
        flags.push({ path, repoDir: workspace.workingDir, workspaceId: workspace.id, taskId: null, branch: worktree.branch, reason: 'unrecognized' });
        return;
      }
      if (activeIds.has(taskId)) return;

      if (!(await this.git.isValidWorktree(workspace.workingDir, path))) {
        flags.push({ path, repoDir: workspace.workingDir, workspaceId: workspace.id, taskId, branch: worktree.branch, reason: 'unreadable' });
        return;
      }
      if (await this.git.isDirty(path)) {
        flags.push({ path, repoDir: workspace.workingDir, workspaceId: workspace.id, taskId, branch: worktree.branch, reason: 'dirty' });
        return;
      }
      const didRemove = await this.git.removeWorktreeAndDeleteBranch(workspace.workingDir, path, worktree.branch, async () => {
        const stillActive = (await this.activeTasks()).some((task) => task.id === taskId);
        return !stillActive && !(await this.git.isDirty(path));
      });
      if (didRemove) {
        removed++;
        await this.reapIndex(path);
      }
    });
    return { removed, flags };
  }
}
