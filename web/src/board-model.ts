// Explicit .js extensions: this module is shared with the node-side test
// project, whose nodenext resolution requires them (Vite maps .js → .ts).
import type { Task, TaskState } from './types.js';
import { TASK_STATES } from './types.js';

/**
 * Hybrid rail treatment (DESIGN.md § The Board, decided by issue 20):
 * pipeline columns stay expanded, terminal columns collapse to rails.
 * Every state always yields a column so the board's geometry never
 * shifts as tasks move — the operator's glance targets stay put.
 */
export const TERMINAL_STATES = ['completed', 'failed', 'cancelled'] as const satisfies readonly TaskState[];
export const ACTIVE_STATES = TASK_STATES.filter(
  (s): s is Exclude<TaskState, (typeof TERMINAL_STATES)[number]> =>
    !(TERMINAL_STATES as readonly TaskState[]).includes(s),
);

export interface BoardColumn {
  state: TaskState;
  terminal: boolean;
  tasks: Task[];
}

// Cards stack in the order the scheduler will process them (issue: board
// ordering): highest priority first, then lowest id first as a stable
// tiebreak. Mirrors the server's priority rank in src/domain/tasks.ts.
const PRIORITY_RANK: Record<Task['priority'], number> = { high: 0, normal: 1, low: 2 };

function byProcessingOrder(a: Task, b: Task): number {
  return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.id - b.id;
}

// Terminal columns have no scheduler order to honour, so they read newest-first:
// the task that reached its terminal state most recently sits at the top (its
// `updatedAt` is that transition). id descending is the stable tiebreak.
function byRecencyDesc(a: Task, b: Task): number {
  return b.updatedAt - a.updatedAt || b.id - a.id;
}

export function boardColumns(tasks: Task[]): BoardColumn[] {
  return TASK_STATES.map((state) => {
    const terminal = (TERMINAL_STATES as readonly TaskState[]).includes(state);
    return {
      state,
      terminal,
      tasks: tasks.filter((t) => t.state === state).sort(terminal ? byRecencyDesc : byProcessingOrder),
    };
  });
}

/**
 * The action a drag-and-drop from one column to another maps to (issue #58),
 * or null when the drop is invalid and the card should snap back. Only the
 * side-effect-free transitions drag: promote/requeue/uncancel land on Ready,
 * cancel lands on Cancelled. The side-effectful gates (accept/reject, starting
 * a run) stay button-only, so any drop onto their columns is a no-op.
 */
export type DropAction = 'promote' | 'requeue' | 'uncancel' | 'cancel';

// Cancel by drag only where DESIGN.md § Buttons ("Cancel is not a gate action")
// lets the interface offer it: a Task that has produced nothing to judge
// (draft/blocked/ready) or is still producing it (running). awaiting-review is
// a gate — its cancel lives inside Reject, never as a peer action — so a drop
// there snaps back. The API stays permissive; the interface simply doesn't.
const CANCEL_BY_DRAG: readonly TaskState[] = ['draft', 'blocked', 'ready', 'running'];

export function dropAction(from: TaskState, to: TaskState): DropAction | null {
  if (from === to) return null;
  if (to === 'ready') {
    if (from === 'draft') return 'promote';
    if (from === 'failed') return 'requeue';
    if (from === 'cancelled') return 'uncancel';
  }
  if (to === 'cancelled' && CANCEL_BY_DRAG.includes(from)) return 'cancel';
  return null;
}

/** A card is draggable when at least one column is a valid drop for it —
 * true for every state except completed (a completed task has no drag move). */
export function canDrag(from: TaskState): boolean {
  return TASK_STATES.some((to) => dropAction(from, to) !== null);
}
