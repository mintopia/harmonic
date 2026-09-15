import { TASK_STATES, type TaskState } from './types.js';
import { GLOBAL_RAIL_VIEWS, WORKSPACE_RAIL_VIEWS, type View } from './rail-model.js';

export const SORT_KEYS = ['createdAt', 'updatedAt', 'priority', 'cost'] as const;
export type SortKey = (typeof SORT_KEYS)[number];
export const TABLE_HARNESSES = ['claude', 'codex', 'copilot', 'opencode'] as const;
export const TABLE_PRIORITIES = ['high', 'normal', 'low'] as const;
export interface TableFilters { state: string[]; harness: string[]; priority: string[]; search: string; sortBy: SortKey; order: 'asc' | 'desc'; }
export const DEFAULT_TABLE_FILTERS: TableFilters = { state: [], harness: [], priority: [], search: '', sortBy: 'createdAt', order: 'desc' };
export type RailSelection = { kind: 'none' } | { kind: 'stats' } | { kind: 'attempt'; attemptNumber: number } | { kind: 'timeline' } | { kind: 'changes' } | { kind: 'file'; path: string };
export const NO_SELECTION: RailSelection = { kind: 'none' };
export type Scope = { kind: 'global' } | { kind: 'workspace'; workspaceId: number };
export interface Route {
  scope: Scope; view: View; task: number | null; epic: number | null; conversation: number | null;
  peeked: TaskState[]; table: TableFilters; panel: RailSelection; file: string | null;
}
export const DEFAULT_ROUTE: Route = { scope: { kind: 'global' }, view: 'board', task: null, epic: null, conversation: null, peeked: [], table: DEFAULT_TABLE_FILTERS, panel: NO_SELECTION, file: null };
export const LAST_ROUTE_KEY = 'harmonic.last-route';
type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

const GLOBAL_PATHS: Readonly<Record<string, View>> = { '/': 'board', '/tasks': 'table', '/activity': 'activity', '/timeline': 'timeline', '/stats': 'stats', '/operations': 'operations', '/api': 'api', '/settings': 'settings' };
const WORKSPACE_PATHS: Readonly<Record<string, View>> = { board: 'board', conversations: 'conversations', graph: 'graph', activity: 'activity', tasks: 'table', timeline: 'timeline', stats: 'stats', files: 'files', operations: 'operations', settings: 'workspace' };
const csvValues = (raw: string, allowed: readonly string[]) => {
  const values: string[] = [];
  for (const part of raw.split(',')) { const value = part.trim(); if (value && allowed.includes(value) && !values.includes(value)) values.push(value); }
  return values;
};
const isSortKey = (value: string | null): value is SortKey => value !== null && (SORT_KEYS as readonly string[]).includes(value);
const positiveId = (value: string | undefined): number | null => { const id = Number(value); return Number.isSafeInteger(id) && id > 0 ? id : null; };
const queryOf = (input: string) => input.includes('?') ? input.slice(input.indexOf('?') + 1) : input;
function filters(search: string): TableFilters {
  const params = new URLSearchParams(queryOf(search));
  const sort = params.get('sort');
  return { state: csvValues(params.get('state') ?? '', TASK_STATES), harness: csvValues(params.get('harness') ?? '', TABLE_HARNESSES), priority: csvValues(params.get('priority') ?? '', TABLE_PRIORITIES), search: params.get('q') ?? '', sortBy: isSortKey(sort) ? sort : 'createdAt', order: params.get('order') === 'asc' ? 'asc' : 'desc' };
}
function parseDetail(parts: string[]): Pick<Route, 'task' | 'epic' | 'conversation' | 'panel' | 'file'> {
  const [kind, rawId, panelKind, panelValue] = parts;
  const id = positiveId(rawId);
  const panel: RailSelection = panelKind === 'attempt' && positiveId(panelValue) !== null ? { kind: 'attempt', attemptNumber: positiveId(panelValue)! } : panelKind === 'stats' || panelKind === 'timeline' || panelKind === 'changes' ? { kind: panelKind } : NO_SELECTION;
  if (kind === 'task' && id !== null) return { task: id, epic: null, conversation: null, panel, file: null };
  if (kind === 'epic' && id !== null) return { task: null, epic: id, conversation: null, panel, file: null };
  if (kind === 'conversations' && id !== null) return { task: null, epic: null, conversation: id, panel: NO_SELECTION, file: null };
  return { task: null, epic: null, conversation: null, panel: NO_SELECTION, file: null };
}
export function parseRoute(pathname: string, search: string): Route {
  const normalized = pathname.replace(/\/+$/, '') || '/';
  const globalView = GLOBAL_PATHS[normalized];
  if (globalView) return { ...DEFAULT_ROUTE, view: globalView, table: filters(search) };
  const match = /^\/workspace\/(\d+)(?:\/(.*))?$/.exec(normalized);
  const workspaceId = positiveId(match?.[1]);
  if (workspaceId === null) return { ...DEFAULT_ROUTE, table: filters(search) };
  const parts = (match?.[2] ?? 'board').split('/').filter(Boolean);
  const detail = parseDetail(parts);
  const view = detail.task !== null || detail.epic !== null ? 'board' : detail.conversation !== null ? 'conversations' : WORKSPACE_PATHS[parts[0] ?? 'board'] ?? 'board';
  const file = view === 'files' && parts.length > 1 ? decodeURIComponent(parts.slice(1).join('/')) : null;
  return { scope: { kind: 'workspace', workspaceId }, view, ...detail, file, peeked: [], table: filters(search) };
}
function detailPath(route: Route): string | null {
  const panel = route.panel.kind === 'none' ? '' : route.panel.kind === 'attempt' ? `/attempt/${route.panel.attemptNumber}` : `/${route.panel.kind}`;
  if (route.task !== null) return `task/${route.task}${panel}`;
  if (route.epic !== null) return `epic/${route.epic}${panel}`;
  if (route.conversation !== null) return `conversations/${route.conversation}`;
  return null;
}
export function serializeRoute(route: Route): string {
  const params = new URLSearchParams();
  const table = route.table;
  if (table.state.length) params.set('state', table.state.join(','));
  if (table.harness.length) params.set('harness', table.harness.join(','));
  if (table.priority.length) params.set('priority', table.priority.join(','));
  if (table.search) params.set('q', table.search);
  if (table.sortBy !== 'createdAt') params.set('sort', table.sortBy);
  if (table.order !== 'desc') params.set('order', table.order);
  let base: string;
  if (route.scope.kind === 'global') base = Object.entries(GLOBAL_PATHS).find(([, view]) => view === route.view)?.[0] ?? '/';
  else {
    const detail = detailPath(route);
    const segment = detail ?? (route.view === 'workspace' ? 'settings' : route.view === 'table' ? 'tasks' : route.view);
    const file = !detail && route.view === 'files' && route.file ? `/${route.file.split('/').map(encodeURIComponent).join('/')}` : '';
    base = `/workspace/${route.scope.workspaceId}/${segment}${file}`;
  }
  const query = params.toString();
  return query ? `${base}?${query}` : base;
}
export function storeLastRoute(storage: StorageLike, route: Route): void { try { storage.setItem(LAST_ROUTE_KEY, serializeRoute(route)); } catch {} }
export function loadLastRoute(storage: StorageLike): Route {
  try { const value = storage.getItem(LAST_ROUTE_KEY); if (!value?.startsWith('/')) return DEFAULT_ROUTE; const url = new URL(value, 'http://harmonic.local'); return parseRoute(url.pathname, url.search); } catch { return DEFAULT_ROUTE; }
}
export function scopeSwitchRoute(route: Route, scope: Scope): Route {
  if (scope.kind === 'global') return { ...route, scope, view: GLOBAL_RAIL_VIEWS.includes(route.view) ? route.view : 'board', task: null, epic: null, conversation: null, panel: NO_SELECTION, file: null };
  const view = route.view === 'settings' ? 'workspace' : route.view;
  return { ...route, scope, view: WORKSPACE_RAIL_VIEWS.includes(view) ? view : 'board', task: null, epic: null, conversation: null, panel: NO_SELECTION, file: null };
}
