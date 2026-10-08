import type { TaskRow, AttemptRow, StepRow } from '../db/schema.js';
import { DomainError } from './errors.js';
import type { AttemptStore } from './attempts.js';
import type { TaskService, UpdateTaskInput } from './tasks.js';
import type { MergeEffectExec } from './merge.js';
import type { AttemptSettleCoordinator } from './attempt-settle.js';
import { withTaskLock } from './task-lock.js';
import { logger } from '../logger.js';
import { errorMessage } from '../error-handling.js';

/**
 * The merge side effects Accept must apply for this Task/Attempt — a worktree
 * Task's merge and a mirrored Task's ticket close. Empty for a direct-mode
 * native Task (accept just settles terminal).
 */
export type MergeEffectsHook = (task: TaskRow, run: AttemptRow) => MergeEffectExec[];

export interface RetryInput {
  guidance: string;
  startNow?: boolean | undefined;
  reuseSession?: boolean | undefined;
  harness?: NonNullable<UpdateTaskInput['harness']> | undefined;
  model?: string | undefined;
}

export interface EscalationHooks {
  /** Resume the Attempt loop with the operator's guidance (Retry). Starts the
   * next Attempt immediately only when `startNow` is set; otherwise the
   * requeued Ticket waits for Auto-Runner capacity. `reuseSession` binds the
   * prior Session (warm or cold); without it a started Attempt gets a fresh one. */
  resume: (task: TaskRow, guidance: string, options: { startNow: boolean; reuseSession: boolean }) => Promise<void>;
  /** Remove the ticket branch and worktree, and close the tracker issue (Close). Best-effort. */
  cleanup: (task: TaskRow, run: AttemptRow | undefined) => Promise<void>;
  /** The candidate commit an Accept would merge, or null when the branch has no commits ahead of its base. */
  candidateHead: (task: TaskRow, run: AttemptRow) => Promise<string | null>;
  /** Accept step-advance (ADR-0038): `failedStep` is already `failed` at `rebase`,
   * `implementation`, or `verification` (never the final `review` Step, which
   * `accept` merges directly). Overrides it and resumes the pipeline at the
   * next Step on the same Attempt, merging and settling `done` on an eventual
   * pass or escalating again on a later failure. */
  advance: (task: TaskRow, run: AttemptRow, failedStep: StepRow) => Promise<void>;
}

/**
 * The one human surface: an `escalated` ticket exposes three actions. Accept is
 * the operator's judgement that a specific failed Step is fine: at the final
 * `review` Step this merges the candidate as-is and settles the Attempt under
 * `operator-accept` with no further verification; at an earlier Step it
 * overrides that Step and resumes the remaining pipeline (ADR-0038). Retry
 * optionally records guidance as feedback, resets the attempt budget, and
 * requeues the ticket to `ready` (or starts the next Attempt immediately).
 * Close cancels the ticket and cleans up. Nothing else moves a ticket out of
 * `escalated`.
 */
export class EscalationService {
  constructor(
    private readonly attempts: AttemptStore,
    private readonly taskService: TaskService,
    private readonly settle: AttemptSettleCoordinator,
    private readonly mergeEffects: MergeEffectsHook,
    private readonly hooks: EscalationHooks,
  ) {}

  private async escalated(taskId: number): Promise<{ task: TaskRow; run: AttemptRow | undefined }> {
    const task = await this.taskService.get(taskId);
    if (task.state !== 'escalated') {
      throw new DomainError('invalid_state', `task ${taskId} is ${task.state}; only escalated tasks take this action`);
    }
    return { task, run: (await this.attempts.listForTask(taskId)).at(-1) };
  }

  /**
   * Accept an escalated ticket. Requires a candidate — the branch's Attempt
   * must have committed something ahead of its base, same guard as before this
   * ADR — since there's nothing for either Accept behaviour to act on
   * otherwise. Given a candidate, the last `failed` Step on the escalated
   * Attempt decides what Accept does: at `review` (or when no Step is tracked
   * at all — a pre-ADR-0038 escalation with no candidate Step to override),
   * merge the candidate as-is and settle under `operator-accept`, unchanged
   * from before this ADR. At an earlier Step, override it and resume the
   * pipeline (ADR-0038); no verification re-runs for the overridden Step
   * itself — the operator's Accept *is* its judgement.
   */
  async accept(taskId: number): Promise<TaskRow> {
    // Hold the Task across the whole merge→settle span (ADR-0020): a slow
    // conflict-resolving merge must not let a racing requeue transition the
    // Task underneath it and strand a merged branch behind an open ticket.
    return withTaskLock(taskId, async () => {
      const { task, run } = await this.escalated(taskId);
      const head = run ? await this.hooks.candidateHead(task, run) : null;
      if (!run || !head) {
        throw new DomainError('conflict', `task ${taskId} has no candidate to accept; the branch has no commits ahead of its base`);
      }
      const steps = await this.attempts.listSteps(run.id);
      const failedStep = [...steps].reverse().find((step) => step.state === 'failed');
      if (failedStep && failedStep.type !== 'review') {
        await this.hooks.advance(task, run, failedStep);
        return await this.taskService.get(taskId);
      }
      await this.attempts.update(run.id, { verifiedHeadOid: head });
      const merged = await this.attempts.get(run.id);
      await this.taskService.setMergeStatus(task.id, 'merging');
      for (const effect of this.mergeEffects(task, merged)) {
        let result: Awaited<ReturnType<typeof effect.apply>>;
        try {
          result = await effect.apply();
        } catch (err) {
          await this.taskService.setMergeStatus(task.id, null);
          logger.error(`accept: ${effect.effect} failed on task ${taskId}; it stays escalated`, { taskId, effect: effect.effect, error: errorMessage(err) });
          throw new DomainError('conflict', `${effect.effect} failed on accept; the ticket stays escalated`);
        }
        if (!result.ok) {
          await this.taskService.setMergeStatus(task.id, result.observed?.reason === 'conflict' ? 'resolving-conflicts' : null);
          throw new DomainError('conflict', result.detail ?? `${effect.effect} failed on accept`);
        }
      }
      await this.settle.settle(task, merged, 'operator-accept', { runState: 'completed', taskAction: 'done', reason: null });
      return await this.taskService.get(taskId);
    });
  }

  /**
   * Retry an escalated ticket, optionally on a different Harness/Model. A route
   * change is saved as both operator fields on the Ticket, so it outranks the
   * Routing Label (ADR-0049). Re-using the Session needs `startNow` and the same
   * Harness: a Session cannot cross Harnesses.
   */
  async retry(taskId: number, input: RetryInput): Promise<TaskRow> {
    const guidance = input.guidance.trim();
    const startNow = input.startNow ?? false;
    const reuseSession = input.reuseSession ?? false;
    const { task } = await this.escalated(taskId);
    if (reuseSession && !startNow) {
      throw new DomainError('validation', 'reuseSession needs startNow: only an immediate retry can re-use the Session');
    }
    if (reuseSession && input.harness !== undefined && input.harness !== task.harness) {
      throw new DomainError('validation', `Harness ${input.harness} differs from ${task.harness}: a different Harness needs a new Session`);
    }
    let current = task;
    if (input.harness !== undefined || input.model !== undefined) {
      current = await this.taskService.update(taskId, { harness: input.harness ?? (task.harness as UpdateTaskInput['harness']), model: input.model ?? task.model });
    }
    await this.hooks.resume(current, guidance, { startNow, reuseSession });
    return await this.taskService.get(taskId);
  }

  async close(taskId: number): Promise<TaskRow> {
    const { task, run } = await this.escalated(taskId);
    const closed = await this.taskService.cancel(taskId);
    await this.hooks.cleanup(task, run);
    return closed;
  }
}
