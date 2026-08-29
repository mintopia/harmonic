import type { RunFactType, RunRow, TaskRow } from '../db/schema.js';
import type { RunStore } from './runs.js';
import type { TaskService } from './tasks.js';
import type { RunSettleCoordinator } from './run-settle.js';
import type { MergeCoordinator, MergeEffectExecutor } from './merge-coordinator.js';
import type { MergeJournalStore } from './merge-journal.js';
import type { TurnQueueStore } from './turn-queue-store.js';
import { foldJournal, type MergeEffect, type ObservedState } from './merge.js';
import { isMutating, survivesRestart } from './turn-queue.js';
import { Git } from '../execution/git.js';
import { mergeIntoBaseAndRunPostMerge, type PostMergeHook } from '../execution/branch-merge.js';
import { forEachYielding, type YieldOptions } from '../reliability/yield.js';
import { startOperation } from '../telemetry/operations.js';

/**
 * Unified crash recovery across facts/journal/queue (issue #117): one boot-time
 * sweep that reconciles `run_facts`, `merge_journal`, and `turn_queue`
 * together, so a restart reconstructs one consistent picture instead of
 * several independent sweeps that could each draw a different — possibly
 * contradictory — conclusion about the same Run. In particular: a Run
 * mid-merging when the process died must never be blindly failed by the
 * generic orphan sweep (it may have already applied an irreversible effect —
 * see merge.ts's module doc comment), and a turn the queue still marks
 * `in_flight` has no live harness to finish it once this process starts, so it
 * needs its own boot decision too.
 *
 * Three ordered passes, run once at boot before anything can execute:
 *
 *   A. Merging runs first (so nothing later blind-fails them): resolve every
 *      Run parked `state:'running', phase:'merging'` against its journal.
 *   B. The turn queue: cancel every not-yet-dispatched pending turn, and
 *      resolve whatever the queue still marks `in_flight` — escalating the
 *      Run if it was a mutating corrective turn (self-heal/re-merge), since
 *      that turn's effect on the workspace is now unknown.
 *   C. The generic orphan sweep (unchanged semantics, moved here so it runs
 *      after A/B have already resolved anything more specific about a
 *      `running` Run).
 *
 * Idempotent: after pass A a completed/failed merging Run is terminal
 * (excluded from `RunStore.listMergeOrphans` on the next boot); after pass B
 * every queue row is cancelled/failed (excluded from `TurnQueueStore.listUnsettled`);
 * `markInterrupted` only ever selects `state:'running'`. A second boot changes
 * nothing.
 */
export class CrashRecoveryCoordinator {
  constructor(
    private readonly runStore: RunStore,
    private readonly taskService: TaskService,
    private readonly settle: RunSettleCoordinator,
    private readonly merging: MergeCoordinator,
    private readonly mergeJournal: MergeJournalStore,
    private readonly turnQueue: TurnQueueStore,
    private readonly opts: {
      now?: () => number;
      isMerged?: (dir: string, baseBranch: string, branch: string) => Promise<boolean>;
      postMerge?: PostMergeHook;
      yieldOptions?: YieldOptions;
      /** Closes a mirrored Task's ticket (the `ticket-close` merging effect); absent ⇒ the effect re-applies as a no-op. */
      closeTicket?: (task: TaskRow) => Promise<boolean>;
    } = {},
  ) {}

  async reconcile(now?: number): Promise<void> {
    const operation = startOperation({ type: 'startup.crash-reconcile', attributes: {} });
    try {
      await operation.run(() => this.reconcileInterrupted(now));
      operation.end();
    } catch (error) {
      operation.fail(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  private async reconcileInterrupted(now?: number): Promise<void> {
    const ts = now ?? (this.opts.now ?? Date.now)();
    await this.reconcileMergeOrphans();
    await this.reconcileTurnQueue(ts);
    // Pass C: the generic orphan sweep, moved here so it runs after A/B have
    // already resolved anything more specific about a `running` Run.
    await this.runStore.markInterrupted();
  }

  /** Pass A: resolve every Run mid-merging when the process died. */
  private async reconcileMergeOrphans(): Promise<void> {
    await forEachYielding(await this.runStore.listMergeOrphans(), async (run) => {
      const task = await this.taskService.get(run.taskId);
      const poncSeq = await this.mergeJournal.ponc(run.id);
      if (poncSeq === null) {
        // Died before the PONC ever froze — no irreversible effect could have
        // started (see merge.ts's module doc comment). Settle it as an
        // interrupted orphan, the same disposition the generic sweep would use.
        await this.settle.settle(task, run, 'process-death', { runState: 'failed', taskAction: 'ready', reason: 'interrupted' });
        return;
      }

      // A merging died between intent and result: ask the world (a worktree
      // merge is the only live effect today) rather than trusting the journal
      // alone — see merge.ts's `reconcile` doc comment. Only actually asks
      // (spawns `git`) when the journal itself doesn't already answer: an
      // effect with an `ok:true` result is `'already-applied'`
      // (merge.ts's `reconcile`) and never reaches `observed` at all, so a
      // fully-applied merging reconciles hermetically, no process spawned.
      const journalViews = await this.mergeJournal.views(run.id);
      const priorEntries = foldJournal(journalViews);
      const latestResults = new Map<string, typeof journalViews[number]>();
      for (const row of journalViews) {
        if (row.kind === 'result' && row.idempotencyKey !== null) latestResults.set(row.idempotencyKey, row);
      }
      const failedResult = [...latestResults.values()].find((row) => row.payload['ok'] === false);
      if (failedResult) {
        const detail = failedResult.payload['detail'];
        await this.escalateFailedMerge(task, run, typeof detail === 'string' ? detail : 'merging failed');
        return;
      }
      const needsWorldCheck = priorEntries.some((entry) => entry.effect === 'target-ref' && entry.intended && !entry.appliedOk);
      let merged = false;
      if (needsWorldCheck && task.isolationMode === 'worktree' && run.branch && run.baseBranch) {
        const isMergedFn = this.opts.isMerged ?? Git.isAncestor;
        merged = await isMergedFn(task.workingDir, run.baseBranch, run.branch);
      }
      const observed = (effect: MergeEffect): ObservedState => (effect === 'target-ref' && merged ? 'present' : 'absent');
      const executors: Partial<Record<MergeEffect, MergeEffectExecutor>> = {
        // Idempotent (the adapter reads the ticket's state first), so a close
        // the pre-crash attempt already issued is a no-op here.
        'ticket-close': async () =>
          (await this.opts.closeTicket?.(task)) === false
            ? { ok: false, detail: `ticket #${task.trackerRef} could not be closed` }
            : { ok: true, observed: { trackerRef: task.trackerRef } },
        'target-ref': async (_key, expected) => {
          const baseBranch = expected['baseBranch'] as string;
          const branch = expected['branch'] as string;
          // Re-drive the merge through the same SHA-asserted operation as the
          // live path (issue #153, ADR-0041); idempotent, so a target already
          // advanced by the pre-crash attempt is a no-op here. Recovery cannot
          // run an agent turn, so a stale head/base refuses rather than merging
          // what verification never saw.
          if (!run.candidateOid) return { ok: false, detail: 'no verified branch head recorded for this Run' };
          const outcome = await mergeIntoBaseAndRunPostMerge(
            { repoDir: task.workingDir, baseBranch, branch, expectedOid: run.candidateOid, leaseHeld: true },
            this.opts.postMerge,
          );
          return outcome.ok ? { ok: true, observed: { baseBranch, branch } } : { ok: false, detail: outcome.detail };
        },
      };
      await this.merging.reconcileMerge(run, observed, executors);

      // Complete iff every intended effect has an ok result — mirrors exactly
      // what `MergeCoordinator.merge()` checks before its own finishing
      // settle call (vacuously true when nothing was ever intended).
      const entries = foldJournal(await this.mergeJournal.views(run.id));
      if (entries.every((entry) => entry.appliedOk)) {
        // Finish with the merge fact the PONC froze — same type and projection
        // as the merging that died (`MergeCoordinator.merge` appends it before
        // its first effect), so an operator Accept still outranks the escalate
        // fact it was answering.
        const mergeFact = (await this.settle.facts(run.id)).find((fact) => fact.seq === poncSeq);
        await this.settle.settle(
          task,
          run,
          (mergeFact?.type as RunFactType | undefined) ?? 'agent-finish/unresolved',
          mergeFact?.projection ?? { runState: 'completed', taskAction: 'done', reason: null },
        );
      } else {
        const failed = (await this.mergeJournal.views(run.id)).findLast((row) => row.kind === 'result' && row.payload['ok'] === false);
        const detail = failed?.payload['detail'];
        await this.escalateFailedMerge(task, run, typeof detail === 'string' ? detail : 'merging effect could not be re-applied');
      }
    }, this.opts.yieldOptions);
  }

  /** A merging that cannot complete is escalation trigger 3 (infrastructure): lift the PONC and hand the ticket to a human. */
  private async escalateFailedMerge(task: TaskRow, run: RunRow, detail: string): Promise<void> {
    await this.merging.abandon(run, detail);
    await this.settle.settle(task, run, 'escalate', {
      runState: 'failed',
      taskAction: 'escalate',
      reason: `escalated to human: merging failed after restart: ${detail}`,
    });
  }

  /** Pass B: the turn queue — cancel every pending turn, resolve whatever is
   * still `in_flight` (no live harness survives a restart). */
  private async reconcileTurnQueue(now: number): Promise<void> {
    await forEachYielding(await this.turnQueue.listUnsettled(), async (row) => {
      if (row.status === 'queued' || row.status === 'claimed') {
        // A pending resume re-entry (`crash-recovery`, issue #146) is *meant* to
        // survive a restart and be picked up by the next running process — the
        // exact opposite of a stale pending turn. Leave it queued; cancelling it
        // would silently drop a pending resume on any boot after the one that
        // enqueued it. (An in_flight one still falls through below: it is
        // non-mutating, so it just settles `failed`, never blocking single-flight
        // on the next boot.)
        if (survivesRestart(row.purpose)) return;
        await this.turnQueue.cancel(row.id, 'execution-closed', now);
        return;
      }
      // in_flight: no live harness for it now. A mutating corrective turn
      // (self-heal/re-merge) touched the workspace out from under the crash —
      // its effect is unknown, so the Run escalates to a human rather than
      // silently continuing as if nothing happened.
      if (isMutating(row.purpose)) {
        const run = await this.runStore.get(row.runId);
        // Only a still-live Run escalates: if pass A (or a prior fact) already
        // drove this Run terminal, the stale in_flight turn is audit-only —
        // settling the turn below is enough. Re-opening a settled disposition
        // would let a rank-2 `escalate` wrongly flip an already-completed
        // merging, since `RunSettleCoordinator.settle` re-projects whenever the
        // winning disposition changes even when `state !== 'running'`.
        if (run.state === 'running') {
          const task = await this.taskService.get(run.taskId);
          await this.settle.settle(task, run, 'escalate', {
            runState: 'failed',
            taskAction: 'escalate',
            reason: `unresolved ${row.purpose} turn interrupted by restart`,
          });
        }
      }
      await this.turnQueue.settle(row.id, 'failed', now);
    }, this.opts.yieldOptions);
  }
}
