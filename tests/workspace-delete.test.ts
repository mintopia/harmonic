import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../src/db/index.js';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { trackerDismissals, runs, runFacts } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { defaultConfig } from '../src/config.js';
import { WorkspaceService } from '../src/domain/workspaces.js';
import { TaskService } from '../src/domain/tasks.js';
import { allWorkspaces } from './helpers.js';

/**
 * Delete-guard behaviour after issue #61: the "refuse the last Workspace" guard
 * is gone, but the "refuse a running Task" guard stays.
 */
describe('WorkspaceService.delete guards (issue #61)', () => {
  let dataDir: string;
  let db: Db;
  // TaskService migrated to the async libsql Db (ADR-0029); this fixture
  // runs both connections on the one file.
  let asyncDb: AsyncDbHandle;
  let workspaces: WorkspaceService;
  let tasks: TaskService;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'harmonic-ws-del-'));
    db = openDb(dataDir); // backfills the single Default Workspace
    asyncDb = await openAsyncDb(dataDir);
    workspaces = new WorkspaceService(db);
    tasks = new TaskService(asyncDb, () => defaultConfig(), allWorkspaces(db));
  });
  afterEach(async () => {
    await asyncDb.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('deletes the last remaining Workspace (no more last-Workspace guard)', () => {
    const only = workspaces.list()[0]!;
    expect(workspaces.list()).toHaveLength(1);

    expect(() => workspaces.delete(only.id)).not.toThrow();
    expect(workspaces.list()).toHaveLength(0);
  });

  it('still refuses a Workspace with a running Task (409/conflict)', async () => {
    const ws = workspaces.list()[0]!;
    const task = await tasks.create({ prompt: 'busy' });
    await tasks.setState(task.id, 'running');

    expect(() => workspaces.delete(ws.id)).toThrowError(/running task/);
    expect(workspaces.list()).toHaveLength(1); // untouched
  });

  it('deletes a Workspace that has a dismissal tombstone (issue #162 FK)', () => {
    const ws = workspaces.list()[0]!;
    // A Dismissed mirrored Task leaves a tombstone FK-bound to the Workspace;
    // deleting the Workspace must purge it first or foreign_keys=ON rejects it.
    db.insert(trackerDismissals).values({ workspaceId: ws.id, trackerRef: 42, dismissedAt: Date.now() }).run();

    expect(() => workspaces.delete(ws.id)).not.toThrow();
    expect(db.select().from(trackerDismissals).all()).toHaveLength(0);
  });

  it('purges the whole Run tree (run_facts), not just run_events, with no FK error (issue #162)', async () => {
    const ws = workspaces.list()[0]!;
    const task = await tasks.create({ prompt: 'has a run with facts' });
    const runId = db
      .insert(runs)
      .values({ taskId: task.id, attempt: 1, state: 'completed', startedAt: Date.now() })
      .returning({ id: runs.id })
      .get()!.id;
    // Before #162 the Workspace cascade only deleted run_events, so a run_fact
    // row would FK-reject the runs delete under foreign_keys=ON.
    db.insert(runFacts).values({ runId, seq: 1, ts: Date.now(), type: 'failed', payload: '{}' }).run();

    expect(() => workspaces.delete(ws.id)).not.toThrow();
    expect(db.select().from(runFacts).where(eq(runFacts.runId, runId)).all()).toHaveLength(0);
  });
});
