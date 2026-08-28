import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { runToolCalls, runs, tasks, workspaces } from '../src/db/schema.js';
import { TaskService } from '../src/domain/tasks.js';
import { RunStore } from '../src/domain/runs.js';
import { ToolCallAggregateStore, totalsForRange } from '../src/domain/tool-call-aggregates.js';
import { defaultConfig } from '../src/config.js';
import { allWorkspaces, makeSettingsStore } from './helpers.js';

describe('ToolCallAggregateStore (issue #241)', () => {
  let dir: string;
  let db: AsyncDbHandle;
  let toolCalls: ToolCallAggregateStore;
  let workspaceId: number;
  let otherWorkspaceId: number;
  let epicTaskId: number;
  let siblingTaskId: number;
  let standaloneTaskId: number;
  let otherWorkspaceTaskId: number;
  let runIds: number[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-tool-call-aggregates-'));
    db = await openAsyncDb(dir);
    const settingsStore = await makeSettingsStore(dir);
    const taskService = new TaskService(db, () => defaultConfig(), allWorkspaces(db, settingsStore));
    const runStore = new RunStore(db);
    toolCalls = new ToolCallAggregateStore(db);

    const [workspace] = await allWorkspaces(db, settingsStore)();
    workspaceId = workspace!.id;
    otherWorkspaceId = (
      await db.write((d) =>
        d
          .insert(workspaces)
          .values({ name: 'Other workspace', workingDir: '/other-workspace', createdAt: Date.now(), updatedAt: Date.now() })
          .returning()
          .get(),
      )
    ).id;

    const epicTask = await taskService.create({ prompt: 'epic member', state: 'ready' });
    const siblingTask = await taskService.create({ prompt: 'another epic member', state: 'ready' });
    const standaloneTask = await taskService.create({ prompt: 'standalone task', state: 'ready' });
    epicTaskId = epicTask.id;
    siblingTaskId = siblingTask.id;
    standaloneTaskId = standaloneTask.id;

    await db.write((d) =>
      d.update(tasks).set({ mapRef: 701 }).where(eq(tasks.id, epicTaskId)).run(),
    );
    await db.write((d) =>
      d.update(tasks).set({ mapRef: 701 }).where(eq(tasks.id, siblingTaskId)).run(),
    );

    const otherWorkspace = await db.write((d) =>
      d
        .insert(tasks)
        .values({
          prompt: 'other workspace task',
          workingDir: '/other',
          state: 'ready',
          workspaceId: otherWorkspaceId,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })
        .returning()
        .get(),
    );
    otherWorkspaceTaskId = otherWorkspace.id;

    const runs = await Promise.all([
      runStore.create(epicTaskId),
      runStore.create(epicTaskId),
      runStore.create(siblingTaskId),
      runStore.create(standaloneTaskId),
      runStore.create(otherWorkspaceTaskId),
    ]);
    runIds = runs.map((run) => run.id);
    await db.write((d) =>
      d.insert(runToolCalls).values([
        { runId: runs[0]!.id, toolName: 'Bash', count: 2 },
        { runId: runs[0]!.id, toolName: 'Read', count: 1 },
        { runId: runs[1]!.id, toolName: 'Bash', count: 3 },
        { runId: runs[2]!.id, toolName: 'Read', count: 4 },
        { runId: runs[3]!.id, toolName: 'Bash', count: 8 },
        { runId: runs[4]!.id, toolName: 'Bash', count: 99 },
      ]).run(),
    );
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('rolls per-Run counts into Task and Epic totals, excluding standalone Tasks from Epics', async () => {
    await expect(toolCalls.totalsForWorkspace(workspaceId)).resolves.toEqual({
      byTask: {
        [epicTaskId]: { Bash: 5, Read: 1 },
        [siblingTaskId]: { Read: 4 },
        [standaloneTaskId]: { Bash: 8 },
      },
      byEpic: { 701: { Bash: 5, Read: 5 } },
    });
  });

  it('scopes totals to the requested Workspace', async () => {
    await expect(toolCalls.totalsForWorkspace(otherWorkspaceId)).resolves.toEqual({
      byTask: { [otherWorkspaceTaskId]: { Bash: 99 } },
      byEpic: {},
    });
  });

  it('rolls an inclusive Stats range into Task and Epic totals without crossing Workspaces', async () => {
    await db.write(async (d) => {
      await d.update(runs).set({ startedAt: 10_000 }).where(eq(runs.id, runIds[0]!)).run();
      await d.update(runs).set({ startedAt: 20_000 }).where(eq(runs.id, runIds[1]!)).run();
      await d.update(runs).set({ startedAt: 15_000 }).where(eq(runs.id, runIds[2]!)).run();
      await d.update(runs).set({ startedAt: 9_999 }).where(eq(runs.id, runIds[3]!)).run();
      await d.update(runs).set({ startedAt: 15_000 }).where(eq(runs.id, runIds[4]!)).run();
    });

    await expect(db.read((d) => totalsForRange(d, { from: 10_000, to: 20_000, workspaceId }))).resolves.toEqual({
      byTask: {
        [epicTaskId]: { Bash: 5, Read: 1 },
        [siblingTaskId]: { Read: 4 },
      },
      byEpic: { 701: { Bash: 5, Read: 5 } },
    });
  });
});
