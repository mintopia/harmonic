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

  it('fails the orphaned running attempt and closes its running step, leaving passed steps untouched', async () => {
    const task = await tasks.create({ prompt: 'crash mid-implementation', state: 'ready' });
    const run = await attempts.create(task.id);
    await attempts.addAgentDuration(run.id, 25);
    const rebase = await attempts.createStep(run.id, { type: 'rebase' });
    await attempts.updateStep(rebase.id, { state: 'passed', verdict: 'pass', endedAt: Date.now() - 1000 });
    const implementation = await attempts.createStep(run.id, { type: 'implementation', logLocator: 'session:pending' });
    await attempts.updateStep(implementation.id, { state: 'running', startedAt: Date.now() });

    const orphans = await attempts.markInterrupted();

    expect(orphans.map((attempt) => attempt.id)).toEqual([run.id]);
    expect(await attempts.get(run.id)).toMatchObject({ state: 'failed', reason: 'process-death', agentDurationMs: null });
    const steps = await attempts.listSteps(run.id);
    expect(steps).toMatchObject([
      { type: 'rebase', state: 'passed' },
      { type: 'implementation', state: 'failed' },
    ]);
    expect(steps.find((step) => step.type === 'implementation')?.endedAt).not.toBeNull();
  });
});
