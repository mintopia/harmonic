import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { AsyncTx } from '../db/async.js';
import {
  attempts,
  attemptToolCalls,
  attemptEvents,
  workflowStepRuns,
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
  await tx.delete(workflowStepRuns).where(inArray(workflowStepRuns.taskId, taskIds)).run();
  await deleteAttemptRowsAsync(tx, attemptIds);
}

/** Delete a Workspace's Epic-owned Attempts (no `task_id`) and their child rows. */
export async function deleteEpicAttemptsAndChildrenAsync(tx: AsyncTx, workspaceId: number): Promise<void> {
  const attemptIds = (
    await tx
      .select({ id: attempts.id })
      .from(attempts)
      .where(and(eq(attempts.workspaceId, workspaceId), isNull(attempts.taskId)))
      .all()
  ).map((r) => r.id);
  await tx.delete(workflowStepRuns).where(and(eq(workflowStepRuns.workspaceId, workspaceId), isNull(workflowStepRuns.taskId))).run();
  await deleteAttemptRowsAsync(tx, attemptIds);
}

async function deleteAttemptRowsAsync(tx: AsyncTx, attemptIds: number[]): Promise<void> {
  if (attemptIds.length === 0) return;
  await tx.delete(workflowStepRuns).where(inArray(workflowStepRuns.attemptId, attemptIds)).run();
  await tx.delete(attemptToolCalls).where(inArray(attemptToolCalls.attemptId, attemptIds)).run();
  await tx.delete(attemptEvents).where(inArray(attemptEvents.attemptId, attemptIds)).run();
  await tx.delete(guardrailEvents).where(inArray(guardrailEvents.attemptId, attemptIds)).run();
  await tx.delete(apiKeys).where(inArray(apiKeys.attemptId, attemptIds)).run();
  await tx.delete(attempts).where(inArray(attempts.id, attemptIds)).run();
}
