import { describe, it, expect, afterEach, vi } from 'vitest';
import { startServer, stubHarness, type TestServer } from './helpers.js';
import { AsyncDbHandle } from '../src/db/async.js';
import { runs, tasks, workspaces } from '../src/db/schema.js';

/**
 * #213 (ADR-0029 §5): the Stats range scan — the one genuine heavy DB aggregate
 * on the growing `runs` table — must run through the async/off-thread libsql read
 * path so a large scan can never block the event loop. These tests pin the wiring
 * (an `AsyncDbHandle` on the context) and the routing (Stats reads through it and
 * still sees what the sync writer committed, over WAL).
 */
describe('Stats heavy aggregate routes through the async read path (#213)', () => {
  let server: TestServer;

  afterEach(async () => {
    await server?.close();
  });

  it('wires a concurrent-read AsyncDbHandle onto the app context', async () => {
    server = await startServer(stubHarness());
    expect(server.app.ctx.asyncReadDb).toBeInstanceOf(AsyncDbHandle);
  });

  it('serves /api/stats by reading through ctx.asyncReadDb.read, seeing the sync writer’s rows', async () => {
    server = await startServer(stubHarness());
    const { ctx } = server.app;

    // The sync better-sqlite3 connection (the single writer) commits a run…
    const now = Date.now();
    const ws = ctx.db.select().from(workspaces).get()!;
    const task = ctx.db
      .insert(tasks)
      .values({ prompt: 'p', state: 'ready', workingDir: '/tmp', createdAt: now, updatedAt: now, workspaceId: ws.id })
      .returning()
      .get();
    ctx.db
      .insert(runs)
      .values({
        taskId: task.id,
        attempt: 1,
        state: 'completed',
        startedAt: now,
        usage: JSON.stringify({ models: {}, totals: null, toolCalls: { Bash: 2 }, source: 'session-log' }),
      })
      .run();

    // …and the aggregate is served off the async read connection, seeing it.
    const readSpy = vi.spyOn(ctx.asyncReadDb, 'read');
    const res = await server.api('GET', `/api/stats?from=0&to=${now + 1000}`);

    expect(res.status).toBe(200);
    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(res.body.runCount).toBe(1);
    expect(res.body.runsByState).toEqual({ completed: 1 });
    expect(res.body.toolCalls).toEqual({ Bash: 2 });
  });

  it('scopes by workspace through the async read path (tasks join)', async () => {
    server = await startServer(stubHarness());
    const { ctx } = server.app;

    const now = Date.now();
    const ws = ctx.db.select().from(workspaces).get()!;
    const other = ctx.db
      .insert(workspaces)
      .values({ name: 'Other', workingDir: '/tmp/other', createdAt: now, updatedAt: now })
      .returning()
      .get();
    const seed = (workspaceId: number): void => {
      const task = ctx.db
        .insert(tasks)
        .values({ prompt: 'p', state: 'ready', workingDir: '/tmp', createdAt: now, updatedAt: now, workspaceId })
        .returning()
        .get();
      ctx.db.insert(runs).values({ taskId: task.id, attempt: 1, state: 'completed', startedAt: now }).run();
    };
    seed(ws.id);
    seed(other.id);

    const readSpy = vi.spyOn(ctx.asyncReadDb, 'read');
    const scoped = await server.api('GET', `/api/stats?from=0&to=${now + 1000}&workspaceId=${other.id}`);

    expect(scoped.status).toBe(200);
    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(scoped.body.runCount).toBe(1);
  });
});
