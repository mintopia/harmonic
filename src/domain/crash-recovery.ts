import type { AttemptRow, TaskRow } from '../db/schema.js';
import type { AttemptStore } from './attempts.js';
import type { TaskService } from './tasks.js';
import type { AttemptSettleCoordinator } from './attempt-settle.js';
import { Git } from '../execution/git.js';
import { withBaseCheckoutLock, withRepoLock } from '../execution/repo-lock.js';
import type { PostMergeCheckResult } from '../execution/merge-policy.js';
import type { PostMergeHook } from '../execution/branch-merge.js';
import { forEachYielding, type YieldOptions } from '../reliability/yield.js';
import { startOperation } from '../telemetry/operations.js';

/**
 * Crash recovery, per ADR-0001 ("Scope and design ceiling"): "Crash recovery
 * may rely on git's own idempotence and on rebuilding in-memory state from the
 * DB at boot." There is no crash journal, no work-context lease, and no turn
 * queue to reconcile — those are forensic/coordination mechanisms the ADR
 * bans outright (`merge_journal`/`turn_queue` are dropped once nothing calls
 * them; this coordinator is the last caller).
 *
 * Two ordered passes, run once at boot before anything can execute:
 *
 *   A. Worktree-mode merge orphans: a Run still `state:'running'` whose Task
 *      is `isolationMode:'worktree'` and whose branch/baseBranch are recorded
 *      may have crashed mid-merge. Ask git — `merge-base --is-ancestor` — not
 *      a journal: if the task branch already landed in the base, the merge
 *      itself is done and idempotent (a repeat `git merge --no-ff` would be
 *      "already up to date"); this pass just re-runs the one thing that
 *      couldn't have completed before the crash, the post-merge deterministic
 *      check, and reverts on red exactly as the live merge policy would
 *      (ADR-0001 "One merge policy, everywhere"). A branch that never landed
 *      is left alone — it falls through to pass B as an ordinary interrupted
 *      orphan, and the scheduler's next pick simply re-attempts the merge via
 *      the normal path.
 *   A2. Merged-but-unsettled Tasks (#427): a `working` or `escalated` Task whose
 *      latest Attempt already settled `passed` — its merge landed, but settle
 *      died after flipping the Attempt out of `running` (so pass A skips it) and
 *      before the Task reached `done`. Its `done` write is completed here, so
 *      the pass-B caller's generic `working`→`ready` sweep can't resurrect a
 *      merged Task into a second, double-merging Attempt, and an accepted-then-
 *      merged `escalated` Task isn't left a silent orphan.
 *   B. The generic orphan sweep (`RunStore.markInterrupted`): whatever is
 *      still `running` after pass A — never blindly failed there — is failed
 *      `interrupted`, and its Task returns to `ready` (the caller's job; see
 *      `app.ts`'s boot sequence).
 *
 * Idempotent by construction: pass A only selects `running` Runs, pass A2 only
 * a `passed` latest Attempt whose Task is not yet `done`, and both settling
 * (via {@link AttemptSettleCoordinator.settle}) and `markInterrupted` move a Run
 * out of `running` — so a second boot's queries simply don't re-select anything
 * this boot already resolved.
 */
export class CrashRecoveryCoordinator {
  constructor(
    private readonly attempts: AttemptStore,
    private readonly taskService: TaskService,
    private readonly settle: AttemptSettleCoordinator,
    private readonly deps: {
      /** Run the deterministic verify commands once against a merge that
       * already landed, mirroring the live merge policy's post-merge check
       * (`merge-policy.ts`'s `MergePolicyDeps.runPostMergeCheck`) — the same
       * primitive, just invoked for a merge git shows already happened rather
       * than one this process just performed. */
      runPostMergeCheck: (args: { task: TaskRow; run: AttemptRow; mergeOid: string; baseDir: string }) => Promise<PostMergeCheckResult>;
      /** Whether `branch` is already merged into `baseBranch`. Defaults to
       * `Git.isAncestor`; injectable for tests. */
      isMerged?: (dir: string, baseBranch: string, branch: string) => Promise<boolean>;
      /** Best-effort notification after a recovered merge is confirmed green
       * (e.g. the default-branch-advance Epic refresh hook). */
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
    // Pass A first, so nothing later blind-fails a Run whose merge already
    // landed. Pass A2 then settles any Task whose merge landed but whose settle
    // died mid-write (Attempt already `passed`, Task still `working`/
    // `escalated`), before the generic `working`→`ready` boot sweep can
    // resurrect it (#427). Pass B
    // (the generic orphan sweep) re-reads `running` after — whatever pass A
    // settled is no longer in that set.
    await this.reconcileMergeOrphans();
    await this.reconcileMergedButUnsettled();
    await this.attempts.markInterrupted();
  }

  /** Pass A: a worktree-mode Run whose branch already merged into its base
   * gets its post-merge check re-run (and reverted on red) instead of being
   * blindly failed. Everything else is left `running` for pass B. */
  private async reconcileMergeOrphans(): Promise<void> {
    const running = await this.attempts.listAllRunning();
    const candidates = running.filter((run) => run.branch !== null && run.baseBranch !== null);
    await forEachYielding(
      candidates,
      async (run) => {
        const task = await this.taskService.get(run.taskId);
        // Only worktree mode ever merges; a direct-mode Run commits straight
        // onto its base and has no merge step to reconcile (ADR-0001).
        if (task.isolationMode !== 'worktree') return;

        const isMerged = this.deps.isMerged ?? Git.isAncestor;
        const merged = await isMerged(task.workingDir, run.baseBranch!, run.branch!);
        if (!merged) return; // never merged: an ordinary interrupted orphan for pass B

        // The base-checkout lock (issue #455) keeps this reconcile mutually
        // exclusive with a live merge on the same checkout — the exclusion it
        // held before the merge lock was split — so it never touches an
        // in-progress merge's conflicted working tree; the inner metadata lock
        // serialises its git mutations against worktree ops.
        await withBaseCheckoutLock(task.workingDir, () =>
          withRepoLock(task.workingDir, async () => {
            const mergeOid = await Git.revParse(task.workingDir, run.baseBranch!);
            const check = await this.deps.runPostMergeCheck({ task, run, mergeOid, baseDir: task.workingDir });
            if (check.pass) {
              await this.settle.settle(task, run, 'agent-finish/unresolved', { runState: 'completed', taskAction: 'done', reason: null });
              await this.deps.postMerge?.({ repoDir: task.workingDir, baseBranch: run.baseBranch! });
            } else {
              // The base is never left red (ADR-0001): revert the merge commit
              // under the lock before releasing it, then escalate.
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

  /** Pass A2 (#427): a Task left non-terminal whose latest Attempt already
   * settled `passed` — its verified branch merged (ADR-0001) and, on the afk
   * auto-merge path, its ticket closed — but the process died inside
   * {@link AttemptSettleCoordinator.settle} after the Attempt flipped out of
   * `running` (so pass A, which only scans `running`, can't see it) and before
   * the Task's own `done` write landed. A `passed` Attempt is only ever a merged
   * one, so the merge is done and idempotent; only the Task transition is owed —
   * `working` for the afk auto-merge, `escalated` for the operator Accept that
   * merges an escalated ticket (`EscalationService.accept`, same two-write
   * settle, same window). Complete it here — before the generic `working`→
   * `ready` boot sweep (`app.ts`) — so a merged `working` Task is never
   * resurrected into a second Attempt that double-merges into the base, and a
   * merged `escalated` Task is never left a silent orphan whose dependents
   * never unblock. */
  private async reconcileMergedButUnsettled(): Promise<void> {
    for (const state of ['working', 'escalated'] as const) {
      for (const task of await this.taskService.list({ state })) {
        const latest = (await this.attempts.listForTask(task.id)).at(-1);
        if (latest?.state === 'passed') await this.taskService.setState(task.id, 'done');
      }
    }
  }
}
