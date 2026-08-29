import type { RunRow, TaskRow, RunFactType } from '../db/schema.js';
import type { RunStore } from './runs.js';
import type { TaskService } from './tasks.js';
import type { RunFactStore } from './run-facts.js';
import { computeDisposition, type Disposition } from './run-disposition.js';
import { projectSettle, type CoordinatorFact, type SettleProjection } from './run-coordinator.js';
import type { SessionRetirementHook } from './session-retirement-coordinator.js';
import type { RetirementCause } from './session-retirement.js';

export interface RunBranchRetirementHook {
  onRunSettled(task: TaskRow, run: RunRow): Promise<void>;
}

/**
 * The single terminal-disposition coordinator (issue #113, generalised for the
 * phase machine in #114; reliability-design §0.3). Every way a Run reaches a
 * terminal disposition funnels through {@link RunSettleCoordinator.settle}: the
 * ending signal is appended as an immutable `run_fact` carrying the concrete
 * projection it intends, then the coordinator replays the **winning** fact's
 * projection by fixed precedence — so a cancel arriving close to an agent-finish
 * settles the Run by precedence, never by whoever wrote the Run row first.
 * Run/Task terminal state is thereby a projection of `run_facts`, reconstructable
 * from the log alone.
 *
 * #113 kept this logic private to the Runner because the Runner was the only
 * settle authority. A **second** authority — the operator Accept on an
 * escalated ticket (`EscalationService.accept`) — settles a Run long after
 * its harness is gone. Extracting the coordinator to a shared,
 * dependency-injected class lets both drive it with identical race-safety,
 * instead of the operator path racing the Runner around the Run row.
 *
 * There is no PONC/merge-journal clamp on the disposition cutoff (ADR-0001,
 * ADR-0007): the one merge policy (`execution/merge-policy.ts`) runs entirely
 * under the base repo mutex and settles through this same coordinator once —
 * there is no separate journaled merge process for a racing cancel to need
 * fencing against.
 */
export class RunSettleCoordinator {
  constructor(
    private readonly runStore: RunStore,
    private readonly taskService: TaskService,
    private readonly runFacts: RunFactStore,
    private readonly onRunFinished?: (run: RunRow) => void,
    private readonly sessionRetirement?: SessionRetirementHook,
    private readonly branchRetirement?: RunBranchRetirementHook,
  ) {}

  /**
   * Settle `run` to a terminal disposition. Appends `type` (carrying `projection`)
   * to the Run's fact log, recomputes the winning disposition over the whole log,
   * and — if this signal changes the decision — writes the winning terminal
   * state to the Run row, releases the Work Context lease, and applies the
   * winning Task action. `patch` (usage/stat/stopReason) rides with the
   * winning write.
   *
   * Settles once under the close-together race: a lower-or-equal-precedence
   * straggler arriving after the winning disposition already in place recomputes the
   * same winner and no-ops; a higher-precedence signal arriving late overrides the
   * Run row to the new winner.
   */
  async settle(
    task: TaskRow,
    run: RunRow,
    type: RunFactType,
    projection: SettleProjection,
    patch: Partial<RunRow> = {},
  ): Promise<void> {
    // The winning disposition BEFORE this signal — so we can tell whether this
    // signal actually changes the coordinator's decision. Captured before our
    // own append.
    const priorFacts = await this.coordinatorFacts(run.id);

    await this.runFacts.append(run.id, type, { ...projection });

    const priorDisposition = priorFacts.length
      ? computeDisposition(priorFacts, priorFacts[priorFacts.length - 1]!.seq)
      : null;

    const facts = await this.coordinatorFacts(run.id);
    // The cutoff is simply the log's latest seq: a Run only appends a
    // disposition fact at a settle decision point, so "the whole log decides"
    // holds regardless of which Step the Attempt was on when it settled.
    const cutoff = facts[facts.length - 1]!.seq;
    const disposition = computeDisposition(facts, cutoff);
    const winner = disposition === null ? null : projectSettle(facts, cutoff);
    if (!winner) return; // unreachable — we just appended a fact

    const before = await this.runStore.get(run.id);
    // Idempotency keys on the winning DISPOSITION, not the Run state: a
    // lower-or-equal-precedence straggler leaves the winner unchanged and no-ops
    // (settle exactly once), while a higher-precedence signal arriving late
    // overrides — even when it maps to the same Run state but a different Task
    // action (e.g. escalate after a bare failure).
    // A terminal Run already showing the winning projection is a duplicate
    // straggler. A terminal Run whose row does not (an escalated ticket's Run
    // being merged by an operator Accept, whose merge fact is on the log before
    // this settle) still applies.
    if (before.state !== 'running' && disposition === priorDisposition && before.state === winner.runState) return;

    // `patch` (usage/stat/stopReason) rides with the winning terminal write,
    // matching today's semantics — a losing straggler never decorates the row
    // another disposition won. `state` leaving `'running'` marks the Run
    // settled (issue #114); there is no separate phase column to close out.
    await this.runStore.updateWithFrozenCost(run.id, {
      ...patch,
      state: winner.runState,
      reason: winner.reason,
      finishedAt: before.finishedAt ?? Date.now(),
    });
    // Session retirement (issue #148, reliability-design Unit C): record the
    // intent for this Run's Session — retire now (a merge/abandon/cancel) or
    // retain under a deadline (a reject / other ending). Awaited but
    // best-effort: it only marks the Session's status; the async worktree
    // removal is a separate drain, and a hiccup must never crash settle.
    const finished = await this.runStore.get(run.id);
    try {
      await this.sessionRetirement?.onRunSettled(finished, this.retirementCause(disposition, winner));
    } catch {
      // best-effort; the boot/periodic drain reconciles from the Session row
    }
    try {
      await this.branchRetirement?.onRunSettled(task, finished);
    } catch {
      // Best-effort. A later boot reconciliation retries branch retirement.
    }
    await this.applySettleTaskAction(task.id, winner);
    this.onRunFinished?.(finished);
  }

  /**
   * Map the winning disposition to the retirement cause a Session needs (issue
   * #148): an operator cancel retires immediately; any `completed` Run merged
   * (a Run only completes via merging); every other ending (escalate,
   * guardrail-trip, process-death) retains the Task's worktree until its terminal
   * disposition (ADR-0046) — the next Attempt resumes in it, and an escalated
   * ticket's branch is the candidate its Accept merges.
   */
  private retirementCause(disposition: Disposition | null, winner: SettleProjection): RetirementCause {
    if (disposition === 'operator-cancel') return 'operator-cancel';
    if (winner.runState === 'completed') return 'merged';
    return 'other';
  }

  /** A Run's fact log decoded into the coordinator's projection-carrying shape. */
  async facts(runId: number): Promise<CoordinatorFact[]> {
    return this.coordinatorFacts(runId);
  }

  private async coordinatorFacts(runId: number): Promise<CoordinatorFact[]> {
    return (await this.runFacts.list(runId)).map((f) => ({
      seq: f.seq,
      type: f.type,
      projection: JSON.parse(f.payload) as SettleProjection,
    }));
  }

  /**
   * Apply the winning fact's Task transition. `none` leaves the Task to its
   * caller (operator cancel/complete already moved it). Every other action moves
   * only a Task that is still `working` — or `escalated`, for the operator
   * Accept that merges an escalated ticket (`done`). A Task already in a terminal state (a racing cancel that moved it) makes the
   * action no-op, so the higher-precedence signal still wins the Run row while the
   * Task keeps the disposition the race already gave it.
   */
  private async applySettleTaskAction(taskId: number, winner: SettleProjection): Promise<void> {
    if (winner.taskAction === 'none') return;
    const state = (await this.taskService.get(taskId)).state;
    if (state !== 'working' && !(state === 'escalated' && winner.taskAction !== 'ready')) return;
    switch (winner.taskAction) {
      case 'done':
        await this.taskService.setState(taskId, 'done');
        break;
      case 'ready':
        await this.taskService.setState(taskId, 'ready');
        break;
      case 'escalate':
        await this.taskService.escalate(taskId, winner.reason ?? 'escalated');
        break;
    }
  }

}
