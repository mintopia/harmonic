import { type AttemptRow, type TaskRow } from '../db/schema.js';
import { forEachYielding, type YieldOptions } from '../reliability/yield.js';
import { errorMessage } from '../error-handling.js';
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

type BranchAttempt = Pick<AttemptRow, 'id' | 'taskId' | 'state' | 'branch' | 'baseBranch'>;
type BranchTask = Pick<TaskRow, 'workingDir' | 'state' | 'origin' | 'trackerState' | 'isolationMode'>;
interface BranchAttemptStore {
  listAll(): Promise<BranchAttempt[]>;
}
interface BranchTaskStore {
  get(id: number): Promise<BranchTask>;
}

/**
 * Deletes only an Attempt's branch that is redundant in its retained base ref.
 * Every check is deliberately conservative: an unknown branch, an active
 * worktree, or non-contained commits leave the ref untouched for an operator.
 */
export class BranchRetirementCoordinator {
  constructor(
    private readonly attempts: BranchAttemptStore,
    private readonly tasks: BranchTaskStore,
    private readonly git: BranchRetirementGit = Git,
    private readonly onError: (message: string) => void = logger.error,
    /** Records the branch-visibility row on the settled Attempt's lifecycle
     * timeline; absent → the deletion still happens, just unobserved. */
    private readonly recordLifecycle?: (attemptId: number, payload: Record<string, unknown>) => void,
  ) {}

  async onAttemptSettled(task: BranchTask, run: BranchAttempt): Promise<void> {
    if (run.state === 'running' || task.isolationMode !== 'worktree' || run.branch == null || !isRetirableTask(task)) return;
    const retainedBranch = await this.git.symbolicBranch(task.workingDir);
    if (retainedBranch === null) return;
    const branch = run.branch;
    const outcome = await this.retireContained(task.workingDir, branch, retainedBranch);
    if (outcome === 'kept') return;
    if (outcome === 'retired') {
      this.recordLifecycle?.(run.id, { event: 'branch-deleted', branch, containedIn: retainedBranch });
    } else {
      this.recordLifecycle?.(run.id, { event: 'branch-delete-failed', branch, error: outcome.error });
    }
  }

  /** Backfill terminal Attempts' branches from prior Harmonic versions. */
  async reconcile(options?: YieldOptions): Promise<void> {
    await forEachYielding(await this.attempts.listAll(), async (attempt) => {
      if (attempt.state === 'running' || attempt.taskId === null) return;
      try {
        await this.onAttemptSettled(await this.tasks.get(attempt.taskId), attempt);
      } catch (err) {
        this.onError(`attempt ${attempt.id} branch retirement failed: ${String(err)}`);
      }
    }, options);
  }

  /** Retire an Epic integration branch only when it is safely contained. */
  async retireEpic(repoDir: string, branch: string, retainedBranch: string, onRetired: () => Promise<void>): Promise<void> {
    if ((await this.retireContained(repoDir, branch, retainedBranch)) === 'retired') await onRetired();
  }

  private async retireContained(repoDir: string, branch: string, retainedBranch: string): Promise<'retired' | 'kept' | { error: string }> {
    try {
      if (!(await this.git.branchExists(repoDir, branch))) return 'kept';
      if ((await this.git.branchCheckedOutAt(repoDir, branch)) !== null) return 'kept';
      if (!(await this.git.isContentContained(repoDir, retainedBranch, branch))) return 'kept';
      await this.git.deleteBranch(repoDir, branch);
      return 'retired';
    } catch (err) {
      this.onError(`branch '${branch}' retirement failed: ${String(err)}`);
      return { error: errorMessage(err) };
    }
  }
}

function isRetirableTask(task: BranchTask): boolean {
  if (task.state !== 'done' && task.state !== 'cancelled') return false;
  return task.origin === 'native' || task.trackerState === 'closed';
}
