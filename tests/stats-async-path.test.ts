import { describe, it, expect, afterEach, vi } from 'vitest';
import { startServer, stubHarness, type TestServer } from './helpers.js';
import { StatsWorkerClient } from '../src/db/stats-reader.js';
import { attemptToolCalls, attempts, runs, tasks, workspaces } from '../src/db/schema.js';
import { EventLoopMonitor, type StallInfo } from '../src/reliability/event-loop-monitor.js';

/**
 * #257 (ADR-0029 §5): the Stats range scan runs in a worker because local
 * libsql executes its supposedly async queries inline. These tests pin the
 * typed RPC, WAL visibility, lifecycle cleanup, and event-loop isolation.
 */
describe('Stats heavy aggregate runs in a worker (#257)', () => {
  let server: TestServer | undefined;

  afterEach(async () => {
    await server?.close();
  });

  it('wires the typed Stats worker client onto the app context', async () => {
    server = await startServer(stubHarness());
    expect(server.app.ctx.statsReader).toBeInstanceOf(StatsWorkerClient);
  });

  it('serves /api/stats through ctx.statsReader.read, with tool calls from their aggregate store', async () => {
    server = await startServer(stubHarness());
    const { ctx } = server.app;

    // The async single writer commits a run…
    const now = Date.now();
    const ws = (await ctx.asyncDb.read((d) => d.select().from(workspaces).get()))!;
    const task = await ctx.asyncDb.write((d) =>
      d
        .insert(tasks)
        .values({ prompt: 'p', state: 'ready', workingDir: '/tmp', createdAt: now, updatedAt: now, workspaceId: ws.id })
        .returning()
        .get(),
    );
    const run = await ctx.asyncDb.write((d) =>
      d
        .insert(runs)
        .values({
          taskId: task.id,
          attempt: 1,
          state: 'completed',
          startedAt: now,
          usage: JSON.stringify({ models: {}, totals: null, toolCalls: { Bash: 2 }, source: 'session-log' }),
        })
        .returning()
        .get(),
    );
    const attempt = await ctx.asyncDb.write((d) =>
      d.insert(attempts).values({ taskId: task.id, number: run.attempt, startedAt: now }).returning().get(),
    );
    await ctx.asyncDb.write((d) => d.insert(attemptToolCalls).values({ attemptId: attempt.id, toolName: 'Read', count: 3 }).run());

    // …and the aggregate is served off the async read connection, seeing it.
    const readSpy = vi.spyOn(ctx.statsReader, 'read');
    const res = await server.api('GET', `/api/stats?from=0&to=${now + 1000}`);

    expect(res.status).toBe(200);
    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(res.body.runCount).toBe(1);
    expect(res.body.runsByState).toEqual({ completed: 1 });
    expect(res.body.toolCalls).toEqual({ Read: 3 });
  });

  it('scopes by workspace through the async read path (tasks join)', async () => {
    server = await startServer(stubHarness());
    const { ctx } = server.app;

    const now = Date.now();
    const ws = (await ctx.asyncDb.read((d) => d.select().from(workspaces).get()))!;
    const other = await ctx.asyncDb.write((d) =>
      d
        .insert(workspaces)
        .values({ name: 'Other', workingDir: '/tmp/other', createdAt: now, updatedAt: now })
        .returning()
        .get(),
    );
    const seed = async (workspaceId: number): Promise<void> => {
      const task = await ctx.asyncDb.write((d) =>
        d
          .insert(tasks)
          .values({ prompt: 'p', state: 'ready', workingDir: '/tmp', createdAt: now, updatedAt: now, workspaceId })
          .returning()
          .get(),
      );
      await ctx.asyncDb.write((d) =>
        d.insert(runs).values({ taskId: task.id, attempt: 1, state: 'completed', startedAt: now }).run(),
      );
    };
    await seed(ws.id);
    await seed(other.id);

    const readSpy = vi.spyOn(ctx.statsReader, 'read');
    const scoped = await server.api('GET', `/api/stats?from=0&to=${now + 1000}&workspaceId=${other.id}`);

    expect(scoped.status).toBe(200);
    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(scoped.body.runCount).toBe(1);
  });

  it('keeps the event-loop monitor quiet during a deliberately heavy worker read', async () => {
    server = await startServer(stubHarness());
    const worker = new StatsWorkerClient(server.dataDir);
    const stalls: StallInfo[] = [];
    const monitor = new EventLoopMonitor({ probeMs: 10, stallMs: 100, onStall: (stall) => stalls.push(stall) });
    monitor.start();
    try {
      const startedAt = performance.now();
      const total = await worker.probeHeavyRead(6000);
      const elapsedMs = performance.now() - startedAt;
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(total).toBeGreaterThan(0);
      expect(elapsedMs).toBeGreaterThan(200);
      expect(stalls).toEqual([]);
      expect(monitor.underPressure).toBe(false);
    } finally {
      monitor.stop();
      await worker.close();
    }
  }, 30_000);

  it('gracefully closes the Stats worker and rejects later reads', async () => {
    server = await startServer(stubHarness());
    const reader = server.app.ctx.statsReader;
    const closeSpy = vi.spyOn(reader, 'close');
    await server.close();
    server = undefined;

    expect(closeSpy).toHaveBeenCalledOnce();
    await expect(reader.read({ from: 0, to: Date.now() })).rejects.toThrow('Stats worker is closed');
  });
});
