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

export function boardColumns(tasks: Task[]): BoardColumn[] {
  return TASK_STATES.map((state) => ({
    state,
    terminal: (TERMINAL_STATES as readonly TaskState[]).includes(state),
    tasks: tasks.filter((t) => t.state === state).sort((a, b) => b.createdAt - a.createdAt),
  }));
}
