// Explicit .js extension: this module is shared with the node-side test
// project, whose nodenext resolution requires it (Vite maps .js → .ts).
import type { TaskState } from './types.js';

/**
 * The operator actions the TaskDetail footer and TaskCard offer in a given
 * state. Order is display order (left to right). completed offers nothing,
 * which hides the action bar entirely.
 */
export type TaskAction = 'accept' | 'reject' | 'reattempt' | 'run' | 'ready' | 'edit' | 'cancel' | 'uncancel';

export function taskActions(state: TaskState): TaskAction[] {
  switch (state) {
    // The gate is the two review verbs, Accept last so the affirmative sits in
    // the strongest (terminal) position. Cancelling an awaiting-review task is
    // a disposition inside the Reject dialog, not a peer of the gate: the work
    // exists and wants a verdict, and a Cancel button here would sit beside
    // Reject looking identical while meaning something else.
    case 'awaiting-review':
      return ['reject', 'accept'];
    case 'failed':
      return ['reattempt', 'cancel'];
    case 'ready':
      return ['run', 'edit', 'cancel'];
    case 'draft':
      return ['ready', 'edit', 'cancel'];
    // Blocked can still be edited — re-point its model/harness while it waits
    // on a dependency (ADR-0012) — but not run; running can only be cancelled.
    case 'blocked':
      return ['edit', 'cancel'];
    case 'running':
      return ['cancel'];
    // Uncancel returns the card to the queue in place (issue #57).
    case 'cancelled':
      return ['uncancel'];
    case 'completed':
      return [];
  }
  // A state from a server ahead of this bundle (version skew): offer
  // nothing rather than crash the modal on `.length` of undefined.
  return [];
}
