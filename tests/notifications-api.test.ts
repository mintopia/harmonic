import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectFirehose, startServer, waitFor, type TestServer } from './helpers.js';

describe('Notifications API', () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await startServer();
  });
  afterAll(async () => {
    await server.close();
  });

  const record = (over: Record<string, unknown> = {}) =>
    server.app.ctx.notifications.record({
      severity: 'escalation',
      title: 'Needs you',
      detail: null,
      workspaceId: null,
      taskId: null,
      ...over,
    });

  it('lists, marks read and marks all read, pushing over the WebSocket', async () => {
    const ws = await connectFirehose(server);
    const a = await record({ title: 'a' });
    const b = await record({ title: 'b', severity: 'merge' });
    await waitFor(async () => ws.messages.filter((m) => m.type === 'notification_created').length >= 2);
    expect(ws.messages.find((m) => m.type === 'notification_created').notification).toMatchObject({ title: 'a', read: false });

    const list = await server.api('GET', '/api/notifications?limit=50');
    expect(list.status).toBe(200);
    expect(list.body.items.map((i: any) => i.id)).toEqual([b.id, a.id]);
    expect(list.body.unreadCount).toBe(2);

    const filtered = await server.api('GET', '/api/notifications?severity=merge&unread=true');
    expect(filtered.body.items.map((i: any) => i.id)).toEqual([b.id]);

    const one = await server.api('POST', `/api/notifications/${a.id}/read`);
    expect(one.status).toBe(200);
    expect(one.body.notification).toMatchObject({ id: a.id, read: true });
    expect((await server.api('POST', '/api/notifications/999999/read')).status).toBe(404);

    const all = await server.api('POST', '/api/notifications/read-all', {});
    expect(all.body).toEqual({ updated: 1 });
    await waitFor(async () => ws.messages.filter((m) => m.type === 'notifications_read').length >= 2);
    expect(ws.messages.filter((m) => m.type === 'notifications_read').map((m) => m.ids)).toEqual([[a.id], [b.id]]);
    ws.close();
  });

  it('lets a read key list but not mark read', async () => {
    const n = await record();
    const token = (await server.api('POST', '/api/keys', { name: 'viz', scope: 'read' })).body.token;
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    expect((await fetch(`${server.baseUrl}/api/notifications`, { headers })).status).toBe(200);
    const mark = await fetch(`${server.baseUrl}/api/notifications/${n.id}/read`, { method: 'POST', headers, body: '{}' });
    expect(mark.status).toBe(403);
    const all = await fetch(`${server.baseUrl}/api/notifications/read-all`, { method: 'POST', headers, body: '{}' });
    expect(all.status).toBe(403);
  });

  it('requires authentication', async () => {
    expect((await server.anonApi('GET', '/api/notifications')).status).toBe(401);
  });

  it('scopes the list and unread count to a Workspace', async () => {
    const res = await server.api('GET', '/api/notifications?workspaceId=999');
    expect(res.body).toEqual({ items: [], unreadCount: 0 });
  });
});

describe('Notifications recorded from server outcomes', () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await startServer();
  });
  afterAll(async () => {
    await server.close();
  });

  it('a Task escalation creates exactly one Notification with no WebSocket connected', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'harmonic-notif-work-'));
    const task = (await server.api('POST', '/api/tasks', { prompt: 'needs a human', workingDir: dir })).body;
    await server.app.ctx.tasks.setState(task.id, 'working');
    await server.app.ctx.tasks.escalate(task.id, 'attempt 3 of 3 failed');

    await waitFor(async () => (await server.api('GET', '/api/notifications')).body.items.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const { items, unreadCount } = (await server.api('GET', '/api/notifications')).body;
    expect(items).toHaveLength(1);
    expect(unreadCount).toBe(1);
    expect(items[0]).toMatchObject({
      severity: 'escalation',
      taskId: task.id,
      read: false,
      title: `Task ${task.id} escalated — attempt 3 of 3 failed`,
    });
  });

  it('a failing local request creates no Notification', async () => {
    const before = (await server.api('GET', '/api/notifications')).body.items.length;
    const bad = await server.api('POST', '/api/tasks/999999/accept');
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(bad.status).toBeLessThan(500);
    const invalid = await server.api('POST', '/api/tasks', { prompt: 42 });
    expect(invalid.status).toBe(400);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await server.api('GET', '/api/notifications')).body.items).toHaveLength(before);
  });
});
