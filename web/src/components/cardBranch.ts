import type { Task } from '../types.js';

/** The branch a card should show: only once a Task is awaiting-review, and
 * only when it has one (direct mode, or no run yet, renders nothing). */
export function cardBranch(task: Pick<Task, 'state' | 'branch'>): string | null {
  return task.state === 'awaiting-review' ? task.branch : null;
}

/** The compact `+142 −38` a card shows beside the branch, parsed from the
 * run's `git diff --stat` summary line. Null (render nothing — no `+0 −0`) when
 * the stat is unavailable/not-yet-computed, or reports no line changes. Only
 * shown once awaiting-review, mirroring {@link cardBranch}. */
export function cardDiffstat(task: Pick<Task, 'state' | 'stat'>): { added: number; removed: number } | null {
  if (task.state !== 'awaiting-review' || !task.stat) return null;
  const added = Number(task.stat.match(/(\d+) insertions?\(\+\)/)?.[1] ?? 0);
  const removed = Number(task.stat.match(/(\d+) deletions?\(-\)/)?.[1] ?? 0);
  return added || removed ? { added, removed } : null;
}
