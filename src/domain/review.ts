import type { TaskRow, RunRow } from '../db/schema.js';
import { DomainError } from './errors.js';
import type { RunStore } from './runs.js';
import type { TaskService } from './tasks.js';
import type { RunSettleCoordinator } from './run-settle.js';
import type { LandingCoordinator, LandingEffectExec } from './landing-coordinator.js';

export interface AcceptOutcome {
  /** When false, the merge conflicted: the task stays awaiting-review. */
  ok: boolean;
  detail?: string;
}

export type AcceptHook = (task: TaskRow, run: RunRow) => Promise<AcceptOutcome>;

/**
 * The landing side effects Accept must apply for this Task/Run, built
 * synchronously from what's already known about them (issue #115) — e.g. a
 * worktree Task's merge, identified for idempotency by its base/run branch
 * pair (stable for the Run's whole lifetime, known before the merge ever
 * runs). Empty for a non-worktree Task: "no effects -> straight land"
 * (`LandingCoordinator.land` with `effects: []` just settles terminal).
 */
export type LandingEffectsHook = (task: TaskRow, run: RunRow) => LandingEffectExec[];

/**
 * The human review gate. Accept lands the run (and, in worktree mode, merges the
 * run's branch — via the journaled `LandingCoordinator`, per ADR-0002 and issue
 * #115) and completes the task; Reject fails it with the reviewer's feedback
 * stored on the run.
 *
 * With the phase machine (issue #114) a native Run does NOT settle at
 * agent-finish: it parks **non-terminal** in `phase:'review'` while its Task sits
 * in `awaiting-review` (its Work Context lease was released at review entry —
 * holding it across the review window awaits #122's phase-specific lease TTLs).
 * Accept/reject are therefore the second settle authority — they land or fail
 * that parked Run, and they do it through the shared {@link RunSettleCoordinator}
 * (Accept via {@link LandingCoordinator}, which owns the journaled non-
 * interruptible landing operation — PONC-freezes the disposition before its
 * first irreversible effect, then settles through the same coordinator) so the
 * terminal disposition is race-safe against a concurrent operator cancel (which
 * outranks both, UNLESS it arrives after the PONC — see landing.ts's module doc
 * comment). A pre-#114 Run that was already settled `completed` at agent-finish
 * (state !== 'running') keeps its old direct-transition path via `acceptHook` —
 * it has already terminaled, so there is no live disposition race left for the
 * journal/PONC to protect, and the coordinator would idempotently no-op such a
 * Run anyway, so its Task would never move.
 */
export class ReviewService {
  constructor(
    private readonly runStore: RunStore,
    private readonly taskService: TaskService,
    private readonly settle: RunSettleCoordinator,
    private readonly landing: LandingCoordinator,
    private readonly acceptHook: AcceptHook = async () => ({ ok: true }),
    private readonly landingEffects: LandingEffectsHook = () => [],
  ) {}

  private async reviewable(taskId: number): Promise<{ task: TaskRow; run: RunRow }> {
    const task = await this.taskService.get(taskId);
    if (task.state !== 'awaiting-review') {
      throw new DomainError('invalid_state', `task ${taskId} is ${task.state}; only awaiting-review tasks can be reviewed`);
    }
    const run = (await this.runStore.listForTask(taskId)).at(-1);
    if (!run) throw new DomainError('conflict', `task ${taskId} has no runs to review`);
    return { task, run };
  }

  async accept(taskId: number): Promise<TaskRow> {
    const { task, run } = await this.reviewable(taskId);
    if (run.state === 'running') {
      // #114-era parked Run: land it through the journaled, PONC-guarded
      // coordinator (issue #115). `land` itself records the `review →
      // landing` phase transition (§0.2: "landing happens after Accept"),
      // journals/applies each effect (the worktree merge, if any) in order,
      // and — only once every effect succeeds — settles `completed` through
      // the shared `RunSettleCoordinator`, with the review decoration riding
      // that winning write exactly as it did before #115.
      const outcome = await this.landing.land(
        task,
        run,
        { runState: 'completed', taskAction: 'completed', reason: null },
        this.landingEffects(task, run),
        { review: 'accepted', reviewedAt: Date.now(), reviewDeadline: null },
        // Explicit operator disposition (issue #191): outranks a retained
        // `escalate` fact on an adopted-for-review Run's log
        // (`DISPOSITION_PRECEDENCE`), so an adopt→accept lands AND completes
        // instead of the land succeeding while the bookkeeping replays back
        // to escalated. Identical behaviour on a native-parked Run (no
        // escalate in its log to outrank).
        'operator-accept',
      );
      if (!outcome.ok) {
        // Merge conflict (or any other effect failure): surface it and leave
        // the task in awaiting-review — identical to the pre-#115 behaviour,
        // now driven by the effect loop instead of a single accept hook call.
        await this.runStore.update(run.id, { reviewFeedback: outcome.detail ?? 'merge conflict' });
        throw new DomainError('conflict', outcome.detail ?? 'merge conflict on accept');
      }
      return await this.taskService.get(taskId);
    }
    // Legacy Run already settled `completed` at agent-finish (pre-#114): the
    // accept hook (the merge) IS the landing, run directly — no live
    // disposition race is left for the journal/PONC to protect (see class
    // doc comment).
    const outcome = await this.acceptHook(task, run);
    if (!outcome.ok) {
      await this.runStore.update(run.id, { reviewFeedback: outcome.detail ?? 'merge conflict' });
      throw new DomainError('conflict', outcome.detail ?? 'merge conflict on accept');
    }
    await this.runStore.update(run.id, { review: 'accepted', reviewedAt: Date.now() });
    return await this.taskService.setState(taskId, 'completed');
  }

  async reject(taskId: number, feedback?: string): Promise<TaskRow> {
    const { task, run } = await this.reviewable(taskId);
    const reason = feedback ? `rejected: ${feedback}` : 'rejected';
    if (run.state === 'running') {
      // #114-era parked Run: settle it `failed` (the work was rejected) through
      // the coordinator; the Task moves to `failed`.
      await this.settle.settle(
        task,
        run,
        'failed',
        { runState: 'failed', taskAction: 'failed', reason },
        { review: 'rejected', reviewFeedback: feedback ?? null, reviewedAt: Date.now(), reviewDeadline: null },
      );
      return await this.taskService.get(taskId);
    }
    // Legacy Run already settled at agent-finish (pre-#114).
    await this.runStore.update(run.id, { review: 'rejected', reviewFeedback: feedback ?? null, reviewedAt: Date.now() });
    return await this.taskService.setState(taskId, 'failed');
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
  async sweepExpiredReviews(now: number = Date.now()): Promise<number> {
    let swept = 0;
    for (const run of await this.runStore.listReviewParkedOverdue(now)) {
      const task = await this.taskService.get(run.taskId);
      if (task.state !== 'awaiting-review') continue;
      await this.settle.settle(task, run, 'review-sla-expiry', {
        runState: 'failed',
        taskAction: 'failed',
        reason: 'review SLA expired (unreviewed)',
      });
      swept++;
    }
    return swept;
  }
}
