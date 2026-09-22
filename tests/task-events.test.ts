import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { tasks as tasksTable } from '../src/db/schema.js';
import { baselineConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import { TaskEventStore } from '../src/domain/task-events.js';
import { allWorkspaces, makeSettingsStore, seedWorkspace } from './helpers.js';

describe('TaskEventStore (owner decision: task-level events for actions with no Attempt)', () => {
  let dir: string;
  let asyncDb: AsyncDbHandle;
  let events: TaskEventStore;
  let taskId: number;
  let otherTaskId: number;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-task-events-'));
    asyncDb = await openAsyncDb(dir);
    await seedWorkspace(asyncDb);
    const settingsStore = await makeSettingsStore(dir);
    const tasks = new TaskService(asyncDb, () => baselineConfig(), allWorkspaces(asyncDb, settingsStore));
    events = new TaskEventStore(asyncDb);

    taskId = (await tasks.create({ prompt: 'p', state: 'ready' })).id;
    otherTaskId = (await tasks.create({ prompt: 'q', state: 'ready' })).id;
  });
  afterEach(async () => {
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('appends a payload and reads it back, JSON round-tripped', async () => {
    const row = await events.appendEvent(taskId, { event: 'ticket-closed', trackerRef: '7' });
    expect(row).toMatchObject({ taskId, payload: { event: 'ticket-closed', trackerRef: '7' } });

    const [back] = await events.listEvents(taskId);
    expect(back).toEqual(row);
  });

  it('listEvents returns only the given Task\'s rows, oldest first', async () => {
    await events.appendEvent(taskId, { event: 'a' });
    await events.appendEvent(taskId, { event: 'b' });
    await events.appendEvent(otherTaskId, { event: 'other' });

    const log = await events.listEvents(taskId);
    expect(log.map((e) => (e.payload as { event: string }).event)).toEqual(['a', 'b']);
  });

  it('listRecent returns newest first, capped at the given limit', async () => {
    await events.appendEvent(taskId, { event: 'a' });
    await events.appendEvent(taskId, { event: 'b' });
    await events.appendEvent(taskId, { event: 'c' });

    const log = await events.listRecent(taskId, 2);
    expect(log.map((e) => (e.payload as { event: string }).event)).toEqual(['c', 'b']);
  });

  it('is cascade-deleted when its Task is deleted', async () => {
    await events.appendEvent(taskId, { event: 'a' });
    await asyncDb.write((db) => db.delete(tasksTable).where(eq(tasksTable.id, taskId)).run());

    expect(await events.listEvents(taskId)).toEqual([]);
  });
});
