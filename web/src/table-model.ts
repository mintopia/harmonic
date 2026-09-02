// Explicit .js extensions: this module is shared with the node-side test
// project, whose nodenext resolution requires them (Vite maps .js → .ts).
import type { Task } from './types.js';
import { request } from './api.js';

/** Rows the table requests per page: the server slices the page and
 * reports the full match `total`, so the DOM stays bounded on a large history
 * without pulling the whole corpus into the browser. */
export const TABLE_PAGE_SIZE = 50;

/** The table's current filter + search + sort selections, plus the page window,
 * scoped to a Workspace — everything the server needs to return one page. */
export type TableQuery = {
  workspaceId: number;
  /** Multi-select filters (empty ⇒ "all"); sent to the server as one CSV param each. */
  state: string[];
  harness: string[];
  priority: string[];
  /** Server-side substring search over prompt + tracker title; blank ⇒ no search. */
  q: string;
  sortBy: string;
  order: string;
  limit: number;
  offset: number;
};

/** Build the `/api/tasks` query string for the table's current selections.
 * Empty filter lists (and a blank search) are omitted so they don't
 * over-constrain the request; a multi-select filter goes as one CSV param. */
export function tasksQuery(q: TableQuery): string {
  const params = new URLSearchParams();
  params.set('workspaceId', String(q.workspaceId));
  if (q.state.length > 0) params.set('state', q.state.join(','));
  if (q.harness.length > 0) params.set('harness', q.harness.join(','));
  if (q.priority.length > 0) params.set('priority', q.priority.join(','));
  if (q.q.trim()) params.set('q', q.q.trim());
  params.set('sortBy', q.sortBy);
  params.set('order', q.order);
  params.set('limit', String(q.limit));
  params.set('offset', String(q.offset));
  params.set('epics', 'true');
  return params.toString();
}

/** Fetch one page of tasks for the table through the shared api transport, so a
 * non-OK response throws with the server's real message — the same
 * error path every other call in `api.ts` takes. Returns the page plus the
 * server's filtered `total`, which drives the pager. */
export async function fetchTasks(q: TableQuery): Promise<{ tasks: Task[]; total: number }> {
  return request<{ tasks: Task[]; total: number }>('GET', `/api/tasks?${tasksQuery(q)}`);
}
