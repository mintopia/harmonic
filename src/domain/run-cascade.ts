import { inArray } from 'drizzle-orm';
import type { AsyncTx } from '../db/async.js';
import {
  runs,
  attempts,
  steps,
  attemptToolCalls,
  attemptEvents,
  verificationAttempts,
  guardrailEvents,
  apiKeys,
} from '../db/schema.js';

/**
 * The async twin of the (now-removed) sync cascade helper, run inside an async
 * `Db.transaction` (ADR-0029) — child-before-parent deletion order, every
 * statement awaited. Deletes a set of Runs together with every row that
 * references them (issue #162), plus the Tasks' whole Attempt timeline
 * (`steps`, and the Attempt-keyed satellites `verification_attempts`,
 * `guardrail_events`, `attempt_tool_calls`, `attempt_events` — ADR-0001 #388
 * S-F: those four are keyed off `attempt_id`, not `run_id`, so purging them
 * for a deleted Task means resolving that Task's Attempt rows first), plus
 * the `attempts` rows themselves (their own FK to `tasks.id` would otherwise
 * block the Task delete under runtime FK enforcement, ADR-0007) — plus the
 * non-FK scoped `api_keys` rows that would otherwise dangle once their Run is
 * gone, then the `runs` themselves. This is the one place the Task-owned
 * child set is enumerated, so both `TaskService.delete` (a Task's Runs) and
 * `WorkspaceService.delete` (a whole Workspace's Runs) stay in step and a new
 * FK-to-`runs`/`attempts`/`tasks` table is added in exactly one spot.
 * Sessions (a *parent* of a Run) are deliberately not touched here — each
 * caller decides that, since a Session can be shared across sibling Runs.
 * No-op when both `taskIds` and `runIds` are empty.
 */
export async function deleteRunsAndChildrenAsync(tx: AsyncTx, taskIds: number[], runIds: number[]): Promise<void> {
  if (taskIds.length === 0 && runIds.length === 0) return;
  if (taskIds.length > 0) {
    const attemptIds = (
      await tx.select({ id: attempts.id }).from(attempts).where(inArray(attempts.taskId, taskIds)).all()
    ).map((r) => r.id);
    if (attemptIds.length > 0) {
      await tx.delete(steps).where(inArray(steps.attemptId, attemptIds)).run();
      await tx.delete(attemptToolCalls).where(inArray(attemptToolCalls.attemptId, attemptIds)).run();
      await tx.delete(attemptEvents).where(inArray(attemptEvents.attemptId, attemptIds)).run();
      await tx.delete(verificationAttempts).where(inArray(verificationAttempts.attemptId, attemptIds)).run();
      await tx.delete(guardrailEvents).where(inArray(guardrailEvents.attemptId, attemptIds)).run();
      await tx.delete(attempts).where(inArray(attempts.id, attemptIds)).run();
    }
  }
  if (runIds.length > 0) {
    // Not FK-declared, but a scoped Run key otherwise dangles once its Run is gone.
    await tx.delete(apiKeys).where(inArray(apiKeys.runId, runIds)).run();
    await tx.delete(runs).where(inArray(runs.id, runIds)).run();
  }
}
