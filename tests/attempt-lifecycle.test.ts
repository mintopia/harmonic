import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { baselineConfig } from '../src/config.js';
import { AttemptStore } from '../src/domain/attempts.js';
import { TaskService } from '../src/domain/tasks.js';
import type { SettingsStore } from '../src/server/settings-store.js';
import { allWorkspaces, makeSettingsStore, seedWorkspace } from './helpers.js';

describe('AttemptStore.markInterrupted also fails an orphaned attempt\'s still-running steps', () => {
  let dir: string;
  let db: AsyncDbHandle;
  let settingsStore: SettingsStore;
  let tasks: TaskService;
  let attempts: AttemptStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-crash-steps-'));
    db = await openAsyncDb(dir);
    await seedWorkspace(db);
    settingsStore = await makeSettingsStore(dir);
    tasks = new TaskService(db, () => baselineConfig(), allWorkspaces(db, settingsStore));
    attempts = new AttemptStore(db);
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('fails the orphaned running attempt', async () => {
    const task = await tasks.create({ prompt: 'crash mid-implementation', state: 'ready' });
    const run = await attempts.create(task.id);
    await attempts.addAgentDuration(run.id, 25);

    const orphans = await attempts.markInterrupted();

    expect(orphans.map((attempt) => attempt.id)).toEqual([run.id]);
    expect(await attempts.get(run.id)).toMatchObject({ state: 'failed', reason: 'process-death', agentDurationMs: null });
  });
});
