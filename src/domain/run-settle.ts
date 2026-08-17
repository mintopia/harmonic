import type { RunRow, TaskRow, RunFactType } from '../db/schema.js';
import type { RunStore } from './runs.js';
import type { TaskService } from './tasks.js';
import type { WorkContextLeaseStore } from './work-context-leases.js';
import type { RunFactStore } from './run-facts.js';
import type { LandingJournalStore } from './landing-journal.js';
import { computeDisposition } from './run-disposition.js';
import { projectSettle, type CoordinatorFact, type SettleProjection, type SettleTaskAction } from './run-coordinator.js';

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
 * settle authority. #114 adds a **second** authority — the human review gate
 * (`ReviewService.accept`/`reject`) and the review-SLA sweep both settle a Run
 * that is parked in `phase:'review'` long after its harness is gone. Extracting
 * the coordinator to a shared, dependency-injected class lets both drive it with
 * identical race-safety, instead of the review path racing the Runner around the
 * Run row.
 *
 * `landingJournal` is a **third** settle-adjacent concern layered on top by
 * issue #115: the journaled non-interruptible landing's Point Of No Cancel
 * (PONC, see domain/landing.ts's module doc comment). Once a landing has
 * written its PONC, a cancel/guardrail-trip fact that races in afterward must
 * never be allowed to flip the winning disposition away from the land that's
 * already underway (or, worse, retroactively "unland" an effect that already
 * fired). The dependency is **optional** — every existing call site and test
 * that constructs this coordinator without it keeps behaving exactly as
 * before #115 shipped: `poncCutoffFor` degrades to "no clamp" when
 * `landingJournal` is undefined.
 */
export class RunSettleCoordinator {
  constructor(
    private readonly runStore: RunStore,
    private readonly taskService: TaskService,
    private readonly leaseStore: WorkContextLeaseStore,
    private readonly runFacts: RunFactStore,
    private readonly onRunFinished?: (run: RunRow) => void,
    private readonly landingJournal?: LandingJournalStore,
  ) {}

  /**
   * Settle `run` to a terminal disposition. Appends `type` (carrying `projection`)
   * to the Run's fact log, recomputes the winning disposition over the whole log,
   * and — if this signal changes the decision — writes the winning terminal state
   * to the Run row (phase → `terminal`), releases the Work Context lease, and
   * applies the winning Task action. `patch` (usage/stat/stopReason) rides with
   * the winning write.
   *
   * Settles once under the close-together race: a lower-or-equal-precedence
   * straggler arriving after the winning disposition already landed recomputes the
   * same winner and no-ops; a higher-precedence signal arriving late overrides the
   * Run row to the new winner.
   */
  settle(
    task: TaskRow,
    run: RunRow,
    type: RunFactType,
    projection: SettleProjection,
    patch: Partial<RunRow> = {},
  ): void {
    // The PONC freeze (issue #115, reliability-design §0.3): if a landing has
    // already frozen this Run's disposition cutoff, no fact appended after it
    // — including the very signal this call is settling — can move the
    // decision past that point. Read once per call so both the prior and
    // post-append cutoffs below clamp against the same value.
    const poncCutoffSeq = this.landingJournal?.ponc(run.id) ?? null;

    // The winning disposition BEFORE this signal — so we can tell whether this
    // signal actually changes the coordinator's decision.
    const priorFacts = this.coordinatorFacts(run.id);
    const priorDisposition = priorFacts.length
      ? computeDisposition(priorFacts, this.clampCutoff(priorFacts[priorFacts.length - 1]!.seq, poncCutoffSeq))
      : null;

    this.runFacts.append(run.id, type, { ...projection });

    const facts = this.coordinatorFacts(run.id);
    // The cutoff is the log's latest seq — clamped to the PONC when one is
    // frozen (issue #115): a Run only appends a disposition fact at a settle
    // decision point, so "the whole log decides, up to the freeze" holds even
    // with the phase machine (phases are recorded separately, not as
    // disposition facts). A fact landing after the PONC (`seq > poncCutoffSeq`)
    // — e.g. a cancel racing in mid-landing — stays in the log for the record
    // but this clamp is exactly what keeps it from ever being decisive: the
    // land that already started stands, and the operator sees "landed," not
    // "cancelled."
    const cutoff = this.clampCutoff(facts[facts.length - 1]!.seq, poncCutoffSeq);
    const disposition = computeDisposition(facts, cutoff);
    const winner = disposition === null ? null : projectSettle(facts, cutoff);
    if (!winner) return; // unreachable — we just appended a fact

    const before = this.runStore.get(run.id);
    // Idempotency keys on the winning DISPOSITION, not the Run state: a
    // lower-or-equal-precedence straggler leaves the winner unchanged and no-ops
    // (settle exactly once), while a higher-precedence signal arriving late
    // overrides — even when it maps to the same Run state but a different Task
    // action (e.g. escalate after a bare failure).
    if (before.state !== 'running' && disposition === priorDisposition) return;

    // `patch` (usage/stat/stopReason) rides with the winning terminal write,
    // matching today's semantics — a losing straggler never decorates the row
    // another disposition won. `phase: 'terminal'` marks the Run settled: it has
    // left every in-flight/parked phase (issue #114).
    this.runStore.update(run.id, {
      ...patch,
      state: winner.runState,
      phase: 'terminal',
      reason: winner.reason,
      finishedAt: before.finishedAt ?? Date.now(),
    });
    this.releaseLease(run.id);
    this.applySettleTaskAction(task.id, winner.taskAction);
    this.onRunFinished?.(this.runStore.get(run.id));
  }

  /** `min(latestSeq, poncCutoffSeq)`, or `latestSeq` unclamped when
   * `poncCutoffSeq` is `null` (no PONC frozen yet, or `landingJournal` was
   * never injected — the #115 back-compat path). */
  private clampCutoff(latestSeq: number, poncCutoffSeq: number | null): number {
    return poncCutoffSeq === null ? latestSeq : Math.min(latestSeq, poncCutoffSeq);
  }

  /** A Run's fact log decoded into the coordinator's projection-carrying shape. */
  private coordinatorFacts(runId: number): CoordinatorFact[] {
    return this.runFacts.list(runId).map((f) => ({
      seq: f.seq,
      type: f.type,
      projection: JSON.parse(f.payload) as SettleProjection,
    }));
  }

  /**
   * Apply the winning fact's Task transition. `none` leaves the Task to its
   * caller (operator cancel/complete already moved it). Every other action moves
   * only a Task that is still `running` **or** `awaiting-review` — the latter is
   * new for #114: a native Run's Task sits in `awaiting-review` while its Run is
   * parked in `phase:'review'`, and accept/reject/SLA-expiry settle *from* there.
   * A Task already in a terminal state (a racing cancel that moved it) makes the
   * action no-op, so the higher-precedence signal still wins the Run row while the
   * Task keeps the disposition the race already gave it.
   */
  private applySettleTaskAction(taskId: number, action: SettleTaskAction): void {
    if (action === 'none') return;
    const state = this.taskService.get(taskId).state;
    if (state !== 'running' && state !== 'awaiting-review') return;
    switch (action) {
      case 'awaiting-review':
        this.taskService.setState(taskId, 'awaiting-review');
        break;
      case 'completed':
        this.taskService.setState(taskId, 'completed');
        break;
      case 'failed':
        this.taskService.setState(taskId, 'failed');
        break;
      case 'ready':
        this.taskService.setState(taskId, 'ready');
        break;
      case 'escalate':
        this.taskService.escalate(taskId);
        break;
    }
  }

  /** Release the Work Context lease this Run holds, on any terminal disposition.
   * Idempotent and best-effort — a lease-release hiccup must never crash settle.
   * Keyed by owner Run id so it needs no key recompute. A native Run parked in
   * `review` already released its lease at review entry (#114 releases at that
   * seam; holding it across the review window awaits the phase-specific lease
   * TTLs of #122), so for those this is a harmless idempotent no-op. */
  private releaseLease(runId: number): void {
    try {
      this.leaseStore.releaseByOwner(runId);
    } catch {
      // best-effort; boot reconciliation is the backstop
    }
  }
}
