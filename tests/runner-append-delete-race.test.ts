import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { defaultConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import { RunStore, type RunGuardrailSnapshot } from '../src/domain/runs.js';
import { Runner } from '../src/execution/runner.js';
import type { TaskRow, RunRow } from '../src/db/schema.js';
import type { SettingsStore } from '../src/server/settings-store.js';
import { allWorkspaces, makeSettingsStore } from './helpers.js';

describe('Runner.recordRunEvent — task deleted mid-append (issue #371)', () => {
  let dir: string;
  let repoDir: string;
  let asyncDb: AsyncDbHandle;
  let settingsStore: SettingsStore;
  let tasks: TaskService;
  let runs: RunStore;
  let runner: Runner;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-append-race-'));
    repoDir = join(dir, 'repo');
    mkdirSync(repoDir);
    asyncDb = await openAsyncDb(dir);
    settingsStore = await makeSettingsStore(dir);
    tasks = new TaskService(asyncDb, () => defaultConfig(), allWorkspaces(asyncDb, settingsStore));
    runs = new RunStore(asyncDb);
    runner = new Runner(runs, tasks, asyncDb, () => defaultConfig());
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    runner.shutdown();
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('swallows the FK rejection when the run row is gone, so the append never crashes the process', async () => {
    const task = await tasks.create({ prompt: 'delete me mid-append', isolationMode: 'direct', workingDir: repoDir });
    const snapshot: RunGuardrailSnapshot = {
      guardrailConfig: defaultConfig().guardrails,
      priceTable: defaultConfig().prices,
    };
    const run = await runs.create(task.id, snapshot);

    // The production race: the task (still 'ready', so deletable) is deleted,
    // cascading its Run + run_events away, before an in-flight turn's event
    // append lands — the append then FK-violates against the vanished Run.
    await tasks.delete(task.id);

    // Without containment this rejection reaches the process as an unhandled
    // rejection and takes the whole server down. Assert none escapes.
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onRejection);
    try {
      (
        runner as unknown as {
          recordRunEvent: (t: TaskRow, r: RunRow, type: 'lifecycle', payload: unknown) => void;
        }
      ).recordRunEvent(task, run, 'lifecycle', { event: 'phase', phase: 'executing' });
      // Let the append promise reject and its `.catch` run.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }

    // The Run is gone; nothing was resurrected.
    expect(await runs.listForTask(task.id)).toEqual([]);
  });
});
