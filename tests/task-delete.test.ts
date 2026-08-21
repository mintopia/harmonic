import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { openDb, type Db } from '../src/db/index.js';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { defaultConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import { runs, runEvents, runFacts, sessions, taskDependencies, trackerDismissals, tasks } from '../src/db/schema.js';
import { allWorkspaces } from './helpers.js';

/**
 * `TaskService.delete` (issue #162, ADR-0025): hard-delete cascades the whole
 * Run tree in one transaction, edits Dependency/reattempt back-references so
 * nothing dangles, tombstones a mirrored ref so `mirrorScan` can't resurrect
 * it, and is guarded to a Task that isn't `running`.
 */
describe('TaskService.delete (issue #162)', () => {
  let dataDir: string;
  let db: Db;
  let asyncDb: AsyncDbHandle;
  let tasksSvc: TaskService;
  let removedIds: number[];

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'harmonic-task-del-'));
    db = openDb(dataDir);
    asyncDb = await openAsyncDb(dataDir);
    removedIds = [];
    tasksSvc = new TaskService(
      asyncDb,
      () => defaultConfig(),
      allWorkspaces(db),
      () => {},
      () => {},
      (id) => removedIds.push(id),
    );
  });
  afterEach(async () => {
    await asyncDb.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('removes the tasks row for a native task', async () => {
    const task = await tasksSvc.create({ prompt: 'delete me' });
    await tasksSvc.delete(task.id);
    await expect(tasksSvc.get(task.id)).rejects.toThrow(/not found/);
  });

  it('cascades Runs and their children (run_events, run_facts) with no FK error', async () => {
    const task = await tasksSvc.create({ prompt: 'has runs' });
    const runId = db
      .insert(runs)
      .values({ taskId: task.id, attempt: 1, state: 'completed', startedAt: Date.now(), finishedAt: Date.now() })
      .returning({ id: runs.id })
      .get()!.id;
    db.insert(runEvents).values({ runId, seq: 1, ts: Date.now(), type: 'lifecycle', payload: '{}' }).run();
    db.insert(runFacts).values({ runId, seq: 1, ts: Date.now(), type: 'failed', payload: '{}' }).run();

    await tasksSvc.delete(task.id);

    expect(db.select().from(runs).where(eq(runs.taskId, task.id)).all()).toHaveLength(0);
    expect(db.select().from(runEvents).where(eq(runEvents.runId, runId)).all()).toHaveLength(0);
    expect(db.select().from(runFacts).where(eq(runFacts.runId, runId)).all()).toHaveLength(0);
  });

  it('removes dependency edges in both directions and re-derives a former dependent blocked→ready', async () => {
    const blocker = await tasksSvc.create({ prompt: 'blocker' });
    const dependent = await tasksSvc.create({ prompt: 'dependent', dependsOn: [blocker.id] });
    expect((await tasksSvc.get(dependent.id)).state).toBe('blocked');

    // Also give the blocker a dependency of its own, to prove the taskId-side edge is removed too.
    const grandBlocker = await tasksSvc.create({ prompt: 'grand-blocker' });
    await tasksSvc.addDependency(blocker.id, grandBlocker.id);

    await tasksSvc.delete(blocker.id);

    const remaining = db
      .select()
      .from(taskDependencies)
      .all()
      .filter((r) => r.taskId === blocker.id || r.dependsOnId === blocker.id);
    expect(remaining).toHaveLength(0);
    expect((await tasksSvc.get(dependent.id)).state).toBe('ready');
  });

  it('nulls a re-attempt reattemptOf instead of deleting it when the original is deleted', async () => {
    const original = await tasksSvc.create({ prompt: 'original' });
    // reattempt requires a terminal state.
    await tasksSvc.setState(original.id, 'running');
    await tasksSvc.setState(original.id, 'failed');
    const reattempt = await tasksSvc.reattempt(original.id, 'try again');
    expect(reattempt.reattemptOf).toBe(original.id);

    await tasksSvc.delete(original.id);

    expect((await tasksSvc.get(reattempt.id)).reattemptOf).toBeNull();
  });

  it('throws invalid_state for a running task and leaves it intact', async () => {
    const task = await tasksSvc.create({ prompt: 'busy' });
    await tasksSvc.setState(task.id, 'running');

    await expect(tasksSvc.delete(task.id)).rejects.toThrow(/running/);
    expect((await tasksSvc.get(task.id)).state).toBe('running');
  });

  it('writes a tracker_dismissals row and removes the task for a mirrored delete; a second delete throws not_found', async () => {
    const workspace = (await allWorkspaces(db)())[0]!;
    const mirrored = await tasksSvc.upsertMirrored(
      {
        trackerRef: 4242,
        prompt: 'mirrored issue',
        workflow: 'implement',
        wayfinderType: null,
        drive: 'afk',
        mapRef: null,
        closed: false,
      },
      workspace.id,
    );

    await tasksSvc.delete(mirrored.id);

    const tombstones = db
      .select()
      .from(trackerDismissals)
      .where(eq(trackerDismissals.trackerRef, 4242))
      .all();
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0]!.workspaceId).toBe(workspace.id);
    expect(db.select().from(tasks).where(eq(tasks.id, mirrored.id)).all()).toHaveLength(0);

    await expect(tasksSvc.delete(mirrored.id)).rejects.toThrow(/not found/);
  });

  it('keeps a Session another Task still references, and removes it once orphaned', async () => {
    const sessionId = db
      .insert(sessions)
      .values({
        harness: 'claude',
        harnessSessionId: 's-shared',
        model: 'm',
        cwd: '/tmp',
        lastActiveAt: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .returning({ id: sessions.id })
      .get()!.id;
    const taskA = await tasksSvc.create({ prompt: 'shares a session' });
    const taskB = await tasksSvc.create({ prompt: 'also shares it' });
    const mk = (taskId: number) =>
      db
        .insert(runs)
        .values({ taskId, attempt: 1, state: 'completed', sessionRowId: sessionId, startedAt: Date.now() })
        .run();
    mk(taskA.id);
    mk(taskB.id);

    // Deleting A must not FK-violate on the shared Session, and must leave it.
    await tasksSvc.delete(taskA.id);
    expect(db.select().from(sessions).where(eq(sessions.id, sessionId)).all()).toHaveLength(1);
    expect(db.select().from(runs).where(eq(runs.taskId, taskB.id)).all()).toHaveLength(1);

    // Once B (the last referrer) goes, the now-orphaned Session is removed.
    await tasksSvc.delete(taskB.id);
    expect(db.select().from(sessions).where(eq(sessions.id, sessionId)).all()).toHaveLength(0);
  });

  it('fires onRemoved with the deleted id', async () => {
    const task = await tasksSvc.create({ prompt: 'watch me go' });
    await tasksSvc.delete(task.id);
    expect(removedIds).toEqual([task.id]);
  });
});
