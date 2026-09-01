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
 * Delete a Task's whole Attempt timeline together with every row that
 * references it, child-before-parent, inside an async transaction. Sessions
 * (a parent of an Attempt) are not touched here — a Session can be shared
 * across sibling Attempts, so each caller decides. No-op when `taskIds` is empty.
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
    await tx.delete(apiKeys).where(inArray(apiKeys.attemptId, attemptIds)).run();
    await tx.delete(attempts).where(inArray(attempts.id, attemptIds)).run();
  }
}
