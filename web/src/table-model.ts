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

/** Case-insensitive substring filter of the fetched task list by prompt text
 * (issue #104). A blank/whitespace query matches everything — the "no search"
 * state — so the caller can pass the raw input box value straight through. */
export function filterBySearch(tasks: Task[], query: string): Task[] {
  const q = query.trim().toLowerCase();
  if (!q) return tasks;
  return tasks.filter((t) => t.prompt.toLowerCase().includes(q));
}

/** Rows shown per page (issue #104): keeps the DOM bounded on a large terminal
 * history without pulling in a virtualiser. */
export const TABLE_PAGE_SIZE = 50;

/** One page of a client-side list: the visible slice plus the clamped position. */
export interface Page<T> {
  items: T[];
  /** 1-based, clamped into [1, pageCount]. */
  page: number;
  /** Total pages, always >= 1 (an empty list is one empty page). */
  pageCount: number;
  /** Length of the full (pre-slice) list. */
  total: number;
}

/** Slice `items` to a 1-based page of `size`, clamping an out-of-range page into
 * [1, pageCount] so a filter/search change that shrinks the list can never
 * strand the view on an empty page past the end. */
export function paginate<T>(items: T[], page: number, size: number = TABLE_PAGE_SIZE): Page<T> {
  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / size));
  const clamped = Math.min(Math.max(1, Math.floor(page) || 1), pageCount);
  const start = (clamped - 1) * size;
  return { items: items.slice(start, start + size), page: clamped, pageCount, total };
}
