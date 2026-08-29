import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { attemptToolCalls, attempts, tasks, workspaces } from '../src/db/schema.js';
import { TaskService } from '../src/domain/tasks.js';
import { AttemptStore } from '../src/domain/attempts.js';
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
  let attemptIds: number[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-tool-call-aggregates-'));
    db = await openAsyncDb(dir);
    const settingsStore = await makeSettingsStore(dir);
    const taskService = new TaskService(db, () => defaultConfig(), allWorkspaces(db, settingsStore));
    const attemptStore = new AttemptStore(db);
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

    const now = Date.now();
    const madeAttempts = await Promise.all([
      attemptStore.ensureForRun(epicTaskId, 1, now),
      attemptStore.ensureForRun(epicTaskId, 2, now),
      attemptStore.ensureForRun(siblingTaskId, 1, now),
      attemptStore.ensureForRun(standaloneTaskId, 1, now),
      attemptStore.ensureForRun(otherWorkspaceTaskId, 1, now),
    ]);
    attemptIds = madeAttempts.map((attempt) => attempt.id);
    await db.write((d) =>
      d.insert(attemptToolCalls).values([
        { attemptId: madeAttempts[0]!.id, toolName: 'Bash', count: 2 },
        { attemptId: madeAttempts[0]!.id, toolName: 'Read', count: 1 },
        { attemptId: madeAttempts[1]!.id, toolName: 'Bash', count: 3 },
        { attemptId: madeAttempts[2]!.id, toolName: 'Read', count: 4 },
        { attemptId: madeAttempts[3]!.id, toolName: 'Bash', count: 8 },
        { attemptId: madeAttempts[4]!.id, toolName: 'Bash', count: 99 },
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
      await d.update(attempts).set({ startedAt: 10_000 }).where(eq(attempts.id, attemptIds[0]!)).run();
      await d.update(attempts).set({ startedAt: 20_000 }).where(eq(attempts.id, attemptIds[1]!)).run();
      await d.update(attempts).set({ startedAt: 15_000 }).where(eq(attempts.id, attemptIds[2]!)).run();
      await d.update(attempts).set({ startedAt: 9_999 }).where(eq(attempts.id, attemptIds[3]!)).run();
      await d.update(attempts).set({ startedAt: 15_000 }).where(eq(attempts.id, attemptIds[4]!)).run();
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
