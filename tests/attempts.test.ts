import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { defaultConfig } from '../src/config.js';
import { AttemptStore } from '../src/domain/attempts.js';
import { TaskService } from '../src/domain/tasks.js';
import type { SettingsStore } from '../src/server/settings-store.js';
import { allWorkspaces, makeSettingsStore } from './helpers.js';

describe('AttemptStore', () => {
  let dir: string;
  let db: AsyncDbHandle;
  let settingsStore: SettingsStore;
  let attempts: AttemptStore;
  let taskId: number;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-attempts-'));
    db = await openAsyncDb(dir);
    settingsStore = await makeSettingsStore(dir);
    const tasks = new TaskService(db, () => defaultConfig(), allWorkspaces(db, settingsStore));
    taskId = (await tasks.create({ prompt: 'timeline', state: 'ready' })).id;
    attempts = new AttemptStore(db);
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('ensures numbered attempts per ticket and orders their task timeline', async () => {
    const first = await attempts.ensureForRun(taskId, 1, 10);
    const second = await attempts.ensureForRun(taskId, 2, 20);
    expect(await attempts.ensureForRun(taskId, 1, 99)).toEqual(first);
    expect((await attempts.listForTask(taskId)).map((attempt) => attempt.number)).toEqual([1, 2]);

    const implementation = await attempts.createTask(first.id, { type: 'implementation', logLocator: 'session:1' });
    const verification = await attempts.createTask(first.id, { type: 'verification', command: 'npm test', logLocator: 'output:1' });
    await attempts.updateTask(implementation.id, { state: 'passed', verdict: 'pass', startedAt: 11, endedAt: 12 });
    await attempts.updateTask(verification.id, { state: 'passed', verdict: 'pass', startedAt: 13, endedAt: 14 });
    await attempts.finish(first.id, 'passed', 15);

    expect(await attempts.listTasks(first.id)).toMatchObject([
      { type: 'implementation', position: 1, state: 'passed', logLocator: 'session:1' },
      { type: 'verification', position: 2, state: 'passed', command: 'npm test', logLocator: 'output:1' },
    ]);
    expect(second.state).toBe('running');
  });
});
