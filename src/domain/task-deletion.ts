import type { TaskState } from '../db/schema.js';
/**
 * The hard-delete decision (issue #162, ADR-0025).
 *
 * A pure decision: given a Task's shape, may it be deleted, and if so does the
 * delete also need to write a tracker-dismissal tombstone? No database, no
 * clock — `TaskService.delete` is the only caller, and it does the actual
 * cascade + tombstone insert around this seam's answer, keeping the guard and
 * the mirrored-vs-native branch exhaustively unit-testable in isolation (the
 * same seam style as `run-disposition.ts` / `session-resume.ts`).
 *
 * Delete is guarded to a Task that is **not currently working** — the same
 * guard `WorkspaceService.delete` applies to a Workspace with a working Task.
 * A mirrored Task additionally needs a tombstone on `(workspaceId,
 * trackerRef)` so a later poll doesn't resurrect the deleted row (ADR-0025);
 * a native Task never does, since nothing re-creates it.
 */

/** The facet of a Task this decision reads. Structurally assignable from a
 * `TaskRow`/`RawTaskRow`, so callers pass either directly. */
export interface DeletableTaskFacts {
  state: TaskState;
  origin: string;
  trackerRef: number | null;
  workspaceId: number | null;
}

export interface DeletionDecision {
  ok: boolean;
  /** Set when `ok` is false: the reason the delete was refused. */
  reason?: string;
  /** Set when `ok` is true and a mirrored ref must be tombstoned so a re-poll
   * can't resurrect it; null for a native Task or one with no tracker ref. */
  tombstone: { workspaceId: number | null; trackerRef: number } | null;
}

export function decideTaskDeletion(task: DeletableTaskFacts): DeletionDecision {
  if (task.state === 'working') {
    return { ok: false, reason: 'task is working; stop it before deleting', tombstone: null };
  }
  const tombstone =
    task.origin === 'mirrored' && task.trackerRef != null
      ? { workspaceId: task.workspaceId, trackerRef: task.trackerRef }
      : null;
  return { ok: true, tombstone };
}
