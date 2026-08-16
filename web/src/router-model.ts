// Explicit .js extensions: this module is shared with the node-side test
// project, whose nodenext resolution requires them (Vite maps .js → .ts).
import { TERMINAL_STATES } from './board-model.js';
import { VIEWS, type View } from './rail-model.js';
import { TASK_STATES, type TaskState } from './types.js';

/**
 * Client routing (issue #103): the active view and its per-view filter/sort/peek
 * state live in the URL's query string, so a side-monitor view is bookmarkable,
 * a refresh restores where the operator was, and the browser Back button steps
 * between views instead of leaving the app. This module is the pure, testable
 * seam — parse a query string into a {@link Route}, serialize a Route back — with
 * the React history glue kept in App.tsx.
 *
 * The URL is the source of truth for the *active* view, but a Route carries every
 * view's state at once (board peek + table filters), so the query string fully
 * describes the app location and one URL restores all of it. Unknown or malformed
 * params fall back to defaults rather than throwing: a hand-edited or stale link
 * lands somewhere sane, never on a blank screen.
 */

/** Table sort keys. TableView imports `SortKey` from here as its single source. */
export const SORT_KEYS = ['createdAt', 'priority', 'cost'] as const;
export type SortKey = (typeof SORT_KEYS)[number];

/** Harnesses the Table's filter offers — the only values a `harness` param may hold. */
export const TABLE_HARNESSES = ['claude', 'codex', 'copilot'] as const;
/** Priorities the Table's filter offers — the only values a `priority` param may hold. */
export const TABLE_PRIORITIES = ['high', 'normal', 'low'] as const;

/** The Table view's filter + sort selection. Empty string means "all" for a filter. */
export interface TableFilters {
  state: string;
  harness: string;
  priority: string;
  /** Free-text search over prompt text (issue #104). Empty means "no search". */
  search: string;
  sortBy: SortKey;
  order: 'asc' | 'desc';
}

export const DEFAULT_TABLE_FILTERS: TableFilters = {
  state: '',
  harness: '',
  priority: '',
  search: '',
  sortBy: 'createdAt',
  order: 'desc',
};

/** A full app location: active view plus every view's persisted state. */
export interface Route {
  view: View;
  /** Board terminal columns the operator has peeked open. */
  peeked: TaskState[];
  table: TableFilters;
}

export const DEFAULT_ROUTE: Route = {
  view: 'board',
  peeked: [],
  table: DEFAULT_TABLE_FILTERS,
};

/** Query param keys — one flat namespace; only one view is active at a time so
 * the board's `peek` and the table's filters never contend for a name. */
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
const isTaskState = (v: string): v is TaskState => (TASK_STATES as readonly string[]).includes(v);
// Only terminal columns are peekable (Board.tsx), so a non-terminal `peek`
// param is meaningless — reject it so a stale value can't ride along in the URL.
const isPeekable = (v: string): v is TaskState => (TERMINAL_STATES as readonly string[]).includes(v);
const isSortKey = (v: string | null): v is SortKey => v !== null && (SORT_KEYS as readonly string[]).includes(v);

/** Accept a full URL, a `?a=b` search string, or a bare `a=b`; return just the
 * query portion for URLSearchParams. */
function queryOf(input: string): string {
  const q = input.indexOf('?');
  return q >= 0 ? input.slice(q + 1) : input;
}

/**
 * Parse a query string into a {@link Route}. Every field is validated against its
 * allowed set; anything unrecognized falls back to its default, so a malformed or
 * stale link never produces an invalid view or filter.
 */
export function parseRoute(search: string): Route {
  const params = new URLSearchParams(queryOf(search));

  const rawView = params.get(PARAM.view);
  const view: View = isView(rawView) ? rawView : 'board';

  // Dedupe while preserving order; drop anything that isn't a peekable column.
  const peeked: TaskState[] = [];
  for (const raw of (params.get(PARAM.peek) ?? '').split(',')) {
    const s = raw.trim();
    if (s && isPeekable(s) && !peeked.includes(s)) peeked.push(s);
  }

  const rawState = params.get(PARAM.state) ?? '';
  const rawHarness = params.get(PARAM.harness) ?? '';
  const rawPriority = params.get(PARAM.priority) ?? '';
  const rawOrder = params.get(PARAM.order);

  const table: TableFilters = {
    state: isTaskState(rawState) ? rawState : '',
    harness: (TABLE_HARNESSES as readonly string[]).includes(rawHarness) ? rawHarness : '',
    priority: (TABLE_PRIORITIES as readonly string[]).includes(rawPriority) ? rawPriority : '',
    search: params.get(PARAM.q) ?? '',
    sortBy: isSortKey(params.get(PARAM.sort)) ? (params.get(PARAM.sort) as SortKey) : 'createdAt',
    order: rawOrder === 'asc' ? 'asc' : 'desc',
  };

  return { view, peeked, table };
}

/**
 * Serialize a {@link Route} to a query string (leading `?`, or `''` when the route
 * is all defaults — the clean board URL). Default-valued params are omitted so the
 * URL stays terse, and `peek` states are emitted in TASK_STATES order so equal
 * routes serialize identically (stable round-trip / bookmarks).
 */
export function serializeRoute(route: Route): string {
  const params = new URLSearchParams();

  if (route.view !== 'board') params.set(PARAM.view, route.view);

  const peekSet = new Set(route.peeked);
  const peek = TASK_STATES.filter((s) => peekSet.has(s));
  if (peek.length > 0) params.set(PARAM.peek, peek.join(','));

  const t = route.table;
  if (t.state) params.set(PARAM.state, t.state);
  if (t.harness) params.set(PARAM.harness, t.harness);
  if (t.priority) params.set(PARAM.priority, t.priority);
  if (t.search) params.set(PARAM.q, t.search);
  if (t.sortBy !== 'createdAt') params.set(PARAM.sort, t.sortBy);
  if (t.order !== 'desc') params.set(PARAM.order, t.order);

  const query = params.toString();
  return query ? `?${query}` : '';
}
