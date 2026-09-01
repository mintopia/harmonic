import type { TaskRow, AttemptRow } from '../db/schema.js';
import { DomainError } from './errors.js';
import type { AttemptStore } from './attempts.js';
import type { TaskService } from './tasks.js';
import type { MergeEffectExec } from './merge.js';
import type { AttemptSettleCoordinator } from './attempt-settle.js';
import type { VerificationDecision } from '../verification/combine.js';

/**
 * The merge side effects Accept must apply for this Task/Attempt, built
 * synchronously from what's already known about them (issue #115) — a worktree
 * Task's merge (`Runner.mergeAcceptedBranch`, ADR-0001) and a mirrored Task's
 * ticket close. Empty for a direct-mode native Task: "no effects -> straight
 * merge" (accept just settles terminal).
 */
export type MergeEffectsHook = (task: TaskRow, run: AttemptRow) => MergeEffectExec[];

export interface EscalationHooks {
  /** Resume the Attempt loop with the operator's guidance (Reject). Owns the
   * attempt bookkeeping and the requeue. Starts the next Attempt immediately
   * only when `startNow` is set (the warm-Session "start now" override,
   * ADR-0048); otherwise the requeued Ticket waits for Auto-Runner capacity. */
  resume: (task: TaskRow, guidance: string, startNow: boolean) => Promise<void>;
  /** Remove the ticket branch and worktree, and close the tracker issue (Close). Best-effort. */
  cleanup: (task: TaskRow, run: AttemptRow | undefined) => Promise<void>;
  /** The candidate commit an Accept would merge, or null when the branch has
   * no commits ahead of its base (issue #429). */
  candidateHead: (task: TaskRow, run: AttemptRow) => Promise<string | null>;
  /** Run the configured verifiers against the candidate, with a freshly
   * refreshed code index (issue #429), and fold their verdicts into one
   * Verification decision. */
  verifyCandidate: (task: TaskRow, run: AttemptRow, head: string) => Promise<VerificationDecision>;
}

/**
 * ADR-0041's one human surface: an `escalated` ticket exposes exactly three
 * actions. Accept verifies the ticket's candidate (issue #429) — a pass merges
 * it as-is through the one merge policy (ADR-0001), the same primitive the
 * automated path drives, under the base repo mutex — and settles the Attempt
 * under `operator-accept` (`AttemptSettleCoordinator.settle`), the one
 * disposition the coordinator lets override an already-`escalated`
 * Attempt/Run, so the success path continues: merge, close the ticket, clean
 * up. A non-`proceed` verify re-enters the Attempt loop with the verifier's
 * reason as feedback, exactly like Reject; `{ force: true }` skips
 * verification and merges as-is. Reject with guidance records the guidance as feedback,
 * resets the attempt budget, and requeues the ticket to `ready` (ADR-0048):
 * the loop resumes by Auto-Runner capacity, or at once when the caller passes
 * `startNow` (the warm-Session "start now" override). Close cancels the ticket
 * and cleans up. Nothing else moves a ticket out of `escalated`.
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
   * Accept an escalated ticket (issue #429): Accept now verifies the
   * candidate itself rather than requiring a prior `verifiedHeadOid` — a
   * guardrail/infra escalation (e.g. tasks 410/411) has a committed candidate
   * but never reached verification. A pass merges as-is; a non-`proceed`
   * decision re-enters the Attempt loop with the verifier's reason as
   * feedback, exactly like Reject (the ticket is NOT merged). `force` skips
   * verification entirely and merges the candidate as-is — the prior
   * behaviour, for when the operator has already judged it independently.
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
    // Merge as-is (force, or a passing verify): persist the candidate as the
    // head to merge so the `target-ref` effect (which reads `verifiedHeadOid`)
    // can run — a `force` Accept records the operator's own judgement in place
    // of a verifier's.
    await this.attempts.update(run.id, { verifiedHeadOid: head });
    const merged = await this.attempts.get(run.id);
    // The one merge policy, everywhere (ADR-0001): the `target-ref` effect runs
    // `Runner.mergeAcceptedBranch` (mutex + `git merge --no-ff` + post-merge
    // check + revert-on-red), then `ticket-close` mirrors a mirrored Task's
    // tracker issue. Effects run in order, fail-fast — a failed one (merge
    // conflict, ticket close) leaves the ticket escalated with nothing further
    // applied; its detail is the operator's cue.
    for (const effect of this.mergeEffects(task, merged)) {
      const result = await effect.apply();
      if (!result.ok) throw new DomainError('conflict', result.detail ?? `${effect.effect} failed on accept`);
    }
    // All effects ok: settle the Run under `operator-accept` — the same
    // close-out (tracker mirror, worktree/session retirement) every merge path
    // shares, and the disposition that outranks the retained `escalate` fact.
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
