import { describe, expect, it } from 'vitest';
import {
  applyCreated,
  applyRead,
  badgeText,
  bellLabel,
  filterNotifications,
  formatNotificationTime,
  groupByDay,
  markAllReadLocal,
  mergeFetchedPage,
  mergeOlderPage,
  workspaceTagFor,
  severityCounts,
  ticketRoute,
  unknownIds,
  type NotificationsState,
} from '../web/src/notifications-model.js';
import { DEFAULT_ROUTE } from '../web/src/router-model.js';
import type { Notification } from '../web/src/types.js';

const NOW = new Date(2026, 8, 30, 12, 0).getTime();
const n = (id: number, over: Partial<Notification> = {}): Notification => ({
  id, severity: 'failure', title: `t${id}`, detail: null, workspaceId: 1, taskId: id, createdAt: NOW - id * 60_000, readAt: null, read: false, ...over,
});
const state = (items: Notification[], unreadCount = items.filter((i) => !i.read).length): NotificationsState => ({ items, unreadCount });

describe('badge', () => {
  it('hides at zero, shows the count, caps at 99+', () => {
    expect(badgeText(0)).toBeNull();
    expect(badgeText(5)).toBe('5');
    expect(badgeText(99)).toBe('99');
    expect(badgeText(100)).toBe('99+');
  });
  it('labels the bell with the count', () => {
    expect(bellLabel(0)).toBe('Notifications');
    expect(bellLabel(5)).toBe('Notifications, 5 unread');
  });
});

describe('live events', () => {
  it('prepends a created Notification and bumps the count', () => {
    const next = applyCreated(state([n(1)]), n(2), null);
    expect(next.items.map((i) => i.id)).toEqual([2, 1]);
    expect(next.unreadCount).toBe(2);
  });
  it('ignores duplicates and out-of-scope Workspaces', () => {
    const s = state([n(1)]);
    expect(applyCreated(s, n(1), null)).toBe(s);
    expect(applyCreated(s, n(2, { workspaceId: 9 }), 1)).toBe(s);
  });
  it('marks ids read and lowers the count once', () => {
    const next = applyRead(state([n(1), n(2, { read: true, readAt: 1 })]), [1, 2]);
    expect(next.items.every((i) => i.read)).toBe(true);
    expect(next.unreadCount).toBe(0);
  });
  it('reports ids it has not loaded', () => {
    expect(unknownIds(state([n(1)]), [1, 7])).toEqual([7]);
  });
  it('marks all read locally and zeroes the count even when unloaded rows remain', () => {
    const next = markAllReadLocal(state([n(1), n(2)], 40), NOW);
    expect(next.items.every((x) => x.read)).toBe(true);
    expect(next.unreadCount).toBe(0);
  });
});

describe('paging', () => {
  it('appends older pages without duplicates, newest first', () => {
    const next = mergeOlderPage(state([n(5), n(4)], 7), [n(4), n(3), n(2)]);
    expect(next.items.map((i) => i.id)).toEqual([5, 4, 3, 2]);
    expect(next.unreadCount).toBe(7);
  });
  it('keeps locally read rows read in older pages', () => {
    const held = { ...n(3), read: true, readAt: 5 };
    const next = mergeOlderPage(state([n(5)]), [n(3)]);
    expect(next.items[1]!.read).toBe(false);
    expect(mergeOlderPage(state([held]), [n(2), n(3)]).items.find((i) => i.id === 3)!.read).toBe(true);
  });
});

describe('fetched first page', () => {
  it('replaces stale rows and keeps newer live arrivals', () => {
    const next = mergeFetchedPage(state([n(9), n(2), n(1)], 3), [n(2, { read: true }), n(1, { read: true })], 0);
    expect(next.items.map((i) => [i.id, i.read])).toEqual([[9, false], [2, true], [1, true]]);
    expect(next.unreadCount).toBe(0);
  });
  it('does not flip a locally read row back to unread and corrects the count', () => {
    const local = state([{ ...n(2), read: true, readAt: 9 }, n(1)], 1);
    const next = mergeFetchedPage(local, [n(2), n(1)], 2);
    expect(next.items.map((i) => i.read)).toEqual([true, false]);
    expect(next.unreadCount).toBe(1);
  });
});

describe('workspace tag', () => {
  const ws = [{ id: 1, name: 'a', color: '#fff' }] as never[];
  it('resolves the Workspace only in Global scope', () => {
    expect(workspaceTagFor(n(1), ws, null)?.id).toBe(1);
    expect(workspaceTagFor(n(1), ws, ws[0]!)).toBeNull();
    expect(workspaceTagFor(n(1, { workspaceId: 5 }), ws, null)).toBeNull();
  });
});

describe('filtering', () => {
  const items = [n(1), n(2, { severity: 'merge', read: true }), n(3, { severity: 'merge', workspaceId: 2 })];
  it('filters by severity, Workspace and unread', () => {
    expect(filterNotifications(items, { severity: 'all', workspaceId: null, unreadOnly: false })).toHaveLength(3);
    expect(filterNotifications(items, { severity: 'merge', workspaceId: null, unreadOnly: false }).map((i) => i.id)).toEqual([2, 3]);
    expect(filterNotifications(items, { severity: 'merge', workspaceId: 2, unreadOnly: false }).map((i) => i.id)).toEqual([3]);
    expect(filterNotifications(items, { severity: 'all', workspaceId: null, unreadOnly: true }).map((i) => i.id)).toEqual([1, 3]);
  });
  it('counts per severity', () => {
    expect(severityCounts(items)).toEqual({ all: 3, failure: 1, escalation: 0, merge: 2, export: 0 });
  });
});

describe('day grouping', () => {
  it('labels Today, Yesterday and dated groups, newest first', () => {
    const at = (d: number, h: number) => new Date(2026, 8, d, h).getTime();
    const groups = groupByDay([n(1, { createdAt: at(30, 11) }), n(2, { createdAt: at(30, 1) }), n(3, { createdAt: at(29, 9) }), n(4, { createdAt: at(28, 22) })], NOW);
    expect(groups.map((g) => [g.label, g.items.length])).toEqual([['Today', 2], ['Yesterday', 1], ['Mon, Sep 28', 1]]);
  });
  it('formats times relative today, clock otherwise', () => {
    expect(formatNotificationTime(NOW - 20_000, NOW)).toBe('just now');
    expect(formatNotificationTime(NOW - 4 * 60_000, NOW)).toBe('4m ago');
    expect(formatNotificationTime(NOW - 3 * 3_600_000, NOW)).toBe('3h ago');
    expect(formatNotificationTime(new Date(2026, 8, 29, 9, 30).getTime(), NOW)).toBe('Yesterday 09:30');
    expect(formatNotificationTime(new Date(2026, 8, 28, 10, 5).getTime(), NOW)).toBe('Sep 28 · 10:05');
  });
});

describe('ticketRoute', () => {
  it('opens the Ticket in its own Workspace', () => {
    expect(ticketRoute(DEFAULT_ROUTE, n(1, { workspaceId: 3, taskId: 412 }))).toMatchObject({
      scope: { kind: 'workspace', workspaceId: 3 }, view: 'board', task: 412,
    });
  });
  it('does not navigate without a Ticket or Workspace', () => {
    expect(ticketRoute(DEFAULT_ROUTE, n(1, { taskId: null }))).toBeNull();
    expect(ticketRoute(DEFAULT_ROUTE, n(1, { workspaceId: null }))).toBeNull();
  });
});
