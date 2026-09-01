// Explicit .js extension: this module is shared with the node-side test
// project, whose nodenext resolution requires it (Vite maps .js → .ts).
import type { Task, TaskState } from './types.js';

/**
 * The operator actions the TaskDetail footer and TaskCard offer in a given
 * state. Order is display order (left to right).
 */
export type TaskAction =
  | 'accept'
  | 'reject'
  | 'close'
  | 'run'
  | 'ready'
  | 'edit'
  | 'complete'
  | 'cancel'
  | 'uncancel'
  | 'delete';

export function taskActions(state: TaskState): TaskAction[] {
  switch (state) {
    case 'escalated':
      return ['delete', 'close', 'reject', 'accept'];
    case 'ready':
      return ['delete', 'run', 'edit', 'cancel'];
    case 'draft':
      return ['delete', 'ready', 'edit', 'cancel'];
    case 'working':
      return ['complete', 'cancel'];
    case 'cancelled':
      return ['delete', 'uncancel'];
    case 'done':
      return ['delete'];
  }
  return [];
}

export interface EscalationActions {
  /** Accept merges the branch's candidate, so it needs one (commits ahead of base). */
  accept: boolean;
  reject: boolean;
  close: boolean;
}

/** Which of the three escalation actions an escalated ticket can take right now; null off the surface. */
export function escalationActions(task: Pick<Task, 'hasCandidate' | 'state'>): EscalationActions | null {
  if (task.state !== 'escalated') return null;
  return { accept: task.hasCandidate, reject: true, close: true };
}
