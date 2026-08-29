import type { TaskRow, AttemptRow, AttemptState } from '../db/schema.js';
import type { TaskService } from './tasks.js';
import type { AttemptStore } from './attempts.js';
import type { SessionRetirementHook } from './session-retirement-coordinator.js';
import type { RetirementCause } from './session-retirement.js';

export interface RunBranchRetirementHook {
  onRunSettled(task: TaskRow, attempt: AttemptRow): Promise<void>;
}

/** The Attempt's terminal surface disposition (never `running`), before the
 * one operator-escalate exception can still promote it to `escalated`
 * (see {@link attemptTerminalState}). Folded from `runs.state` (ADR-0001
 * #388 S-G): 'completed'/'failed'/'cancelled' map onto AttemptState's
 * 'passed'/'failed'/'cancelled'. */
export type RunTerminalState = 'completed' | 'failed' | 'cancelled';

/**
 * What the coordinator does to the owning Task when the Run settles. `none`
 * leaves the Task untouched — the operator cancel/force-complete flow already
 * transitioned it through the Task service, so the coordinator must not fight
 * that. `done` merges the ticket, `ready` re-queues it (a transient fault the
 * next pick retries), `escalate` hands it to a human with the reason.
 * Applied only while the Task is still `working` (or `escalated`, for the
 * operator Accept that merges from there); a racing cancel that already moved
 * it wins.
 */
export type SettleTaskAction = 'done' | 'escalate' | 'ready' | 'none';

/** The terminal projection a disposition intends for the Run/Task. */
export interface SettleProjection {
  runState: RunTerminalState;
  taskAction: SettleTaskAction;
  reason: string | null;
}

/**
 * Every ending-signal kind `settle` can be called with — the disposition's
 * audit value persisted verbatim to `attempts.reason` (ADR-0001 #388 S-E: the
 * append-only fact log + precedence replay collapsed into this one column).
 * Open for extension in spirit (a caller may pass any string), but these are
 * every kind a live emitter produces today.
 */
export const DISPOSITION_KINDS = [
  'operator-cancel',
  'operator-accept',
  'escalate',
  'failed',
  'process-death',
  'guardrail-trip',
  'agent-finish/unresolved',
] as const;
export type DispositionKind = (typeof DISPOSITION_KINDS)[number];

/**
 * The single terminal-disposition coordinator (ADR-0001 "The loop" / "One
 * merge policy": "failure is an Attempt-level fact; a Task loops or
 * escalates"). Every way a Run reaches a terminal disposition funnels through
 * {@link RunSettleCoordinator.settle}: a **guarded state transition**, not a
 * fact-log replay — the single-process/single-writer model (ADR-0007) has no
 * concurrent-writer coordination to reconcile, so the caller-supplied
 * disposition is applied directly under the same "only leave `running`"
 * discipline `RunStore.finish`/`markInterrupted` already use.
 *
 * The one exception to first-writer-wins is the operator's own surface
 * (ADR-0001 "Guardrails and escalation" / ADR-0041's one human surface):
 * `operator-cancel` / `operator-accept` may act on an Attempt/Run that already
 * settled `escalated`/`failed` — Accept merging an escalated ticket, or Close
 * cancelling one. Every other disposition is first-writer-wins: a second
 * racing settle on an already-terminal Attempt/Run is a no-op.
 *
 * #113 kept this logic private to the Runner because the Runner was the only
 * settle authority. A **second** authority — the operator Accept on an
 * escalated ticket (`EscalationService.accept`) — settles a Run long after
 * its harness is gone. The coordinator is a shared, dependency-injected class
 * so both drive it with identical race-safety, instead of the operator path
 * racing the Runner around the Run row.
 */
export class RunSettleCoordinator {
  constructor(
    private readonly taskService: TaskService,
    private readonly attempts: AttemptStore,
    private readonly onRunFinished?: (attempt: AttemptRow) => void,
    private readonly sessionRetirement?: SessionRetirementHook,
    private readonly branchRetirement?: RunBranchRetirementHook,
  ) {}

  /**
   * Settle `attempt` to `projection`'s terminal disposition under `type`'s
   * guard. No-ops when the Attempt is already at (or past) that disposition
   * and `type` is not an operator override — the idempotent "settle exactly
   * once" contract a racing straggler (a post-SIGKILL harness-exit fact after
   * an operator cancel, a second guardrail trip) relies on. `patch`
   * (usage/stat/stopReason/…) rides with the write, matching prior semantics
   * — the Attempt is now the single execution ledger (ADR-0001 #388 S-G), so
   * one write closes it out instead of a paired Run+Attempt write.
   */
  async settle(
    task: TaskRow,
    attempt: AttemptRow,
    type: DispositionKind,
    projection: SettleProjection,
    patch: Partial<AttemptRow> = {},
  ): Promise<void> {
    const isOperatorOverride = type === 'operator-cancel' || type === 'operator-accept';
    const before = await this.attempts.get(attempt.id);
    const movable = before.state === 'running' || (before.state === 'escalated' && isOperatorOverride);
    if (!movable) return; // already settled at (or past) this disposition; a straggler no-ops

    const finished = await this.attempts.updateWithFrozenCost(attempt.id, {
      ...patch,
      state: attemptTerminalState(type, projection),
      reason: type,
      // The free-text detail behind `reason` (a git/harness error, a
      // guardrail's `budget: …` summary, "escalated to human: …") — folded
      // from `runs.reason` onto its own column (ADR-0001 #388 S-G) so it
      // survives alongside the structured `reason` on the same row.
      detail: projection.reason,
      endedAt: before.endedAt ?? Date.now(),
    });

    // Session retirement (issue #148, reliability-design Unit C): record the
    // intent for this Attempt's Session — retire now (a merge/abandon/cancel) or
    // retain under a deadline (a reject / other ending). Awaited but
    // best-effort: it only marks the Session's status; the async worktree
    // removal is a separate drain, and a hiccup must never crash settle.
    try {
      await this.sessionRetirement?.onRunSettled(finished, this.retirementCause(type, projection));
    } catch {
      // best-effort; the boot/periodic drain reconciles from the Session row
    }
    try {
      await this.branchRetirement?.onRunSettled(task, finished);
    } catch {
      // Best-effort. A later boot reconciliation retries branch retirement.
    }
    await this.applySettleTaskAction(task.id, projection);
    this.onRunFinished?.(finished);
  }

  /**
   * Map the settling disposition to the retirement cause a Session needs
   * (issue #148): an operator cancel retires immediately; any `completed` Run
   * merged (a Run only completes via merging); every other ending (generic
   * fail, escalate, guardrail-trip, process-death) retains the Task's worktree
   * until its terminal disposition (no deadline by default; a configured TTL
   * can still sweep it).
   */
  private retirementCause(type: DispositionKind, projection: SettleProjection): RetirementCause {
    if (type === 'operator-cancel') return 'operator-cancel';
    if (projection.runState === 'completed') return 'merged';
    return 'other';
  }

  /**
   * Apply the disposition's Task transition. `none` leaves the Task to its
   * caller (operator cancel/complete already moved it). Every other action
   * moves only a Task that is still `working` — or `escalated`, for the
   * operator Accept that merges an escalated ticket (`done`). A Task already
   * in a terminal state (a racing cancel that moved it) makes the action a
   * no-op, so the Run row still settles while the Task keeps the disposition
   * the race already gave it.
   */
  private async applySettleTaskAction(taskId: number, projection: SettleProjection): Promise<void> {
    if (projection.taskAction === 'none') return;
    const state = (await this.taskService.get(taskId)).state;
    if (state !== 'working' && !(state === 'escalated' && projection.taskAction !== 'ready')) return;
    switch (projection.taskAction) {
      case 'done':
        await this.taskService.setState(taskId, 'done');
        break;
      case 'ready':
        await this.taskService.setState(taskId, 'ready');
        break;
      case 'escalate':
        await this.taskService.escalate(taskId, projection.reason ?? 'escalated');
        break;
    }
  }
}

/**
 * The Attempt's terminal state for a settling disposition. `operator-cancel`
 * and `operator-accept` map directly (an operator's own action, whatever the
 * Run/Task projection says); every other kind follows the projection exactly
 * as the prior fact-replay coordinator did: an escalating disposition closes
 * the Attempt `escalated`, else `passed` on a completed Run and `failed`
 * otherwise.
 */
function attemptTerminalState(type: DispositionKind, projection: SettleProjection): Exclude<AttemptState, 'running'> {
  if (type === 'operator-cancel') return 'cancelled';
  if (type === 'operator-accept') return 'passed';
  if (projection.taskAction === 'escalate') return 'escalated';
  return projection.runState === 'completed' ? 'passed' : 'failed';
}
