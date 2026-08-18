import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { openDb, type Db } from '../src/db/index.js';
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
  let tasksSvc: TaskService;
  let removedIds: number[];

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'harmonic-task-del-'));
    db = openDb(dataDir);
    removedIds = [];
    tasksSvc = new TaskService(
      db,
      () => defaultConfig(),
      allWorkspaces(db),
      () => {},
      () => {},
      (id) => removedIds.push(id),
    );
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('removes the tasks row for a native task', () => {
    const task = tasksSvc.create({ prompt: 'delete me' });
    tasksSvc.delete(task.id);
    expect(() => tasksSvc.get(task.id)).toThrowError(/not found/);
  });

  it('cascades Runs and their children (run_events, run_facts) with no FK error', () => {
    const task = tasksSvc.create({ prompt: 'has runs' });
    const runId = db
      .insert(runs)
      .values({ taskId: task.id, attempt: 1, state: 'completed', startedAt: Date.now(), finishedAt: Date.now() })
      .returning({ id: runs.id })
      .get()!.id;
    db.insert(runEvents).values({ runId, seq: 1, ts: Date.now(), type: 'lifecycle', payload: '{}' }).run();
    db.insert(runFacts).values({ runId, seq: 1, ts: Date.now(), type: 'failed', payload: '{}' }).run();

    expect(() => tasksSvc.delete(task.id)).not.toThrow();

    expect(db.select().from(runs).where(eq(runs.taskId, task.id)).all()).toHaveLength(0);
    expect(db.select().from(runEvents).where(eq(runEvents.runId, runId)).all()).toHaveLength(0);
    expect(db.select().from(runFacts).where(eq(runFacts.runId, runId)).all()).toHaveLength(0);
  });

  it('removes dependency edges in both directions and re-derives a former dependent blocked→ready', () => {
    const blocker = tasksSvc.create({ prompt: 'blocker' });
    const dependent = tasksSvc.create({ prompt: 'dependent', dependsOn: [blocker.id] });
    expect(tasksSvc.get(dependent.id).state).toBe('blocked');

    // Also give the blocker a dependency of its own, to prove the taskId-side edge is removed too.
    const grandBlocker = tasksSvc.create({ prompt: 'grand-blocker' });
    tasksSvc.addDependency(blocker.id, grandBlocker.id);

    tasksSvc.delete(blocker.id);

    const remaining = db
      .select()
      .from(taskDependencies)
      .all()
      .filter((r) => r.taskId === blocker.id || r.dependsOnId === blocker.id);
    expect(remaining).toHaveLength(0);
    expect(tasksSvc.get(dependent.id).state).toBe('ready');
  });

  it('nulls a re-attempt reattemptOf instead of deleting it when the original is deleted', () => {
    const original = tasksSvc.create({ prompt: 'original' });
    // reattempt requires a terminal state.
    tasksSvc.setState(original.id, 'running');
    tasksSvc.setState(original.id, 'failed');
    const reattempt = tasksSvc.reattempt(original.id, 'try again');
    expect(reattempt.reattemptOf).toBe(original.id);

    tasksSvc.delete(original.id);

    expect(tasksSvc.get(reattempt.id).reattemptOf).toBeNull();
  });

  it('throws invalid_state for a running task and leaves it intact', () => {
    const task = tasksSvc.create({ prompt: 'busy' });
    tasksSvc.setState(task.id, 'running');

    expect(() => tasksSvc.delete(task.id)).toThrowError(/running/);
    expect(tasksSvc.get(task.id).state).toBe('running');
  });

  it('writes a tracker_dismissals row and removes the task for a mirrored delete; a second delete throws not_found', () => {
    const workspace = allWorkspaces(db)()[0]!;
    const mirrored = tasksSvc.upsertMirrored(
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

    tasksSvc.delete(mirrored.id);

    const tombstones = db
      .select()
      .from(trackerDismissals)
      .where(eq(trackerDismissals.trackerRef, 4242))
      .all();
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0]!.workspaceId).toBe(workspace.id);
    expect(db.select().from(tasks).where(eq(tasks.id, mirrored.id)).all()).toHaveLength(0);

    expect(() => tasksSvc.delete(mirrored.id)).toThrowError(/not found/);
  });

  it('keeps a Session another Task still references, and removes it once orphaned', () => {
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
    const taskA = tasksSvc.create({ prompt: 'shares a session' });
    const taskB = tasksSvc.create({ prompt: 'also shares it' });
    const mk = (taskId: number) =>
      db
        .insert(runs)
        .values({ taskId, attempt: 1, state: 'completed', sessionRowId: sessionId, startedAt: Date.now() })
        .run();
    mk(taskA.id);
    mk(taskB.id);

    // Deleting A must not FK-violate on the shared Session, and must leave it.
    expect(() => tasksSvc.delete(taskA.id)).not.toThrow();
    expect(db.select().from(sessions).where(eq(sessions.id, sessionId)).all()).toHaveLength(1);
    expect(db.select().from(runs).where(eq(runs.taskId, taskB.id)).all()).toHaveLength(1);

    // Once B (the last referrer) goes, the now-orphaned Session is removed.
    tasksSvc.delete(taskB.id);
    expect(db.select().from(sessions).where(eq(sessions.id, sessionId)).all()).toHaveLength(0);
  });

  it('fires onRemoved with the deleted id', () => {
    const task = tasksSvc.create({ prompt: 'watch me go' });
    tasksSvc.delete(task.id);
    expect(removedIds).toEqual([task.id]);
  });
});
