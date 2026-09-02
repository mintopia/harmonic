import type { AttemptRow, TaskRow } from '../db/schema.js';
import type { AttemptStore } from '../domain/attempts.js';
import type { TaskService } from '../domain/tasks.js';
import type { AttemptSettleCoordinator } from '../domain/attempt-settle.js';
import { Git } from './git.js';
import { withBaseCheckoutLock, withRepoLock } from './repo-lock.js';
import type { PostMergeCheckResult } from './merge-policy.js';
import type { PostMergeHook } from './branch-merge.js';
import { forEachYielding, type YieldOptions } from '../reliability/yield.js';
import { startOperation } from '../telemetry/operations.js';

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
      yieldOptions?: YieldOptions;
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
    await this.attempts.markInterrupted();
  }

  private async reconcileMergeOrphans(): Promise<void> {
    const running = await this.attempts.listAllRunning();
    const candidates = running.filter((run) => run.branch !== null && run.baseBranch !== null);
    await forEachYielding(
      candidates,
      async (run) => {
        const task = await this.taskService.get(run.taskId);
        if (task.isolationMode !== 'worktree') return;

        const isMerged = this.deps.isMerged ?? Git.isAncestor;
        const merged = await isMerged(task.workingDir, run.baseBranch!, run.branch!);
        if (!merged) return;

        await withBaseCheckoutLock(task.workingDir, () =>
          withRepoLock(task.workingDir, async () => {
            const mergeOid = await Git.revParse(task.workingDir, run.baseBranch!);
            const check = await this.deps.runPostMergeCheck({ task, run, mergeOid, baseDir: task.workingDir });
            if (check.pass) {
              await this.settle.settle(task, run, 'agent-finish/unresolved', { runState: 'completed', taskAction: 'done', reason: null });
              await this.deps.postMerge?.({ repoDir: task.workingDir, baseBranch: run.baseBranch! });
            } else {
              await Git.revertMergeCommit(task.workingDir, mergeOid);
              await this.settle.settle(task, run, 'escalate', {
                runState: 'failed',
                taskAction: 'escalate',
                reason: `escalated to human: post-merge check failed after restart: ${check.output}`,
              });
            }
          }),
        );
      },
      this.deps.yieldOptions,
    );
  }

  private async reconcileMergedButUnsettled(): Promise<void> {
    for (const state of ['working', 'escalated'] as const) {
      for (const task of await this.taskService.list({ state })) {
        const latest = (await this.attempts.listForTask(task.id)).at(-1);
        if (latest?.state === 'passed') await this.taskService.setState(task.id, 'done');
      }
    }
  }
}
