import type { TaskState } from '../db/schema.js';

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
