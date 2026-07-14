import type { TaskRow, RunRow } from '../db/schema.js';
import { DomainError } from './errors.js';
import type { RunStore } from './runs.js';
import type { TaskService } from './tasks.js';

export interface AcceptOutcome {
  /** When false, the merge conflicted: the task stays awaiting-review. */
  ok: boolean;
  detail?: string;
}

export type AcceptHook = (task: TaskRow, run: RunRow) => Promise<AcceptOutcome>;

/**
 * The human review gate. Accept completes the task (and, in worktree
 * mode, merges the run's branch — via the accept hook, per ADR-0002).
 * Reject fails it with the reviewer's feedback stored on the run.
 */
export class ReviewService {
  constructor(
    private readonly runStore: RunStore,
    private readonly taskService: TaskService,
    private readonly acceptHook: AcceptHook = async () => ({ ok: true }),
  ) {}

  private reviewable(taskId: number): { task: TaskRow; run: RunRow } {
    const task = this.taskService.get(taskId);
    if (task.state !== 'awaiting-review') {
      throw new DomainError('invalid_state', `task ${taskId} is ${task.state}; only awaiting-review tasks can be reviewed`);
    }
    const run = this.runStore.listForTask(taskId).at(-1);
    if (!run) throw new DomainError('conflict', `task ${taskId} has no runs to review`);
    return { task, run };
  }

  async accept(taskId: number): Promise<TaskRow> {
    const { task, run } = this.reviewable(taskId);
    const outcome = await this.acceptHook(task, run);
    if (!outcome.ok) {
      // Merge conflict: surface it and leave the task in awaiting-review.
      this.runStore.update(run.id, { reviewFeedback: outcome.detail ?? 'merge conflict' });
      throw new DomainError('conflict', outcome.detail ?? 'merge conflict on accept');
    }
    this.runStore.update(run.id, { review: 'accepted', reviewedAt: Date.now() });
    return this.taskService.setState(taskId, 'completed');
  }

  reject(taskId: number, feedback?: string): TaskRow {
    const { run } = this.reviewable(taskId);
    this.runStore.update(run.id, {
      review: 'rejected',
      reviewFeedback: feedback ?? null,
      reviewedAt: Date.now(),
    });
    return this.taskService.setState(taskId, 'failed');
  }
}
