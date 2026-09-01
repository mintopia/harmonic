// Explicit .js extensions: this module is shared with the node-side test
// project, whose nodenext resolution requires them (Vite maps .js → .ts).
import { TERMINAL_STATES } from './task-state-model.js';
import { VIEWS, type View } from './rail-model.js';
import { TASK_STATES, type TaskState } from './types.js';

/** Table sort keys. TableView imports `SortKey` from here as its single source. */
export const SORT_KEYS = ['createdAt', 'updatedAt', 'priority', 'cost'] as const;
export type SortKey = (typeof SORT_KEYS)[number];

/** Harnesses the Table's filter offers — the only values a `harness` param may hold. */
export const TABLE_HARNESSES = ['claude', 'codex', 'copilot'] as const;
/** Priorities the Table's filter offers — the only values a `priority` param may hold. */
export const TABLE_PRIORITIES = ['high', 'normal', 'low'] as const;

/** The Table view's filter + sort selection. Each filter is multi-select
 *: an empty array means "all"; a non-empty array
 * matches any of its values. */
export interface TableFilters {
  state: string[];
  harness: string[];
  priority: string[];
  /** Free-text search over prompt text. Empty means "no search". */
  search: string;
  sortBy: SortKey;
  order: 'asc' | 'desc';
}

export const DEFAULT_TABLE_FILTERS: TableFilters = {
  state: [],
  harness: [],
  priority: [],
  search: '',
  sortBy: 'createdAt',
  order: 'desc',
};

/** A full app location: active view plus every view's persisted state. */
export interface Route {
  view: View;
  /**
   * The focused Ticket: `null` when on a view, or the Task id when
   * the pathname is `/task/:id`. Lives in the pathname, not the query, but the
   * Route still carries the underlying `view`/`table`/`peeked` so returning
   * restores exactly where the operator was.
   */
  task: number | null;
  /**
   * The focused Epic: `null` when on a view, or the Epic ref when the
   * pathname is `/epic/:ref`. Opens the Epic summary page; mutually exclusive
   * with `task` (both live in the pathname, one path at a time).
   */
  epic: number | null;
  /** Deck terminal columns the operator has peeked open. */
  peeked: TaskState[];
  table: TableFilters;
}

export const DEFAULT_ROUTE: Route = {
  view: 'board',
  task: null,
  epic: null,
  peeked: [],
  table: DEFAULT_TABLE_FILTERS,
};

const PARAM = {
  view: 'view',
  peek: 'peek',
  state: 'state',
  harness: 'harness',
  priority: 'priority',
  q: 'q',
  sort: 'sort',
  order: 'order',
} as const;

const isView = (v: string | null): v is View => v !== null && (VIEWS as readonly string[]).includes(v);
const csvValues = (raw: string, allowed: readonly string[]): string[] => {
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const v = part.trim();
    if (v && allowed.includes(v) && !out.includes(v)) out.push(v);
  }
  return out;
};
const isPeekable = (v: string): v is TaskState => (TERMINAL_STATES as readonly string[]).includes(v);
const isSortKey = (v: string | null): v is SortKey => v !== null && (SORT_KEYS as readonly string[]).includes(v);

const TASK_PATH = /^\/task\/(\d+)\/?$/;
const EPIC_PATH = /^\/epic\/(\d+)\/?$/;

function queryOf(input: string): string {
  const q = input.indexOf('?');
  return q >= 0 ? input.slice(q + 1) : input;
}

/**
 * Parse a pathname + query string into a {@link Route}. Every field is validated
 * against its allowed set; anything unrecognized falls back to its default, so a
 * malformed or stale link never produces an invalid view, filter, or Ticket id.
 */
export function parseRoute(pathname: string, search: string): Route {
  const params = new URLSearchParams(queryOf(search));

  const rawView = params.get(PARAM.view);
  const view: View = isView(rawView) ? rawView : 'board';

  const taskMatch = TASK_PATH.exec(pathname);
  const taskId = taskMatch ? Number(taskMatch[1]) : NaN;
  const task = taskMatch && Number.isSafeInteger(taskId) && taskId > 0 ? taskId : null;

  const epicMatch = EPIC_PATH.exec(pathname);
  const epicRef = epicMatch ? Number(epicMatch[1]) : NaN;
  const epic = epicMatch && Number.isSafeInteger(epicRef) && epicRef > 0 ? epicRef : null;

  const peeked: TaskState[] = [];
  for (const raw of (params.get(PARAM.peek) ?? '').split(',')) {
    const s = raw.trim();
    if (s && isPeekable(s) && !peeked.includes(s)) peeked.push(s);
  }

  const rawOrder = params.get(PARAM.order);

  const table: TableFilters = {
    state: csvValues(params.get(PARAM.state) ?? '', TASK_STATES),
    harness: csvValues(params.get(PARAM.harness) ?? '', TABLE_HARNESSES),
    priority: csvValues(params.get(PARAM.priority) ?? '', TABLE_PRIORITIES),
    search: params.get(PARAM.q) ?? '',
    sortBy: isSortKey(params.get(PARAM.sort)) ? (params.get(PARAM.sort) as SortKey) : 'createdAt',
    order: rawOrder === 'asc' ? 'asc' : 'desc',
  };

  return { view, task, epic, peeked, table };
}

/**
 * Serialize a {@link Route} to a relative URL: `/task/:id` when a Ticket is
 * focused, else `/` — plus a query string carrying the non-default view/peek/table
 * state (omitted entirely for the all-default board route, giving the clean `/`
 * URL). `peek` states are emitted in TASK_STATES order so equal routes serialize
 * identically (stable round-trip / bookmarks).
 */
export function serializeRoute(route: Route): string {
  const params = new URLSearchParams();

  if (route.view !== 'board') params.set(PARAM.view, route.view);

  const peekSet = new Set(route.peeked);
  const peek = TASK_STATES.filter((s) => peekSet.has(s));
  if (peek.length > 0) params.set(PARAM.peek, peek.join(','));

  const t = route.table;
  if (t.state.length > 0) params.set(PARAM.state, t.state.join(','));
  if (t.harness.length > 0) params.set(PARAM.harness, t.harness.join(','));
  if (t.priority.length > 0) params.set(PARAM.priority, t.priority.join(','));
  if (t.search) params.set(PARAM.q, t.search);
  if (t.sortBy !== 'createdAt') params.set(PARAM.sort, t.sortBy);
  if (t.order !== 'desc') params.set(PARAM.order, t.order);

  const query = params.toString();
  const base = route.task !== null ? `/task/${route.task}` : route.epic !== null ? `/epic/${route.epic}` : '/';
  return query ? `${base}?${query}` : base;
}
