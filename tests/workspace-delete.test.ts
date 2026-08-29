import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { trackerDismissals, runs, attempts, guardrailEvents } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { defaultConfig } from '../src/config.js';
import { WorkspaceService } from '../src/domain/workspaces.js';
import { TaskService } from '../src/domain/tasks.js';
import { allWorkspaces, makeSettingsStore } from './helpers.js';

/**
 * Delete-guard behaviour after issue #61: the "refuse the last Workspace" guard
 * is gone, but the "refuse a running Task" guard stays.
 */
describe('WorkspaceService.delete guards (issue #61)', () => {
  let dataDir: string;
  let asyncDb: AsyncDbHandle;
  let workspaces: WorkspaceService;
  let tasks: TaskService;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'harmonic-ws-del-'));
    asyncDb = await openAsyncDb(dataDir); // backfills the single Default Workspace
    const settingsStore = await makeSettingsStore(dataDir);
    workspaces = new WorkspaceService(asyncDb, settingsStore);
    tasks = new TaskService(asyncDb, () => defaultConfig(), allWorkspaces(asyncDb, settingsStore));
  });
  afterEach(async () => {
    await asyncDb.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('deletes the last remaining Workspace (no more last-Workspace guard)', async () => {
    const only = (await workspaces.list())[0]!;
    expect(await workspaces.list()).toHaveLength(1);

    await expect(workspaces.delete(only.id)).resolves.toBeUndefined();
    expect(await workspaces.list()).toHaveLength(0);
  });

  it('still refuses a Workspace with a running Task (409/conflict)', async () => {
    const ws = (await workspaces.list())[0]!;
    const task = await tasks.create({ prompt: 'busy' });
    await tasks.setState(task.id, 'working');

    await expect(workspaces.delete(ws.id)).rejects.toThrowError(/running task/);
    expect(await workspaces.list()).toHaveLength(1); // untouched
  });

  it('deletes a Workspace that has a dismissal tombstone (issue #162 FK)', async () => {
    const ws = (await workspaces.list())[0]!;
    // A Dismissed mirrored Task leaves a tombstone FK-bound to the Workspace;
    // deleting the Workspace must purge it first or foreign_keys=ON rejects it.
    await asyncDb.write((d) =>
      d.insert(trackerDismissals).values({ workspaceId: ws.id, trackerRef: 42, dismissedAt: Date.now() }).run(),
    );

    await expect(workspaces.delete(ws.id)).resolves.toBeUndefined();
    expect(await asyncDb.read((d) => d.select().from(trackerDismissals).all())).toHaveLength(0);
  });

  it('purges the whole Run/Attempt tree (guardrail_events), not just attempt_events, with no FK error (issue #162)', async () => {
    const ws = (await workspaces.list())[0]!;
    const task = await tasks.create({ prompt: 'has a run with guardrail events' });
    await asyncDb.write((d) =>
      d
        .insert(runs)
        .values({ taskId: task.id, attempt: 1, state: 'completed', startedAt: Date.now() })
        .returning({ id: runs.id })
        .get(),
    );
    const attemptId = (await asyncDb.write((d) =>
      d.insert(attempts).values({ taskId: task.id, number: 1, startedAt: Date.now() }).returning({ id: attempts.id }).get(),
    ))!.id;
    // Before #162 the Workspace cascade only deleted attempt_events, so a
    // sibling child row would FK-reject the attempts delete under foreign_keys=ON.
    await asyncDb.write((d) =>
      d.insert(guardrailEvents).values({
        attemptId, seq: 1, ts: Date.now(), dimension: 'wall-clock', limitValue: 1, observedValue: 1, configSource: 'default',
      }).run(),
    );

    await expect(workspaces.delete(ws.id)).resolves.toBeUndefined();
    expect(await asyncDb.read((d) => d.select().from(guardrailEvents).where(eq(guardrailEvents.attemptId, attemptId)).all())).toHaveLength(0);
  });
});
