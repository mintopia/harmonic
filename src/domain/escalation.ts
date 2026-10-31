import type { TaskRow, AttemptRow } from '../db/schema.js';
import { DomainError } from './errors.js';
import type { AttemptStore } from './attempts.js';
import type { TaskService, UpdateTaskInput } from './tasks.js';
import { withTaskLock } from './task-lock.js';

export interface RetryInput {
  guidance: string;
  startNow?: boolean | undefined;
  reuseSession?: boolean | undefined;
  harness?: NonNullable<UpdateTaskInput['harness']> | undefined;
  model?: string | undefined;
}

export interface EscalationHooks {
  resume: (task: TaskRow, guidance: string, options: { startNow: boolean; reuseSession: boolean }) => Promise<void>;
  /** Remove the ticket branch and worktree, and close the tracker issue (Close). Best-effort. */
  cleanup: (task: TaskRow, run: AttemptRow | undefined) => Promise<void>;
  /** The candidate commit an Accept would merge, or null when the branch has no commits ahead of its base. */
  candidateHead: (task: TaskRow, run: AttemptRow) => Promise<string | null>;
  acceptWorkflow: (task: TaskRow, run: AttemptRow) => Promise<void>;
}

/**
 * The one human surface: an `escalated` ticket exposes three actions. Accept is
 * the operator's judgement that the failed workflow step is fine: it overrides
 * that step and resumes the workflow after it (ADR-0038). Retry optionally
 * records guidance as feedback, resets the attempt budget, and requeues the
 * ticket to `ready` (or starts the next Attempt immediately).
 * Close cancels the ticket and cleans up. Nothing else moves a ticket out of
 * `escalated`.
 */
export class EscalationService {
  constructor(
    private readonly attempts: AttemptStore,
    private readonly taskService: TaskService,
    private readonly hooks: EscalationHooks,
  ) {}

  private async escalated(taskId: number): Promise<{ task: TaskRow; run: AttemptRow | undefined }> {
    const task = await this.taskService.get(taskId);
    if (task.state !== 'escalated') {
      throw new DomainError('invalid_state', `task ${taskId} is ${task.state}; only escalated tasks take this action`);
    }
    return { task, run: (await this.attempts.listForTask(taskId)).at(-1) };
  }

  /** Accept needs a candidate: the branch must have committed something ahead of its base. */
  async accept(taskId: number): Promise<TaskRow> {
    return withTaskLock(taskId, async () => {
      const { task, run } = await this.escalated(taskId);
      const head = run ? await this.hooks.candidateHead(task, run) : null;
      if (!run || !head) {
        throw new DomainError('conflict', `task ${taskId} has no candidate to accept; the branch has no commits ahead of its base`);
      }
      await this.hooks.acceptWorkflow(task, run);
      return await this.taskService.get(taskId);
    });
  }

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
