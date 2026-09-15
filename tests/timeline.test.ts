import { afterEach, describe, expect, it } from 'vitest';
import { attempts, tasks, workspaces } from '../src/db/schema.js';
import { startServer, type TestServer } from './helpers.js';

describe('fleet timeline route', () => {
  let server: TestServer | undefined;

  afterEach(async () => {
    await server?.close();
  });

  it('merges attempts from every Workspace when workspaceId is omitted, with Workspace identity and descending time order', async () => {
    server = await startServer();
    const { ctx } = server.app;
    const now = Date.now();
    const [defaultWorkspace] = await ctx.workspaces.list();
    const otherWorkspace = await ctx.asyncDb.write((db) =>
      db.insert(workspaces).values({
        name: 'Other',
        workingDir: '/tmp/other-workspace',
        color: '#3AA0FA',
        createdAt: now,
        updatedAt: now,
      }).returning().get(),
    );
    const addAttempt = async (workspaceId: number, title: string, startedAt: number) => {
      const task = await ctx.asyncDb.write((db) =>
        db.insert(tasks).values({
          prompt: title,
          state: 'done',
          workingDir: '/tmp',
          workspaceId,
          createdAt: now,
          updatedAt: now,
        }).returning().get(),
      );
      await ctx.asyncDb.write((db) =>
        db.insert(attempts).values({
          taskId: task.id,
          number: 1,
          state: 'passed',
          startedAt,
          endedAt: startedAt + 1_000,
        }).run(),
      );
      return task;
    };

    const older = await addAttempt(defaultWorkspace!.id, 'Default timeline task', now - 20_000);
    const newer = await addAttempt(otherWorkspace.id, 'Other timeline task', now - 10_000);

    const global = await server.api('GET', `/api/timeline?from=${now - 30_000}&to=${now}`);
    expect(global.status).toBe(200);
    expect(global.body.attempts).toMatchObject([
      { taskId: newer.id, workspace: { id: otherWorkspace.id, name: 'Other', color: '#3AA0FA' } },
      { taskId: older.id, workspace: { id: defaultWorkspace!.id, name: defaultWorkspace!.name, color: defaultWorkspace!.color } },
    ]);

    const scoped = await server.api('GET', `/api/timeline?workspaceId=${otherWorkspace.id}&from=${now - 30_000}&to=${now}`);
    expect(scoped.status).toBe(200);
    expect(scoped.body.attempts).toMatchObject([
      { taskId: newer.id, workspace: { id: otherWorkspace.id } },
    ]);
  });
});
