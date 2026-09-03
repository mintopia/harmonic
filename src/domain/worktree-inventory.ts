import { basename, join, resolve } from 'node:path';
import { forEachYielding } from '../reliability/yield.js';
import type { TaskOrigin, TaskState } from '../db/schema.js';
import { GitError } from './errors.js';
import type { WorktreeRecord } from './worktree-reconciler.js';

export type WorktreeState = 'Active' | 'Stale' | 'Dirty' | 'Unreadable' | 'Orphan' | 'Missing';

export type WorktreeSubject =
  | { kind: 'task'; taskId: number; title: string }
  | { kind: 'epic'; epicRef: number; title: string };

export interface WorktreeInventoryEntry {
  workspaceId: number;
  path: string;
  branch: string | null;
  subject: WorktreeSubject | null;
  sizeBytes: number | null;
  dirty: boolean | null;
  state: WorktreeState;
}

export function worktreeId(entry: Pick<WorktreeInventoryEntry, 'workspaceId' | 'path'>): string {
  return Buffer.from(JSON.stringify([entry.workspaceId, entry.path])).toString('base64url');
}

interface InventoryWorkspace {
  id: number;
  workingDir: string;
}

interface InventoryTask {
  id: number;
  workspaceId: number | null;
  origin: TaskOrigin;
  state: TaskState;
  trackerTitle: string | null;
  trackerParent: number | null;
  trackerRef?: number | null;
}

export interface WorktreeInventoryRepository {
  listWorktrees(repoDir: string): Promise<readonly WorktreeRecord[]>;
  isDirty(dir: string): Promise<boolean>;
  isValidWorktree(repoDir: string, worktreePath: string): Promise<boolean>;
  pathExists(path: string): Promise<boolean>;
  worktreeSize(path: string): Promise<number>;
}

type WorkspaceSource = () => Promise<readonly InventoryWorkspace[]>;
type TaskSource = () => Promise<readonly InventoryTask[]>;

const taskWorktreeName = /^task-(\d+)$/;
const terminalStates = new Set<TaskState>(['done', 'cancelled']);

function taskIdFor(path: string): number | null {
  const match = taskWorktreeName.exec(basename(path));
  return match ? Number(match[1]) : null;
}

function titleFor(task: InventoryTask): string {
  return task.trackerTitle ?? `Task ${task.id}`;
}

function subjectFor(task: InventoryTask, byTrackerRef: ReadonlyMap<number, InventoryTask>): WorktreeSubject {
  if (task.trackerParent === null) return { kind: 'task', taskId: task.id, title: titleFor(task) };
  const parent = byTrackerRef.get(task.trackerParent);
  return { kind: 'epic', epicRef: task.trackerParent, title: parent ? titleFor(parent) : `Epic ${task.trackerParent}` };
}

export class WorktreeInventory {
  private readonly worktreesDir: string;

  constructor(
    private readonly workspaces: WorkspaceSource,
    private readonly tasks: TaskSource,
    private readonly git: WorktreeInventoryRepository,
    worktreesDir: string,
  ) {
    this.worktreesDir = resolve(worktreesDir);
  }

  async snapshot(): Promise<WorktreeInventoryEntry[]> {
    const byWorkspace = new Map<number, InventoryTask[]>();
    const byTrackerRef = new Map<number, InventoryTask>();
    await forEachYielding(await this.tasks(), (task) => {
      if (task.origin !== 'mirrored' || task.workspaceId === null) return;
      const tasks = byWorkspace.get(task.workspaceId) ?? [];
      tasks.push(task);
      byWorkspace.set(task.workspaceId, tasks);
      if (task.trackerRef !== null && task.trackerRef !== undefined) byTrackerRef.set(task.trackerRef, task);
    });

    const entries: WorktreeInventoryEntry[] = [];
    await forEachYielding(await this.workspaces(), async (workspace) => {
      const tasks = byWorkspace.get(workspace.id) ?? [];
      const byId = new Map<number, InventoryTask>();
      await forEachYielding(tasks, (task) => {
        byId.set(task.id, task);
      });
      let listed: readonly WorktreeRecord[];
      try {
        listed = await this.git.listWorktrees(workspace.workingDir);
      } catch (error) {
        if (error instanceof GitError && /not a git repository/i.test(`${error.message}\n${error.stderr}`)) return;
        throw error;
      }
      const listedTaskIds = new Set<number>();
      await forEachYielding(listed, async (worktree) => {
        const taskId = taskIdFor(worktree.path);
        if (taskId !== null) listedTaskIds.add(taskId);
        const task = taskId === null ? undefined : byId.get(taskId);
        entries.push(await this.entryFor(workspace, worktree, task, byTrackerRef));
      });
      await forEachYielding(tasks, async (task) => {
        if (task.state !== 'working' || listedTaskIds.has(task.id)) return;
        entries.push({
          workspaceId: workspace.id,
          path: join(this.worktreesDir, `task-${task.id}`),
          branch: `harmonic/task-${task.id}`,
          subject: subjectFor(task, byTrackerRef),
          sizeBytes: null,
          dirty: null,
          state: 'Missing',
        });
      });
    });
    return entries;
  }

  private async entryFor(
    workspace: InventoryWorkspace,
    worktree: WorktreeRecord,
    task: InventoryTask | undefined,
    byTrackerRef: ReadonlyMap<number, InventoryTask>,
  ): Promise<WorktreeInventoryEntry> {
    const path = worktree.path;
    const subject = task ? subjectFor(task, byTrackerRef) : null;
    try {
      if (!(await this.git.isValidWorktree(workspace.workingDir, path))) {
        if (!(await this.git.pathExists(path))) {
          return { workspaceId: workspace.id, path, branch: worktree.branch, subject, sizeBytes: null, dirty: null, state: 'Missing' };
        }
        return { workspaceId: workspace.id, path, branch: worktree.branch, subject, sizeBytes: null, dirty: null, state: 'Unreadable' };
      }
      const [sizeBytes, dirty] = await Promise.all([this.git.worktreeSize(path), this.git.isDirty(path)]);
      const state: WorktreeState = !task ? 'Orphan' : terminalStates.has(task.state) ? 'Stale' : dirty ? 'Dirty' : 'Active';
      return { workspaceId: workspace.id, path, branch: worktree.branch, subject, sizeBytes, dirty, state };
    } catch {
      return { workspaceId: workspace.id, path, branch: worktree.branch, subject, sizeBytes: null, dirty: null, state: 'Unreadable' };
    }
  }
}
