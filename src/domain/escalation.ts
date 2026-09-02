import type { TaskRow, AttemptRow } from '../db/schema.js';
import { DomainError } from './errors.js';
import type { AttemptStore } from './attempts.js';
import type { TaskService } from './tasks.js';
import type { MergeEffectExec } from './merge.js';
import type { AttemptSettleCoordinator } from './attempt-settle.js';
import type { VerificationDecision } from '../verification/combine.js';

/**
 * The merge side effects Accept must apply for this Task/Attempt — a worktree
 * Task's merge and a mirrored Task's ticket close. Empty for a direct-mode
 * native Task (accept just settles terminal).
 */
export type MergeEffectsHook = (task: TaskRow, run: AttemptRow) => MergeEffectExec[];

export interface EscalationHooks {
  /** Resume the Attempt loop with the operator's guidance (Reject). Starts the
   * next Attempt immediately only when `startNow` is set; otherwise the
   * requeued Ticket waits for Auto-Runner capacity. */
  resume: (task: TaskRow, guidance: string, startNow: boolean) => Promise<void>;
  /** Remove the ticket branch and worktree, and close the tracker issue (Close). Best-effort. */
  cleanup: (task: TaskRow, run: AttemptRow | undefined) => Promise<void>;
  /** The candidate commit an Accept would merge, or null when the branch has no commits ahead of its base. */
  candidateHead: (task: TaskRow, run: AttemptRow) => Promise<string | null>;
  /** Run the configured verifiers against the candidate and fold their verdicts into one Verification decision. */
  verifyCandidate: (task: TaskRow, run: AttemptRow, head: string) => Promise<VerificationDecision>;
}

/**
 * The one human surface: an `escalated` ticket exposes exactly three actions.
 * Accept verifies the ticket's candidate — a pass merges it as-is and settles
 * the Attempt under `operator-accept`; a non-`proceed` verify re-enters the
 * Attempt loop with the verifier's reason as feedback, like Reject;
 * `{ force: true }` skips verification. Reject with guidance records the
 * guidance as feedback, resets the attempt budget, and requeues the ticket to
 * `ready`. Close cancels the ticket and cleans up. Nothing else moves a ticket
 * out of `escalated`.
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
   * Accept an escalated ticket: verify the candidate, then merge as-is on a
   * pass; a non-`proceed` decision re-enters the Attempt loop with the
   * verifier's reason as feedback (the ticket is NOT merged). `force` skips
   * verification entirely.
   */
  async accept(taskId: number, opts?: { force?: boolean }): Promise<TaskRow> {
    const { task, run } = await this.escalated(taskId);
    const head = run ? await this.hooks.candidateHead(task, run) : null;
    if (!run || !head) {
      throw new DomainError('conflict', `task ${taskId} has no candidate to accept; the branch has no commits ahead of its base`);
    }
    if (!opts?.force) {
      const decision = await this.hooks.verifyCandidate(task, run, head);
      if (decision.outcome !== 'proceed') {
        const feedback = `Operator Accept ran verification and it did not pass (${decision.outcome}): ${decision.reason}`;
        await this.hooks.resume(task, feedback, false);
        return await this.taskService.get(taskId);
      }
    }
    await this.attempts.update(run.id, { verifiedHeadOid: head });
    const merged = await this.attempts.get(run.id);
    for (const effect of this.mergeEffects(task, merged)) {
      const result = await effect.apply();
      if (!result.ok) throw new DomainError('conflict', result.detail ?? `${effect.effect} failed on accept`);
    }
    await this.settle.settle(task, merged, 'operator-accept', { runState: 'completed', taskAction: 'done', reason: null });
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
