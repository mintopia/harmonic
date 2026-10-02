import { isEpicAttempt, isTaskAttempt, type AttemptRow, type EpicAttemptRow, type TaskAttemptRow, type TaskRow } from '../db/schema.js';
import type { AttemptStore } from '../domain/attempts.js';
import type { TaskService } from '../domain/tasks.js';
import type { AttemptSettleCoordinator } from '../domain/attempt-settle.js';
import { Git } from './git.js';
import { withBaseCheckoutLock, withRepoLock } from './repo-lock.js';
import { withEphemeralMergeWorktree } from './ephemeral-merge-worktree.js';
import { captureDirtyPaths, syncBaseCheckout } from './base-checkout-sync.js';
import type { PostMergeCheckResult } from './merge-policy.js';
import type { PostMergeHook } from './branch-merge.js';
import { forEachYielding, type YieldOptions } from '../reliability/yield.js';
import { startOperation } from '../telemetry/operations.js';
import type { ProcessGroupJournal } from './process-groups.js';
import { logger } from '../logger.js';
import type { TaskArchive } from '../archive/task-archive.js';

/**
 * Boot-time crash recovery, run once before anything can execute. A
 * worktree-mode Attempt still `running` whose branch already merged into its
 * base gets its post-merge check re-run (reverted on red) instead of being
 * blindly failed; a `working`/`escalated` Task whose latest Attempt already
 * `passed` is completed to `done`; whatever is still `running` after that is
 * marked `interrupted`. Idempotent: a second boot re-selects nothing.
 */
export class CrashRecoveryCoordinator {
  constructor(
    private readonly attempts: AttemptStore,
    private readonly taskService: TaskService,
    private readonly settle: AttemptSettleCoordinator,
    private readonly deps: {
      /** Run the deterministic verify commands once against a merge that already happened. */
      runPostMergeCheck: (args: { task: TaskRow; run: AttemptRow; mergeOid: string; baseDir: string }) => Promise<PostMergeCheckResult>;
      /** Whether `branch` is already merged into `baseBranch`. Defaults to `Git.isAncestor`. */
      isMerged?: (dir: string, baseBranch: string, branch: string) => Promise<boolean>;
      /** Best-effort notification after a recovered merge is confirmed green. */
      postMerge?: PostMergeHook;
      /** Reconcile an interrupted whole-Epic Attempt after boot. The next Epic
       * poll owns retrying its verification; this hook restores its live read model. */
      onEpicAttemptInterrupted?: (attempt: EpicAttemptRow) => Promise<void> | void;
      yieldOptions?: YieldOptions;
      /** Absent ⇒ no orphan process groups are reaped. */
      processGroups?: Pick<ProcessGroupJournal, 'reapOrphans'>;
      archive?: TaskArchive;
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
    await this.reconcileMergeOrphans();
    await this.reconcileMergedButUnsettled();
    await this.deps.processGroups?.reapOrphans(this.deps.yieldOptions);
    const interrupted = await this.attempts.markInterrupted();
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

  private async reconcileMergeOrphans(): Promise<void> {
    const running = await this.attempts.listAllRunning();
    const candidates = running.filter(isTaskAttempt).filter((run) => run.branch !== null && run.baseBranch !== null);
    await forEachYielding(
      candidates,
      async (run) => {
        const task = await this.taskService.get(run.taskId);
        if (task.isolationMode !== 'worktree') return;

        const isMerged = this.deps.isMerged ?? Git.isAncestor;
        const merged = await isMerged(task.workingDir, run.baseBranch!, run.branch!);
        if (!merged) return;

        const taskMergeOid = await Git.taskMergeCommit(task.workingDir, run.baseBranch!, run.branch!);
        if (!taskMergeOid) return;

        await withBaseCheckoutLock(task.workingDir, () =>
          withRepoLock(task.workingDir, async () => {
            const repoDir = task.workingDir;
            const baseBranch = run.baseBranch!;
            const mergeOid = await Git.revParse(repoDir, baseBranch);
            const hasDependentCommitAfterMerge = mergeOid !== taskMergeOid;
            if (hasDependentCommitAfterMerge) {
              await this.settleMerged(task, run);
              return;
            }
            const verdict = await withEphemeralMergeWorktree({ repoDir, baseTipOid: mergeOid }, async (adminPath) => {
              const check = await this.deps.runPostMergeCheck({ task, run, mergeOid, baseDir: adminPath });
              if (check.pass) return { pass: true as const };
              const revertOid = await Git.revertMergeCommit(adminPath, mergeOid).catch((error: unknown) => {
                logger.warn('crash-recovery: reverting the red merge failed', { repoDir, baseBranch, mergeOid, error: error instanceof Error ? error.message : String(error) });
                return null;
              });
              return { pass: false as const, output: check.output, revertOid };
            });
            if (verdict.pass) {
              await this.settleMerged(task, run);
              return;
            }
            const reverted = verdict.revertOid !== null && (await this.publishRevert(repoDir, baseBranch, mergeOid, verdict.revertOid));
            await this.settle.settle(task, run, 'escalate', {
              runState: 'failed',
              taskAction: 'escalate',
              reason: `escalated to human: post-merge check failed after restart${reverted ? '' : ` and the merge could not be reverted from ${baseBranch}`}: ${verdict.output}`,
            });
          }),
        );
      },
      this.deps.yieldOptions,
    );
  }

  private async settleMerged(task: TaskRow, run: TaskAttemptRow): Promise<void> {
    await this.settle.settle(task, run, 'agent-finish/unresolved', { runState: 'completed', taskAction: 'done', reason: null });
    await this.deps.postMerge?.({ repoDir: task.workingDir, baseBranch: run.baseBranch! });
  }

  private async publishRevert(repoDir: string, baseBranch: string, mergeOid: string, revertOid: string): Promise<boolean> {
    const checkoutDir = await Git.branchCheckedOutAt(repoDir, baseBranch);
    const dirtyPaths = checkoutDir !== null ? await captureDirtyPaths(checkoutDir) : new Set<string>();
    const cas = await Git.casUpdateRef(repoDir, baseBranch, revertOid, mergeOid);
    if (!cas.ok) {
      logger.warn('crash-recovery: base moved before the red merge could be reverted', { repoDir, baseBranch, mergeOid, detail: cas.detail });
      return false;
    }
    if (checkoutDir !== null) {
      try {
        await syncBaseCheckout(checkoutDir, dirtyPaths, mergeOid, revertOid);
      } catch (error) {
        logger.warn('crash-recovery: syncing the base checkout after the revert failed', { checkoutDir, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return true;
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
