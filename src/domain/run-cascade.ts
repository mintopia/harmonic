import { inArray } from 'drizzle-orm';
import type { AsyncTx } from '../db/async.js';
import {
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
 * statement awaited. Deletes a Task's whole Attempt timeline together with
 * every row that references it (issue #162): `steps`, and the Attempt-keyed
 * satellites `verification_attempts`, `guardrail_events`, `attempt_tool_calls`,
 * `attempt_events` (ADR-0001 #388 S-F), plus the non-FK-declared scoped
 * `api_keys` rows that would otherwise dangle once their Attempt is gone
 * (folded from the legacy `runs`-scoped key at ADR-0001 #388 S-G), then the
 * `attempts` rows themselves (their own FK to `tasks.id` would otherwise
 * block the Task delete under runtime FK enforcement, ADR-0007). This is the
 * one place the Task-owned child set is enumerated, so both
 * `TaskService.delete` (a Task's Attempts) and `WorkspaceService.delete` (a
 * whole Workspace's Attempts) stay in step and a new FK-to-`attempts`/`tasks`
 * table is added in exactly one spot. Sessions (a *parent* of an Attempt) are
 * deliberately not touched here — each caller decides that, since a Session
 * can be shared across sibling Attempts. No-op when `taskIds` is empty.
 */
export async function deleteAttemptsAndChildrenAsync(tx: AsyncTx, taskIds: number[]): Promise<void> {
  if (taskIds.length === 0) return;
  const attemptIds = (
    await tx.select({ id: attempts.id }).from(attempts).where(inArray(attempts.taskId, taskIds)).all()
  ).map((r) => r.id);
  if (attemptIds.length > 0) {
    await tx.delete(steps).where(inArray(steps.attemptId, attemptIds)).run();
    await tx.delete(attemptToolCalls).where(inArray(attemptToolCalls.attemptId, attemptIds)).run();
    await tx.delete(attemptEvents).where(inArray(attemptEvents.attemptId, attemptIds)).run();
    await tx.delete(verificationAttempts).where(inArray(verificationAttempts.attemptId, attemptIds)).run();
    await tx.delete(guardrailEvents).where(inArray(guardrailEvents.attemptId, attemptIds)).run();
    // Not FK-declared, but a scoped Attempt key otherwise dangles once its Attempt is gone.
    await tx.delete(apiKeys).where(inArray(apiKeys.attemptId, attemptIds)).run();
    await tx.delete(attempts).where(inArray(attempts.id, attemptIds)).run();
  }
}
