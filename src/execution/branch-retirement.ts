import type { AttemptRow, TaskRow } from '../db/schema.js';
import { forEachYielding, type YieldOptions } from '../reliability/yield.js';
import { Git } from './git.js';
import { logger } from '../logger.js';

/** The minimum git operations needed to retire a Harmonic-owned branch. */
export interface BranchRetirementGit {
  branchExists(dir: string, branch: string): Promise<boolean>;
  branchCheckedOutAt(dir: string, branch: string): Promise<string | null>;
  symbolicBranch(dir: string): Promise<string | null>;
  isContentContained(dir: string, baseBranch: string, branch: string): Promise<boolean>;
  deleteBranch(dir: string, branch: string): Promise<unknown>;
}

type BranchRun = Pick<AttemptRow, 'id' | 'taskId' | 'state' | 'branch' | 'baseBranch'>;
type BranchTask = Pick<TaskRow, 'workingDir' | 'state' | 'origin' | 'trackerState' | 'isolationMode'>;
interface BranchRunStore {
  listAll(): Promise<BranchRun[]>;
}
interface BranchTaskStore {
  get(id: number): Promise<BranchTask>;
}

/**
 * Deletes only a Run candidate that is redundant in its retained base ref.
 * Every check is deliberately conservative: an unknown branch, an active
 * worktree, or non-contained commits leave the ref untouched for an operator.
 */
export class BranchRetirementCoordinator {
  constructor(
    private readonly runs: BranchRunStore,
    private readonly tasks: BranchTaskStore,
    private readonly git: BranchRetirementGit = Git,
    private readonly onError: (message: string) => void = logger.error,
  ) {}

  async onRunSettled(task: BranchTask, run: BranchRun): Promise<void> {
    if (run.state === 'running' || task.isolationMode !== 'worktree' || run.branch == null || !isRetirableTask(task)) return;
    const retainedBranch = await this.git.symbolicBranch(task.workingDir);
    if (retainedBranch === null) return;
    await this.retireContained(task.workingDir, run.branch, retainedBranch);
  }

  /** Backfill terminal Run candidates from prior Harmonic versions. */
  async reconcile(options?: YieldOptions): Promise<void> {
    await forEachYielding(await this.runs.listAll(), async (run) => {
      if (run.state === 'running') return;
      try {
        await this.onRunSettled(await this.tasks.get(run.taskId), run);
      } catch (err) {
        this.onError(`run ${run.id} candidate retirement failed: ${String(err)}`);
      }
    }, options);
  }

  /** Retire an Epic integration branch only when it is safely contained. */
  async retireEpic(repoDir: string, branch: string, retainedBranch: string): Promise<void> {
    await this.retireContained(repoDir, branch, retainedBranch);
  }

  private async retireContained(repoDir: string, branch: string, retainedBranch: string): Promise<void> {
    try {
      if (!(await this.git.branchExists(repoDir, branch))) return;
      if ((await this.git.branchCheckedOutAt(repoDir, branch)) !== null) return;
      if (!(await this.git.isContentContained(repoDir, retainedBranch, branch))) return;
      await this.git.deleteBranch(repoDir, branch);
    } catch (err) {
      this.onError(`branch '${branch}' retirement failed: ${String(err)}`);
    }
  }
}

function isRetirableTask(task: BranchTask): boolean {
  if (task.state !== 'done' && task.state !== 'cancelled') return false;
  return task.origin === 'native' || task.trackerState === 'closed';
}
