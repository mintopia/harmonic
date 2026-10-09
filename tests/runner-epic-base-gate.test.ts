import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { baselineConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import { Runner } from '../src/execution/runner.js';
import type { EpicBaseGate } from '../src/execution/epic-coordinator.js';
import { executionPlumbing, allWorkspaces, makeSettingsStore, seedWorkspace } from './helpers.js';

describe('Runner.start Epic base gate', () => {
  let dir: string;
  let asyncDb: AsyncDbHandle;
  let tasks: TaskService;
  let runners: Runner[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-runner-epic-gate-'));
    asyncDb = await openAsyncDb(dir);
    await seedWorkspace(asyncDb);
    tasks = new TaskService(asyncDb, () => baselineConfig(), allWorkspaces(asyncDb, await makeSettingsStore(dir)));
    runners = [];
  });
  afterEach(async () => {
    for (const runner of runners) await runner.shutdown();
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const runnerGatedBy = (gate: EpicBaseGate): Runner => {
    const runner = new Runner(tasks, asyncDb, () => baselineConfig(), { ...executionPlumbing(), epicBaseNotReady: () => gate });
    runners.push(runner);
    return runner;
  };

  it('refuses a start on a stale integration branch with the refresh message', async () => {
    const task = await tasks.create({ prompt: 'member', state: 'ready', isolationMode: 'worktree' });
    await tasks.setBaseBranch(task.id, 'epic/10');

    await expect(runnerGatedBy('stale').start(task.id)).rejects.toThrow(/epic\/10\) is behind its base; it is refreshed when the blocking Epic is integrated/);
  });

  it('refuses a start on a missing integration branch with the cut message', async () => {
    const task = await tasks.create({ prompt: 'member', state: 'ready', isolationMode: 'worktree' });
    await tasks.setBaseBranch(task.id, 'epic/10');

    await expect(runnerGatedBy('missing').start(task.id)).rejects.toThrow(/not ready yet/);
  });
});
