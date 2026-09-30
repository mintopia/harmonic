import { NO_SELECTION, type Route } from './router-model.js';
import { elapsedShort } from './relative-time.js';
import type { Notification, NotificationSeverity, Workspace } from './types.js';

export const DROPDOWN_LIMIT = 10;
export const NOTIFICATION_PAGE_SIZE = 200;
export const RETENTION_DAYS = 30;
export const RETENTION_CAP = 1000;
export const RETENTION_NOTE = `Kept for ${RETENTION_DAYS} days, up to ${RETENTION_CAP} Notifications.`;

export interface NotificationsState {
  items: Notification[];
  unreadCount: number;
}
export const EMPTY_NOTIFICATIONS: NotificationsState = { items: [], unreadCount: 0 };

export type SeverityFilter = 'all' | NotificationSeverity;
export interface NotificationFilters {
  severity: SeverityFilter;
  workspaceId: number | null;
  unreadOnly: boolean;
}

export const SEVERITY_ORDER: readonly NotificationSeverity[] = ['failure', 'escalation', 'merge', 'export'];
export const SEVERITY_META: Record<NotificationSeverity, { label: string; plural: string }> = {
  failure: { label: 'Failure', plural: 'Failures' },
  escalation: { label: 'Escalation', plural: 'Escalations' },
  merge: { label: 'Merge', plural: 'Merges' },
  export: { label: 'Export', plural: 'Exports' },
};
export const SEVERITY_FILTERS: readonly { value: SeverityFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  ...SEVERITY_ORDER.map((value) => ({ value, label: SEVERITY_META[value].plural })),
];

export function badgeText(count: number): string | null {
  if (count <= 0) return null;
  return count > 99 ? '99+' : String(count);
}

export const bellLabel = (count: number): string => (count > 0 ? `Notifications, ${count} unread` : 'Notifications');

const inScope = (n: Notification, workspaceId: number | null) => workspaceId === null || n.workspaceId === workspaceId;

export function applyCreated(state: NotificationsState, created: Notification, scopeWorkspaceId: number | null): NotificationsState {
  if (!inScope(created, scopeWorkspaceId) || state.items.some((i) => i.id === created.id)) return state;
  return { items: [created, ...state.items], unreadCount: state.unreadCount + (created.read ? 0 : 1) };
}

const keepLocalRead = (page: readonly Notification[], known: ReadonlyMap<number, Notification>): { items: Notification[]; corrected: number } => {
  let corrected = 0;
  const items = page.map((p) => {
    const local = known.get(p.id);
    if (!local?.read || p.read) return p;
    corrected++;
    return { ...p, read: true, readAt: local.readAt };
  });
  return { items, corrected };
};

const byId = (items: readonly Notification[]) => new Map(items.map((i) => [i.id, i]));

/** Read is monotonic: a row we already hold as read stays read even if the fetched page predates the write. */
export function mergeOlderPage(state: NotificationsState, page: readonly Notification[]): NotificationsState {
  const known = byId(state.items);
  const fresh = keepLocalRead(page.filter((p) => !known.has(p.id)), known).items;
  return { items: [...state.items, ...fresh].sort((a, b) => b.id - a.id), unreadCount: state.unreadCount };
}

/** A fresh first page supersedes what we hold for its id range; only older rows and newer live arrivals survive. */
export function mergeFetchedPage(state: NotificationsState, page: readonly Notification[], unreadCount: number): NotificationsState {
  const known = byId(state.items);
  const { items: fetched, corrected } = keepLocalRead(page, known);
  const floor = page.length >= NOTIFICATION_PAGE_SIZE ? page[page.length - 1]!.id : 0;
  const newer = state.items.filter((i) => i.id > (page[0]?.id ?? Infinity));
  const older = state.items.filter((i) => i.id < floor);
  return { items: [...newer, ...fetched, ...older], unreadCount: Math.max(0, unreadCount - corrected) };
}

export function unknownIds(state: NotificationsState, ids: readonly number[]): number[] {
  return ids.filter((id) => !state.items.some((i) => i.id === id));
}

export function applyRead(state: NotificationsState, ids: readonly number[], readAt: number = Date.now()): NotificationsState {
  let newlyRead = 0;
  const items = state.items.map((i) => {
    if (i.read || !ids.includes(i.id)) return i;
    newlyRead++;
    return { ...i, read: true, readAt: i.readAt ?? readAt };
  });
  return newlyRead === 0 ? state : { items, unreadCount: Math.max(0, state.unreadCount - newlyRead) };
}

export function markAllReadLocal(state: NotificationsState, readAt: number): NotificationsState {
  const items = state.items.map((i) => (i.read ? i : { ...i, read: true, readAt }));
  return { items, unreadCount: 0 };
}

export function filterNotifications(items: readonly Notification[], f: NotificationFilters): Notification[] {
  return items.filter(
    (i) => (f.severity === 'all' || i.severity === f.severity) && (f.workspaceId === null || i.workspaceId === f.workspaceId) && (!f.unreadOnly || !i.read),
  );
}

export function severityCounts(items: readonly Notification[]): Record<SeverityFilter, number> {
  const counts = Object.fromEntries(SEVERITY_FILTERS.map((f) => [f.value, 0])) as Record<SeverityFilter, number>;
  for (const i of items) {
    counts.all++;
    counts[i.severity]++;
  }
  return counts;
}

export function workspaceTagFor(n: Notification, workspaces: readonly Workspace[], scopeWorkspace: Workspace | null): Workspace | null {
  return scopeWorkspace ? null : workspaces.find((w) => w.id === n.workspaceId) ?? null;
}

const startOfDay = (ms: number) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
const DAY_MS = 86_400_000;
const pad = (v: number) => String(v).padStart(2, '0');
const clock = (ms: number) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

export function dayLabel(ms: number, now: number): string {
  const diff = Math.round((startOfDay(now) - startOfDay(ms)) / DAY_MS);
  if (diff <= 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return new Date(ms).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

export function formatNotificationTime(ms: number, now: number): string {
  const day = dayLabel(ms, now);
  if (day === 'Today') {
    return now - ms < 60_000 ? 'just now' : `${elapsedShort(ms, now)} ago`;
  }
  if (day === 'Yesterday') return `Yesterday ${clock(ms)}`;
  return `${new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} · ${clock(ms)}`;
}

export interface DayGroup { label: string; items: Notification[] }

export function groupByDay(items: readonly Notification[], now: number): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const item of items) {
    const label = dayLabel(item.createdAt, now);
    const last = groups[groups.length - 1];
    if (last?.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
}

/** Null when the Notification has no Ticket to open; a deleted Task still routes so the Ticket page can say so. */
export function ticketRoute(route: Route, n: Notification): Route | null {
  if (n.taskId === null || n.workspaceId === null) return null;
  return { ...route, scope: { kind: 'workspace', workspaceId: n.workspaceId }, view: 'board', task: n.taskId, epic: null, conversation: null, panel: NO_SELECTION, file: null };
}
