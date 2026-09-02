import type { TaskRow, AttemptRow, AttemptState } from '../db/schema.js';
import type { TaskService } from './tasks.js';
import type { AttemptStore } from './attempts.js';
import type { SessionRetirementHook } from './session-retirement-coordinator.js';
import type { RetirementCause } from './session-retirement.js';

export interface AttemptBranchRetirementHook {
  onAttemptSettled(task: TaskRow, attempt: AttemptRow): Promise<void>;
}

/** The Attempt's terminal surface disposition (never `running`), before the
 * one operator-escalate exception can still promote it to `escalated`
 * (see {@link attemptTerminalState}): 'completed'/'failed'/'cancelled' map
 * onto AttemptState's 'passed'/'failed'/'cancelled'. */
export type AttemptTerminalState = 'completed' | 'failed' | 'cancelled';

/**
 * What the coordinator does to the owning Task when the Attempt settles. `none`
 * leaves the Task untouched — the operator cancel/force-complete flow already
 * transitioned it through the Task service, so the coordinator must not fight
 * that. `done` merges the ticket, `ready` re-queues it (a transient fault the
 * next pick retries), `escalate` hands it to a human with the reason.
 * Applied only while the Task is still `working` (or `escalated`, for the
 * operator Accept that merges from there); a racing cancel that already moved
 * it wins.
 */
export type SettleTaskAction = 'done' | 'escalate' | 'ready' | 'none';

/** The terminal projection a disposition intends for the Attempt/Task. */
export interface SettleProjection {
  runState: AttemptTerminalState;
  taskAction: SettleTaskAction;
  reason: string | null;
}

/** Every ending-signal kind `settle` can be called with — persisted verbatim to `attempts.reason`. */
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
 * The single terminal-disposition coordinator: every way an Attempt reaches a
 * terminal disposition funnels through {@link AttemptSettleCoordinator.settle},
 * a guarded state transition. `operator-cancel` / `operator-accept` may act on
 * an Attempt that already settled `escalated`; every other disposition is
 * first-writer-wins — a second racing settle on an already-terminal Attempt is
 * a no-op.
 */
export class AttemptSettleCoordinator {
  constructor(
    private readonly taskService: TaskService,
    private readonly attempts: AttemptStore,
    private readonly onAttemptFinished?: (attempt: AttemptRow) => void,
    private readonly sessionRetirement?: SessionRetirementHook,
    private readonly branchRetirement?: AttemptBranchRetirementHook,
  ) {}

  /**
   * Settle `attempt` to `projection`'s terminal disposition under `type`'s
   * guard. No-ops when the Attempt is already settled and `type` is not an
   * operator override. `patch` rides with the write.
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
    if (!movable) return;

    const finished = await this.attempts.updateWithFrozenCost(attempt.id, {
      ...patch,
      state: attemptTerminalState(type, projection),
      reason: type,
      detail: projection.reason,
      endedAt: before.endedAt ?? Date.now(),
    });

    try {
      await this.sessionRetirement?.onAttemptSettled(finished, this.retirementCause(type, projection));
    } catch {
    }
    try {
      await this.branchRetirement?.onAttemptSettled(task, finished);
    } catch {
    }
    await this.applySettleTaskAction(task.id, projection);
    this.onAttemptFinished?.(finished);
  }

  private retirementCause(type: DispositionKind, projection: SettleProjection): RetirementCause {
    if (type === 'operator-cancel') return 'operator-cancel';
    if (projection.runState === 'completed') return 'merged';
    return 'other';
  }

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

function attemptTerminalState(type: DispositionKind, projection: SettleProjection): Exclude<AttemptState, 'running'> {
  if (type === 'operator-cancel') return 'cancelled';
  if (type === 'operator-accept') return 'passed';
  if (projection.taskAction === 'escalate') return 'escalated';
  return projection.runState === 'completed' ? 'passed' : 'failed';
}
