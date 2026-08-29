import type { TaskRow, RunRow } from '../db/schema.js';
import { DomainError } from './errors.js';
import type { RunStore } from './runs.js';
import type { TaskService } from './tasks.js';
import type { MergeEffectExec } from './merge-coordinator.js';
import type { RunSettleCoordinator } from './run-settle.js';

/**
 * The merge side effects Accept must apply for this Task/Run, built
 * synchronously from what's already known about them (issue #115) — a worktree
 * Task's merge (`Runner.mergeAcceptedBranch`, ADR-0001) and a mirrored Task's
 * ticket close. Empty for a direct-mode native Task: "no effects -> straight
 * merge" (accept just settles terminal).
 */
export type MergeEffectsHook = (task: TaskRow, run: RunRow) => MergeEffectExec[];

export interface EscalationHooks {
  /** Resume the Attempt loop with the operator's guidance (Reject). Owns the
   * attempt bookkeeping and the requeue. Starts the next Attempt immediately
   * only when `startNow` is set (the warm-Session "start now" override,
   * ADR-0048); otherwise the requeued Ticket waits for Auto-Runner capacity. */
  resume: (task: TaskRow, guidance: string, startNow: boolean) => Promise<void>;
  /** Remove the ticket branch and worktree, and close the tracker issue (Close). Best-effort. */
  cleanup: (task: TaskRow, run: RunRow | undefined) => Promise<void>;
}

/**
 * ADR-0041's one human surface: an `escalated` ticket exposes exactly three
 * actions. Accept merges the verified branch head as-is through the one merge
 * policy (ADR-0001, #383/#388) — the same primitive the automated path drives,
 * under the base repo mutex — and settles the Run under `operator-accept`
 * (`RunSettleCoordinator.settle`), which outranks the retained `escalate` fact
 * (`DISPOSITION_PRECEDENCE`) so the success path continues: merge, close the
 * ticket, clean up. Reject with guidance records the guidance as feedback,
 * resets the attempt budget, and requeues the ticket to `ready` (ADR-0048):
 * the loop resumes by Auto-Runner capacity, or at once when the caller passes
 * `startNow` (the warm-Session "start now" override). Close cancels the ticket
 * and cleans up. Nothing else moves a ticket out of `escalated`.
 */
export class EscalationService {
  constructor(
    private readonly runStore: RunStore,
    private readonly taskService: TaskService,
    private readonly settle: RunSettleCoordinator,
    private readonly mergeEffects: MergeEffectsHook,
    private readonly hooks: EscalationHooks,
  ) {}

  private async escalated(taskId: number): Promise<{ task: TaskRow; run: RunRow | undefined }> {
    const task = await this.taskService.get(taskId);
    if (task.state !== 'escalated') {
      throw new DomainError('invalid_state', `task ${taskId} is ${task.state}; only escalated tasks take this action`);
    }
    return { task, run: (await this.runStore.listForTask(taskId)).at(-1) };
  }

  async accept(taskId: number): Promise<TaskRow> {
    const { task, run } = await this.escalated(taskId);
    if (!run || run.candidateOid == null) {
      throw new DomainError('conflict', `task ${taskId} has no verified branch head to accept`);
    }
    // The one merge policy, everywhere (ADR-0001): the `target-ref` effect runs
    // `Runner.mergeAcceptedBranch` (mutex + `git merge --no-ff` + post-merge
    // check + revert-on-red), then `ticket-close` mirrors a mirrored Task's
    // tracker issue. Effects run in order, fail-fast — a failed one (merge
    // conflict, ticket close) leaves the ticket escalated with nothing further
    // applied; its detail is the operator's cue.
    for (const effect of this.mergeEffects(task, run)) {
      const result = await effect.apply();
      if (!result.ok) throw new DomainError('conflict', result.detail ?? `${effect.effect} failed on accept`);
    }
    // All effects ok: settle the Run under `operator-accept` — the same
    // close-out (tracker mirror, worktree/session retirement) every merge path
    // shares, and the disposition that outranks the retained `escalate` fact.
    await this.settle.settle(task, run, 'operator-accept', { runState: 'completed', taskAction: 'done', reason: null });
    return await this.taskService.get(taskId);
  }

  async reject(taskId: number, guidance: string, startNow = false): Promise<TaskRow> {
    const trimmed = guidance.trim();
    if (!trimmed) throw new DomainError('validation', 'guidance is required to reject an escalated task');
    const { task } = await this.escalated(taskId);
    await this.hooks.resume(task, trimmed, startNow);
    return await this.taskService.get(taskId);
  }

  async close(taskId: number): Promise<TaskRow> {
    const { task, run } = await this.escalated(taskId);
    const closed = await this.taskService.cancel(taskId);
    await this.hooks.cleanup(task, run);
    return closed;
  }
}
