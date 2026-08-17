import type { TaskRow, RunRow } from '../db/schema.js';
import { DomainError } from './errors.js';
import type { RunStore } from './runs.js';
import type { TaskService } from './tasks.js';
import type { RunSettleCoordinator } from './run-settle.js';

export interface AcceptOutcome {
  /** When false, the merge conflicted: the task stays awaiting-review. */
  ok: boolean;
  detail?: string;
}

export type AcceptHook = (task: TaskRow, run: RunRow) => Promise<AcceptOutcome>;

/**
 * The human review gate. Accept lands the run (and, in worktree mode, merges the
 * run's branch — via the accept hook, per ADR-0002) and completes the task;
 * Reject fails it with the reviewer's feedback stored on the run.
 *
 * With the phase machine (issue #114) a native Run does NOT settle at
 * agent-finish: it parks **non-terminal** in `phase:'review'` while its Task sits
 * in `awaiting-review` (its Work Context lease was released at review entry —
 * holding it across the review window awaits #122's phase-specific lease TTLs).
 * Accept/reject are therefore the second settle authority — they land or fail
 * that parked Run, and they do it through the shared {@link RunSettleCoordinator}
 * so the terminal disposition is race-safe against a concurrent operator cancel
 * (which outranks both). A pre-#114 Run that was already settled `completed` at
 * agent-finish (state !== 'running') keeps its old direct-transition path — the
 * coordinator would idempotently no-op such a Run, so its Task would never move.
 */
export class ReviewService {
  constructor(
    private readonly runStore: RunStore,
    private readonly taskService: TaskService,
    private readonly settle: RunSettleCoordinator,
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
    if (run.state === 'running') {
      // #114-era parked Run. The accept hook (the merge) IS the landing, so record
      // the `review → landing` transition now (§0.2: "landing happens after
      // Accept") — persisted + reconstructable like every other phase — before
      // the coordinator settles it terminal.
      this.runStore.update(run.id, { phase: 'landing' });
      this.runStore.appendEvent(run.id, { type: 'lifecycle', payload: { event: 'phase', phase: 'landing' } });
      // Settle it `completed` through the coordinator (Run completed, phase →
      // terminal, lease released, Task → completed), with the review decoration
      // riding the winning write so a straggler cancel that already won leaves it
      // untouched.
      this.settle.settle(
        task,
        run,
        'agent-finish/unresolved',
        { runState: 'completed', taskAction: 'completed', reason: null },
        { review: 'accepted', reviewedAt: Date.now(), reviewDeadline: null },
      );
      return this.taskService.get(taskId);
    }
    // Legacy Run already settled `completed` at agent-finish (pre-#114).
    this.runStore.update(run.id, { review: 'accepted', reviewedAt: Date.now() });
    return this.taskService.setState(taskId, 'completed');
  }

  reject(taskId: number, feedback?: string): TaskRow {
    const { task, run } = this.reviewable(taskId);
    const reason = feedback ? `rejected: ${feedback}` : 'rejected';
    if (run.state === 'running') {
      // #114-era parked Run: settle it `failed` (the work was rejected) through
      // the coordinator; the Task moves to `failed`.
      this.settle.settle(
        task,
        run,
        'failed',
        { runState: 'failed', taskAction: 'failed', reason },
        { review: 'rejected', reviewFeedback: feedback ?? null, reviewedAt: Date.now(), reviewDeadline: null },
      );
      return this.taskService.get(taskId);
    }
    // Legacy Run already settled at agent-finish (pre-#114).
    this.runStore.update(run.id, { review: 'rejected', reviewFeedback: feedback ?? null, reviewedAt: Date.now() });
    return this.taskService.setState(taskId, 'failed');
  }

  /**
   * Review-SLA sweep (issue #114, reliability-design round-5 #4): settle every
   * Run parked in `phase:'review'` whose `reviewDeadline` has lapsed as of `now`
   * to an explicit terminal disposition via a `review-sla-expiry` `run_fact`
   * (Run failed, Task failed, lease released) — so an abandoned review can never
   * wedge a Work Context lease forever. Returns how many Runs it swept. Run at
   * boot reconciliation and safe to call repeatedly; a Task no longer in
   * `awaiting-review` (a race already moved it) is skipped.
   */
  sweepExpiredReviews(now: number = Date.now()): number {
    let swept = 0;
    for (const run of this.runStore.listReviewParkedOverdue(now)) {
      const task = this.taskService.get(run.taskId);
      if (task.state !== 'awaiting-review') continue;
      this.settle.settle(task, run, 'review-sla-expiry', {
        runState: 'failed',
        taskAction: 'failed',
        reason: 'review SLA expired (unreviewed)',
      });
      swept++;
    }
    return swept;
  }
}
