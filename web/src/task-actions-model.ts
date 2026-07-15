// Explicit .js extension: this module is shared with the node-side test
// project, whose nodenext resolution requires it (Vite maps .js → .ts).
import type { TaskState } from './types.js';

/**
 * The operator actions the TaskDetail footer offers in a given state.
 * Order is display order (left to right). Terminal states offer nothing,
 * which hides the action bar entirely. (TaskCard still hand-rolls its own
 * buttons; sharing this map with the card is a future consolidation.)
 */
export type TaskAction = 'accept' | 'reject' | 'reattempt' | 'run' | 'ready' | 'edit' | 'cancel';

export function taskActions(state: TaskState): TaskAction[] {
  switch (state) {
    case 'awaiting-review':
      return ['accept', 'reject', 'cancel'];
    case 'failed':
      return ['reattempt', 'cancel'];
    case 'ready':
      return ['run', 'edit', 'cancel'];
    case 'draft':
      return ['ready', 'edit', 'cancel'];
    case 'running':
    case 'blocked':
      return ['cancel'];
    case 'completed':
    case 'cancelled':
      return [];
  }
  // A state from a server ahead of this bundle (version skew): offer
  // nothing rather than crash the modal on `.length` of undefined.
  return [];
}
