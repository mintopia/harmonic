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

const PRIORITY_RANK: Record<Task['priority'], number> = { high: 0, normal: 1, low: 2 };

// Queue columns (draft/blocked/ready) stack in the order the scheduler will
// reach them (issue: board ordering): highest priority first, then oldest
// created first so the longest-waiting task of a priority sits on top; id
// ascending is the final stable tiebreak. Mirrors the server's
// priority-then-createdAt sort in src/domain/tasks.ts.
const QUEUE_STATES: readonly TaskState[] = ['draft', 'blocked', 'ready'];

function byQueueOrder(a: Task, b: Task): number {
  return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.createdAt - b.createdAt || a.id - b.id;
}

// Running / awaiting-review are in-flight, not a waiting queue: highest priority
// first, then lowest id as a stable tiebreak.
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
    const compare = terminal ? byRecencyDesc : QUEUE_STATES.includes(state) ? byQueueOrder : byProcessingOrder;
    return {
      state,
      terminal,
      tasks: tasks.filter((t) => t.state === state).sort(compare),
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
// lets the interface offer it: a Task that has produced nothing to judge —
// draft/blocked/ready. A *running* Task is deliberately excluded (issue #98):
// a drag has no armed confirm, and a stray drop must never SIGKILL a working
// agent. Cancelling a run is the armed two-step Cancel button on the card /
// detail, not a drag. awaiting-review is a gate — its cancel lives inside
// Reject, never as a peer action — so a drop there snaps back too. The API
// stays permissive; the interface simply doesn't offer the unguarded path.
const CANCEL_BY_DRAG: readonly TaskState[] = ['draft', 'blocked', 'ready'];

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

/** Elapsed as "1h 2m" / "3m 4s" / "5s" — the board card's live figure, matching the Activity view (issue #100). */
export function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

/** The board card's running readout: elapsed + tool count (issue #100). */
export type RunningReadout = { elapsed: string; tools: number };

/** The board card's running readout (issue #100): elapsed since the run started plus its tool count, or null when the Task isn't a live run. `now` is the client's once-a-second tick. `liveTools`, when given, overrides the server-snapshotted `task.toolCount` with the `run_usage` firehose's freshest count for this run. */
export function runningReadout(task: Task, now: number, liveTools?: number | null): RunningReadout | null {
  if (task.state !== 'running' || task.runStartedAt == null) return null;
  return { elapsed: fmtElapsed(Math.max(0, now - task.runStartedAt)), tools: liveTools ?? task.toolCount ?? 0 };
}
