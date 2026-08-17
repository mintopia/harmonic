import type { RunStore } from './runs.js';
import type { TaskService } from './tasks.js';
import type { WorkContextLeaseStore } from './work-context-leases.js';
import type { RunSettleCoordinator } from './run-settle.js';
import type { LandingCoordinator, LandingEffectExecutor } from './landing-coordinator.js';
import type { LandingJournalStore } from './landing-journal.js';
import type { TurnQueueStore } from './turn-queue-store.js';
import { foldJournal, type LandingEffect, type ObservedState } from './landing.js';
import { isMutating } from './turn-queue.js';
import { Git } from '../execution/git.js';
import { landBranch } from '../execution/branch-landing.js';

/**
 * Unified crash recovery across facts/journal/queue (issue #117): one boot-time
 * sweep that reconciles `run_facts`, `landing_journal`, and `turn_queue`
 * together, so a restart reconstructs one consistent picture instead of
 * several independent sweeps that could each draw a different — possibly
 * contradictory — conclusion about the same Run. In particular: a Run
 * mid-landing when the process died must never be blindly failed by the
 * generic orphan sweep (it may have already applied an irreversible effect —
 * see landing.ts's module doc comment), and a turn the queue still marks
 * `in_flight` has no live harness to finish it once this process starts, so it
 * needs its own boot decision too.
 *
 * Three ordered passes, run once at boot before anything can execute:
 *
 *   A. Landing runs first (so nothing later blind-fails them): resolve every
 *      Run parked `state:'running', phase:'landing'` against its journal.
 *   B. The turn queue: cancel every not-yet-dispatched pending turn, and
 *      resolve whatever the queue still marks `in_flight` — escalating the
 *      Run if it was a mutating corrective turn (self-heal/re-merge), since
 *      that turn's effect on the workspace is now unknown.
 *   C. The generic orphan sweep (unchanged semantics, moved here so it runs
 *      after A/B have already resolved anything more specific about a
 *      `running` Run).
 *
 * Idempotent: after pass A a completed/failed landing Run is terminal
 * (excluded from `RunStore.listLandingOrphans` on the next boot); after pass B
 * every queue row is cancelled/failed (excluded from `TurnQueueStore.listUnsettled`);
 * `markInterrupted` only ever selects `state:'running'`. A second boot changes
 * nothing.
 */
export class CrashRecoveryCoordinator {
  constructor(
    private readonly runStore: RunStore,
    private readonly taskService: TaskService,
    private readonly leaseStore: WorkContextLeaseStore,
    private readonly settle: RunSettleCoordinator,
    private readonly landing: LandingCoordinator,
    private readonly landingJournal: LandingJournalStore,
    private readonly turnQueue: TurnQueueStore,
    private readonly opts: {
      now?: () => number;
      isMerged?: (dir: string, baseBranch: string, branch: string) => Promise<boolean>;
    } = {},
  ) {}

  async reconcile(now?: number): Promise<void> {
    const ts = now ?? (this.opts.now ?? Date.now)();
    await this.reconcileLandingOrphans(ts);
    await this.reconcileTurnQueue(ts);
    // Pass C: the generic orphan sweep, moved here so it runs after A/B have
    // already resolved anything more specific about a `running` Run.
    for (const orphan of this.runStore.markInterrupted()) this.leaseStore.releaseByOwner(orphan.id);
  }

  /** Pass A: resolve every Run mid-landing when the process died. */
  private async reconcileLandingOrphans(now: number): Promise<void> {
    for (const run of this.runStore.listLandingOrphans()) {
      const task = this.taskService.get(run.taskId);
      const poncSeq = this.landingJournal.ponc(run.id);
      if (poncSeq === null) {
        // Died before the PONC ever froze — no irreversible effect could have
        // started (see landing.ts's module doc comment). Settle it as an
        // interrupted orphan, the same disposition the generic sweep would use.
        this.settle.settle(task, run, 'process-death', { runState: 'failed', taskAction: 'failed', reason: 'interrupted' });
        continue;
      }

      // A landing died between intent and result: ask the world (a worktree
      // merge is the only live effect today) rather than trusting the journal
      // alone — see landing.ts's `reconcile` doc comment. Only actually asks
      // (spawns `git`) when the journal itself doesn't already answer: an
      // effect with an `ok:true` result is `'already-applied'`
      // (landing.ts's `reconcile`) and never reaches `observed` at all, so a
      // fully-applied landing reconciles hermetically, no process spawned.
      const priorEntries = foldJournal(this.landingJournal.views(run.id));
      const needsWorldCheck = priorEntries.some((entry) => entry.effect === 'target-ref' && entry.intended && !entry.appliedOk);
      let merged = false;
      if (needsWorldCheck && run.branch && run.baseBranch) {
        const isMergedFn = this.opts.isMerged ?? Git.isAncestor;
        merged = await isMergedFn(task.workingDir, run.baseBranch, run.branch);
      }
      const observed = (effect: LandingEffect): ObservedState => (effect === 'target-ref' && merged ? 'present' : 'absent');
      const executors: Partial<Record<LandingEffect, LandingEffectExecutor>> = {
        'target-ref': async (_key, expected) => {
          const baseBranch = expected['baseBranch'] as string;
          const branch = expected['branch'] as string;
          // Re-drive the land through the same admin-worktree + CAS operation as
          // the live path (issue #153); idempotent, so a target already advanced
          // by the pre-crash attempt is an "Already up to date" no-op here.
          const outcome = await landBranch({ repoDir: task.workingDir, baseBranch, branch, leaseHeld: true });
          return outcome.ok ? { ok: true, observed: { baseBranch, branch } } : { ok: false, detail: outcome.detail };
        },
      };
      await this.landing.reconcileLanding(run, observed, executors);

      // Complete iff every intended effect has an ok result — mirrors exactly
      // what `LandingCoordinator.land()` checks before its own finishing
      // settle call (vacuously true when nothing was ever intended).
      const entries = foldJournal(this.landingJournal.views(run.id));
      if (entries.every((entry) => entry.appliedOk)) {
        // Same fact type + projection + patch as `land()`'s finishing settle
        // call — the only "land" signal today (landing-coordinator.ts's
        // `LAND_FACT_TYPE` doc comment, `ReviewService.accept`'s call site).
        this.settle.settle(
          task,
          run,
          'agent-finish/unresolved',
          { runState: 'completed', taskAction: 'completed', reason: null },
          { review: 'accepted', reviewedAt: now, reviewDeadline: null },
        );
      }
      // else: a re-applied effect genuinely failed (e.g. a real merge
      // conflict) — leave the Run parked in `landing` / the Task in
      // `awaiting-review` for a human to retry accept. A later boot
      // re-reconciles idempotently.
    }
  }

  /** Pass B: the turn queue — cancel every pending turn, resolve whatever is
   * still `in_flight` (no live harness survives a restart). */
  private async reconcileTurnQueue(now: number): Promise<void> {
    for (const row of this.turnQueue.listUnsettled()) {
      if (row.status === 'queued' || row.status === 'claimed') {
        this.turnQueue.cancel(row.id, 'execution-closed', now);
        continue;
      }
      // in_flight: no live harness for it now. A mutating corrective turn
      // (self-heal/re-merge) touched the workspace out from under the crash —
      // its effect is unknown, so the Run escalates to a human rather than
      // silently continuing as if nothing happened.
      if (isMutating(row.purpose)) {
        const run = this.runStore.get(row.runId);
        // Only a still-live Run escalates: if pass A (or a prior fact) already
        // drove this Run terminal, the stale in_flight turn is audit-only —
        // settling the turn below is enough. Re-opening a settled disposition
        // would let a rank-2 `escalate` wrongly flip an already-completed
        // landing, since `RunSettleCoordinator.settle` re-projects whenever the
        // winning disposition changes even when `state !== 'running'`.
        if (run.state === 'running') {
          const task = this.taskService.get(run.taskId);
          this.settle.settle(task, run, 'escalate', {
            runState: 'failed',
            taskAction: 'escalate',
            reason: `unresolved ${row.purpose} turn interrupted by restart`,
          });
        }
      }
      this.turnQueue.settle(row.id, 'failed', now);
    }
  }
}
