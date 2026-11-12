import { isEpicAttempt, isTaskAttempt, type EpicAttemptRow, type TaskAttemptRow } from '../db/schema.js';
import type { AttemptStore } from '../domain/attempts.js';
import type { WorkflowStepRunStore } from '../domain/workflow-step-runs.js';
import type { TaskService } from '../domain/tasks.js';
import { forEachYielding, type YieldOptions } from '../reliability/yield.js';
import { startOperation } from '../telemetry/operations.js';
import { logger } from '../logger.js';
import type { TaskArchive } from '../archive/task-archive.js';

/**
 * Boot-time crash recovery, run once before anything can execute. A
 * `working`/`escalated` Task whose latest Attempt already `passed` is completed
 * to `done`; whatever is still `running` after that is marked `interrupted`
 * and its workflow resumes.
 */
export class CrashRecoveryCoordinator {
  constructor(
    private readonly attempts: AttemptStore,
    private readonly taskService: TaskService,
    private readonly deps: {
      /** Reconcile an interrupted whole-Epic Attempt after boot. The next Epic
       * poll owns retrying its verification; this hook restores its live read model. */
      onEpicAttemptInterrupted?: (attempt: EpicAttemptRow) => Promise<void> | void;
      yieldOptions?: YieldOptions;
      archive?: TaskArchive;
      stepRuns?: Pick<WorkflowStepRunStore, 'closeOrphans'>;
      sessionTranscriptPath?: (sessionRowId: number) => Promise<string | null>;
    },
  ) {}

  async reconcile(): Promise<void> {
    const operation = startOperation({ type: 'startup.crash-reconcile', attributes: {} });
    try {
      await operation.run(() => this.reconcileInterrupted());
      operation.end();
    } catch (error) {
      operation.fail(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  private async reconcileInterrupted(): Promise<void> {
    await this.reconcileMergedButUnsettled();
    const interrupted = await this.attempts.markInterrupted();
    await this.deps.stepRuns?.closeOrphans();
    await forEachYielding(
      interrupted.filter(isEpicAttempt),
      async (attempt) => { await this.deps.onEpicAttemptInterrupted?.(attempt); },
      this.deps.yieldOptions,
    );
    await this.archiveInterruptedTranscripts(interrupted.filter(isTaskAttempt));
  }

  private async archiveInterruptedTranscripts(orphans: TaskAttemptRow[]): Promise<void> {
    const { archive } = this.deps;
    if (!archive) return;
    await forEachYielding(
      orphans,
      async (attempt) => {
        try {
          const task = await this.taskService.get(attempt.taskId);
          const path = attempt.sessionRowId != null ? (await this.deps.sessionTranscriptPath?.(attempt.sessionRowId)) ?? null : null;
          await archive.copyNative(task, attempt.number, task.harness, path);
        } catch (error) {
          logger.warn('crash-recovery: archive native transcript failed', { attemptId: attempt.id, error: error instanceof Error ? error.message : String(error) });
        }
      },
      this.deps.yieldOptions,
    );
  }

  private async reconcileMergedButUnsettled(): Promise<void> {
    // `ready` included: an accepted Attempt (`passed`) whose Task reads `ready`
    // is the accept-merge racing the verify/requeue loop — the loop requeued the
    // Task after its merge settled the Attempt but before the Task reached
    // `done`, leaving a merged branch behind an open ticket. An Attempt only
    // reaches `passed` once its merge-effects succeed, so `passed` already proves
    // the merge; completing the Task is the truthful reconciliation.
    for (const state of ['working', 'escalated', 'ready'] as const) {
      for (const task of await this.taskService.list({ state })) {
        const latest = (await this.attempts.listForTask(task.id)).at(-1);
        if (latest?.state === 'passed') await this.taskService.setState(task.id, 'done');
      }
    }
  }
}
