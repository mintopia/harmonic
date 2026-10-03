import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { eq, inArray } from 'drizzle-orm';
import { attempts, tasks } from '../src/db/schema.js';
import { startServer, stubHarness, type TestServer } from './helpers.js';
import { trackerRef } from '../src/tracker/adapter.js';

describe('Agent Message Threads API', () => {
  let server: TestServer;
  let ws1: number;
  let ws2: number;
  let ws3: number;
  const t: Record<string, number> = {};
  const attempt: Record<string, number> = {};
  let now = 1_000;

  const ctx = () => server.app.ctx;
  const setAttemptState = (id: number, state: 'running' | 'failed') =>
    ctx().asyncDb.write((d) => d.update(attempts).set({ state }).where(eq(attempts.id, id)).run());
  const mkTask = async (name: string, workspaceId: number, parent: number | null = null) => {
    const created = await server.api('POST', '/api/tasks', { prompt: name, workspaceId, state: 'draft' });
    const id = created.body.id as number;
    await ctx().asyncDb.write((d) => d.update(tasks).set({ trackerParent: parent === null ? null : trackerRef(parent), harness: 'claude' }).where(eq(tasks.id, id)).run());
    t[name] = id;
    attempt[name] = (await ctx().attempts.create(id)).id;
    await setAttemptState(attempt[name]!, 'failed');
    return id;
  };
  const send = async (from: string, to: string[], text: string, threadId: string | null = null, workspaceId = ws1) => {
    const row = await ctx().agentMessages.create({
      workspaceId, text, replyTo: threadId, threadId,
      senderTaskId: t[from]!, senderAttemptId: attempt[from]!,
      recipients: to.map((n) => ({ taskId: t[n]!, receipt: 'delivered' as const, mode: 'mid-turn' as const, deliveredAt: now })),
    });
    now += 1;
    return row;
  };
  const get = (qs = '') => server.api('GET', `/api/agent-messages/threads${qs}`);
  const ids = (body: any) => body.threads.map((th: any) => th.threadId);

  let threadA: string;
  let threadB: string;
  let threadC: string;
  let threadD: string;

  beforeAll(async () => {
    server = await startServer(stubHarness());
    ws1 = (await server.api('GET', '/api/workspaces')).body.workspaces[0].id;
    for (const name of ['second', 'third']) mkdirSync(join(server.dataDir, name));
    ws2 = (await server.api('POST', '/api/workspaces', { name: 'Second', workingDir: join(server.dataDir, 'second') })).body.id;
    ws3 = (await server.api('POST', '/api/workspaces', { name: 'Third', workingDir: join(server.dataDir, 'third') })).body.id;
    await ctx().workspaces.update(ws1, { agentMessagesEnabled: true });
    await ctx().workspaces.update(ws2, { agentMessagesEnabled: true });
    await ctx().workspaces.update(ws3, { agentMessagesEnabled: false });
    await mkTask('a', ws1, 500);
    await mkTask('b', ws1, 500);
    await mkTask('c', ws1, 600);
    await mkTask('d', ws1);
    await mkTask('x', ws2);
    await mkTask('y', ws2);
    await mkTask('z', ws3);
    await mkTask('w', ws3);

    const a1 = await send('a', ['b'], 'hello b');
    threadA = a1.threadId;
    await send('b', ['a', 'c'], 'reply', threadA);
    threadB = (await send('c', ['d'], 'c to d')).threadId;
    threadC = (await send('x', ['y'], 'ws2 hello', null, ws2)).threadId;
    threadD = (await send('z', ['w'], 'disabled', null, ws3)).threadId;
    await send('a', ['b'], 'latest in A', threadA);
  });
  afterAll(async () => { await server.close(); });

  it('lists Global Threads by latest activity, excluding disabled Workspaces', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(ids(res.body)).toEqual([threadA, threadC, threadB]);
    expect(ids(res.body)).not.toContain(threadD);
    const [a] = res.body.threads;
    expect(a.latestAt).toBe(a.messages.at(-1).createdAt);
    expect(a.latestAt).toBeGreaterThanOrEqual(res.body.threads[1].latestAt);
  });

  it('presents messages oldest first with per-recipient receipts', async () => {
    const a = (await get(`?workspaceId=${ws1}`)).body.threads.find((th: any) => th.threadId === threadA);
    expect(a.messages.map((m: any) => m.parts[0].text)).toEqual(['hello b', 'reply', 'latest in A']);
    expect(a.messages[1].recipients).toEqual([
      expect.objectContaining({ taskId: t.a, receipt: 'delivered', mode: 'mid-turn', deleted: false }),
      expect.objectContaining({ taskId: t.c, receipt: 'delivered', mode: 'mid-turn', deleted: false }),
    ]);
  });

  it('reports model, state, betweenAttempts, latest Attempt and the per-Workspace cap', async () => {
    await ctx().workspaces.update(ws2, { agentMessagesSendCap: 7 });
    await ctx().asyncDb.write((d) => d.update(tasks).set({ state: 'working', model: 'opus' }).where(eq(tasks.id, t.x!)).run());
    await ctx().asyncDb.write((d) => d.update(tasks).set({ state: 'working' }).where(eq(tasks.id, t.y!)).run());
    const second = (await ctx().attempts.create(t.y!)).id;
    const c = (await get()).body.threads.find((th: any) => th.threadId === threadC);
    const [x, y] = c.participants;
    expect(x).toEqual(expect.objectContaining({ taskId: t.x, model: 'opus', state: 'working', betweenAttempts: true, sendCap: 7, sends: 1 }));
    expect(y).toEqual(expect.objectContaining({ taskId: t.y, betweenAttempts: false, attemptNumber: 2, sends: 0, sendCap: 7, lastMessageAt: null }));
    expect(c.workspaceName).toBe('Second');
    await setAttemptState(second, 'failed');
    await ctx().asyncDb.write((d) => d.update(tasks).set({ state: 'draft' }).where(inArray(tasks.id, [t.x!, t.y!])).run());
  });

  it('orders de-duplicated participants by first appearance with Task facts', async () => {
    const a = (await get()).body.threads.find((th: any) => th.threadId === threadA);
    expect(a.participants.map((p: any) => p.taskId)).toEqual([t.a, t.b, t.c]);
    expect(a.participants[0]).toEqual({ taskId: t.a, title: expect.any(String), harness: 'claude', epicId: '500', deleted: false, model: null, state: 'draft', betweenAttempts: false, attemptNumber: 1, sends: 2, sendCap: expect.any(Number), lastMessageAt: expect.any(Number) });
    expect(a.workspaceName).toBe((await ctx().workspaces.list()).find((w) => w.id === ws1)!.name);
    const sentByB = a.messages.filter((m: any) => m.senderTaskId === t.b);
    expect(a.participants[1].lastMessageAt).toBe(sentByB.at(-1).createdAt);
    expect(a.participants[1].sends).toBe(1);
    expect(a.participants[2].lastMessageAt).toBeNull();
    expect(a.participants[2].epicId).toBe('600');
  });

  it('counts sends attempt-wide across Threads', async () => {
    const a = (await get()).body.threads.find((th: any) => th.threadId === threadA);
    expect(a.participants[2].taskId).toBe(t.c);
    expect(a.participants[2].lastMessageAt).toBeNull();
    expect(a.participants[2].sends).toBe(1);
  });

  it('scopes to a Workspace and returns nothing for a disabled one', async () => {
    expect(ids((await get(`?workspaceId=${ws2}`)).body)).toEqual([threadC]);
    expect(ids((await get(`?workspaceId=${ws1}`)).body)).toEqual([threadA, threadB]);
    expect((await get(`?workspaceId=${ws3}`)).body).toEqual({ threads: [], total: 0, totalMessages: 0 });
  });

  it('filters by epicId, taskId and live', async () => {
    expect(ids((await get('?epicId=500')).body)).toEqual([threadA]);
    expect(ids((await get('?epicId=600')).body)).toEqual([threadA, threadB]);
    expect((await get('?epicId=999')).body.total).toBe(0);
    expect(ids((await get(`?taskId=${t.d}`)).body)).toEqual([threadB]);
    expect(ids((await get(`?taskId=${t.c}`)).body)).toEqual([threadA, threadB]);

    await setAttemptState(attempt.d!, 'running');
  });

  it('marks Threads live when a participant has a running Attempt', async () => {
    const running = await get('?live=true');
    expect(ids(running.body)).toEqual([threadB]);
    expect(running.body.threads[0].live).toBe(true);
    const all = (await get()).body.threads;
    expect(all.find((th: any) => th.threadId === threadA).live).toBe(false);
    expect(ids((await get('?live=false')).body)).toHaveLength(3);
  });

  it('reports totalMessages across every matching Thread, not just the page', async () => {
    expect((await get()).body.totalMessages).toBe(5);
    expect((await get('?limit=1')).body.totalMessages).toBe(5);
    expect((await get('?epicId=600')).body.totalMessages).toBe(4);
    expect((await get(`?taskId=${t.d}`)).body.totalMessages).toBe(1);
    expect((await get('?epicId=999')).body.totalMessages).toBe(0);
  });

  it('paginates with a stable total', async () => {
    const page = await get('?limit=1&offset=1');
    expect(page.body.total).toBe(3);
    expect(ids(page.body)).toEqual([threadC]);
  });

  it('flags a deleted participant and nulls its facts', async () => {
    expect((await server.api('DELETE', `/api/tasks/${t.y}`)).status).toBe(200);
    const c = (await get(`?workspaceId=${ws2}`)).body.threads[0];
    expect(c.participants[1]).toEqual({ taskId: t.y, title: null, harness: null, epicId: null, deleted: true, model: null, state: null, betweenAttempts: false, attemptNumber: null, sends: 0, sendCap: 7, lastMessageAt: null });
    expect(c.messages[0].recipients[0].deleted).toBe(true);
  });

  it('defaults to 50 Threads per page and rejects a limit above 200', async () => {
    for (let i = 0; i < 50; i++) await send('x', ['y'], `bulk ${i}`, null, ws2);
    const page = await get(`?workspaceId=${ws2}`);
    expect(page.body.threads).toHaveLength(50);
    expect(page.body.total).toBe(51);
    expect((await get('?limit=201')).status).toBe(400);
  });
});
