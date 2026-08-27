// Explicit .js extension: this module is shared with the node-side test
// project, whose nodenext resolution requires it (Vite maps .js → .ts).
import type { Task, TaskState } from './types.js';

/**
 * The operator actions the TaskDetail footer and TaskCard offer in a given
 * state (ADR-0041). Order is display order (left to right).
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
    // The one human surface: exactly the three escalation actions, Accept last
    // so the affirmative sits in the strongest (terminal) position, Close first
    // among them as the destructive disposition. Delete (issue #162, ADR-0025)
    // is a permanent, rare escape hatch that sits before them, out of the flow.
    case 'escalated':
      return ['delete', 'close', 'reject', 'accept'];
    case 'ready':
      return ['delete', 'run', 'edit', 'cancel'];
    case 'draft':
      return ['delete', 'ready', 'edit', 'cancel'];
    // Complete is an operator override (stop the agent, mark it done); Cancel
    // keeps its familiar rightmost destructive slot. No delete while working
    // (issue #162) — the same guard the server enforces (409).
    case 'working':
      return ['complete', 'cancel'];
    // Uncancel returns the card to the queue in place (issue #57).
    case 'cancelled':
      return ['delete', 'uncancel'];
    case 'done':
      return ['delete'];
  }
  // A state from a server ahead of this bundle (version skew): offer
  // nothing rather than crash the modal on `.length` of undefined.
  return [];
}

export interface EscalationActions {
  /** Accept merges the verified branch head, so it needs one. */
  accept: boolean;
  reject: boolean;
  close: boolean;
}

/** Which of the three escalation actions an escalated ticket can take right now; null off the surface. */
export function escalationActions(task: Pick<Task, 'candidateRef' | 'state'>): EscalationActions | null {
  if (task.state !== 'escalated') return null;
  return { accept: task.candidateRef !== null, reject: true, close: true };
}
