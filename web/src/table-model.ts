// Explicit .js extensions: this module is shared with the node-side test
// project, whose nodenext resolution requires them (Vite maps .js → .ts).
import type { Task } from './types.js';
import { request } from './api.js';

/** The table's current filter + sort selections, scoped to a Workspace. */
export type TableQuery = {
  workspaceId: number;
  state: string;
  harness: string;
  priority: string;
  sortBy: string;
  order: string;
};

/** Build the `/api/tasks` query string for the table's current selections.
 * Empty filter strings are omitted so they don't over-constrain the request. */
export function tasksQuery(q: TableQuery): string {
  const params = new URLSearchParams();
  params.set('workspaceId', String(q.workspaceId));
  if (q.state) params.set('state', q.state);
  if (q.harness) params.set('harness', q.harness);
  if (q.priority) params.set('priority', q.priority);
  params.set('sortBy', q.sortBy);
  params.set('order', q.order);
  return params.toString();
}

/** Fetch the task list for the table through the shared api transport, so a
 * non-OK response throws with the server's real message (issue #91) — the same
 * error path every other call in `api.ts` takes — instead of being parsed as
 * data and bricking the view on a `body.tasks` that isn't there. */
export async function fetchTasks(q: TableQuery): Promise<Task[]> {
  const { tasks } = await request<{ tasks: Task[] }>('GET', `/api/tasks?${tasksQuery(q)}`);
  return tasks;
}
