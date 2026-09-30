import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AsyncDbHandle, openAsyncDb } from '../src/db/async.js';
import { notifications, workspaces } from '../src/db/schema.js';
import { NotificationStore, type NotificationInput } from '../src/notifications/notification-store.js';
import { seedWorkspace } from './helpers.js';

const DAY = 24 * 60 * 60 * 1000;

describe('NotificationStore', () => {
  let dir: string;
  let db: AsyncDbHandle;
  let store: NotificationStore;
  let ws1: number;
  let ws2: number;
  const created: number[] = [];
  const read: number[][] = [];

  const input = (over: Partial<NotificationInput> = {}): NotificationInput => ({
    severity: 'failure',
    title: 'Task failed',
    detail: null,
    workspaceId: ws1,
    taskId: 7,
    ...over,
  });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-notif-store-'));
    db = await openAsyncDb(dir);
    ws1 = await seedWorkspace(db);
    ws2 = (
      await db.write((d) =>
        d.insert(workspaces).values({ name: 'Other', workingDir: join(dir, 'b'), createdAt: 1, updatedAt: 1 }).returning().get(),
      )
    ).id;
    created.length = 0;
    read.length = 0;
    store = new NotificationStore(db, { created: (r) => created.push(r.id), read: (ids) => read.push(ids) });
  });
  afterEach(async () => {
    vi.useRealTimers();
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('records a Notification and lists it newest first with an unread count', async () => {
    const a = await store.record(input({ title: 'first' }));
    const b = await store.record(input({ title: 'second', detail: 'why', taskId: null }));
    expect(a).toMatchObject({ severity: 'failure', title: 'first', readAt: null, taskId: 7, workspaceId: ws1 });
    expect(b.detail).toBe('why');
    const { items, unreadCount } = await store.list({ limit: 50 });
    expect(items.map((i) => i.title)).toEqual(['second', 'first']);
    expect(unreadCount).toBe(2);
    expect(created).toEqual([a.id, b.id]);
  });

  it('filters by severity, workspace and unread', async () => {
    await store.record(input({ severity: 'failure' }));
    const esc = await store.record(input({ severity: 'escalation', workspaceId: ws2 }));
    const merge = await store.record(input({ severity: 'merge', workspaceId: ws2 }));
    await store.markRead(merge.id);
    expect((await store.list({ limit: 50, severity: 'escalation' })).items.map((i) => i.id)).toEqual([esc.id]);
    const scoped = await store.list({ limit: 50, workspaceId: ws2 });
    expect(scoped.items).toHaveLength(2);
    expect(scoped.unreadCount).toBe(1);
    const unread = await store.list({ limit: 50, unread: true });
    expect(unread.items.map((i) => i.id)).not.toContain(merge.id);
    expect(unread.unreadCount).toBe(2);
  });

  it('pages with an id cursor', async () => {
    const rows = [];
    for (let i = 0; i < 5; i++) rows.push(await store.record(input({ title: `n${i}` })));
    const page1 = await store.list({ limit: 2 });
    expect(page1.items.map((i) => i.title)).toEqual(['n4', 'n3']);
    const page2 = await store.list({ limit: 2, before: page1.items[1]!.id });
    expect(page2.items.map((i) => i.title)).toEqual(['n2', 'n1']);
    const page3 = await store.list({ limit: 2, before: page2.items[1]!.id });
    expect(page3.items.map((i) => i.title)).toEqual(['n0']);
  });

  it('markRead persists, is idempotent and keeps the first read time', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000);
    const row = await store.record(input());
    vi.setSystemTime(2_000);
    const first = await store.markRead(row.id);
    expect(first.readAt).toBe(2_000);
    vi.setSystemTime(3_000);
    const second = await store.markRead(row.id);
    expect(second.readAt).toBe(2_000);
    expect(read).toEqual([[row.id]]);
    expect((await store.list({ limit: 5 })).items[0]!.readAt).toBe(2_000);
  });

  it('markRead of a missing id is a not_found DomainError', async () => {
    await expect(store.markRead(999)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('markAllRead covers everything, or only one Workspace', async () => {
    const a = await store.record(input({ workspaceId: ws1 }));
    const b = await store.record(input({ workspaceId: ws2 }));
    const c = await store.record(input({ workspaceId: null }));
    expect(await store.markAllRead(ws1)).toEqual([a.id]);
    expect((await store.list({ limit: 10, unread: true })).items.map((i) => i.id).sort()).toEqual([b.id, c.id].sort());
    expect((await store.markAllRead()).sort()).toEqual([b.id, c.id].sort());
    expect(await store.markAllRead()).toEqual([]);
    expect(read).toHaveLength(2);
  });

  it('survives Task and Workspace deletion semantics: no Task FK', async () => {
    const row = await store.record(input({ taskId: 424242 }));
    expect(row.taskId).toBe(424242);
  });

  describe('prune', () => {
    async function seedAt(createdAt: number, n = 1) {
      await db.write((d) =>
        d
          .insert(notifications)
          .values(Array.from({ length: n }, () => ({ severity: 'merge' as const, title: 't', createdAt })))
          .run(),
      );
    }

    it('removes rows older than 30 days', async () => {
      const now = 100 * DAY;
      await seedAt(now - 31 * DAY, 3);
      await seedAt(now - 29 * DAY, 2);
      expect(await store.prune(now)).toBe(3);
      expect((await store.list({ limit: 50 })).items).toHaveLength(2);
    });

    it('caps at the newest 1000 rows', async () => {
      const now = 100 * DAY;
      await seedAt(now - 1000, 1100);
      const yieldNow = vi.fn(async () => {});
      expect(await store.prune(now, { yieldNow })).toBe(100);
      const remaining = await db.read((d) => d.select().from(notifications).all());
      expect(remaining).toHaveLength(1000);
      expect(Math.min(...remaining.map((r) => r.id))).toBe(101);
    });

    it('yields between delete chunks', async () => {
      const now = 100 * DAY;
      await seedAt(now - 40 * DAY, 25);
      const yieldNow = vi.fn(async () => {});
      expect(await store.prune(now, { chunkSize: 10, yieldNow })).toBe(25);
      expect(yieldNow).toHaveBeenCalledTimes(2);
      expect(await db.read((d) => d.select().from(notifications).all())).toHaveLength(0);
    });
  });
});
