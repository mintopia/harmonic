import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { defaultConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import { RunStore, type RunGuardrailSnapshot } from '../src/domain/runs.js';
import { isForeignKeyViolation } from '../src/db/errors.js';
import { Runner } from '../src/execution/runner.js';
import type { SettingsStore } from '../src/server/settings-store.js';
import { allWorkspaces, makeSettingsStore } from './helpers.js';

describe('isForeignKeyViolation', () => {
  it('detects a drizzle-wrapped FK violation via the cause chain', () => {
    const cause = Object.assign(new Error('FOREIGN KEY constraint failed'), {
      code: 'SQLITE_CONSTRAINT',
      extendedCode: 'SQLITE_CONSTRAINT_FOREIGNKEY',
    });
    const wrapped = Object.assign(new Error('Failed query: insert into "guardrail_events" ...'), { cause });
    expect(isForeignKeyViolation(wrapped)).toBe(true);
  });

  it('does not mistake a UNIQUE violation for an FK one', () => {
    const cause = Object.assign(new Error('UNIQUE constraint failed: guardrail_events.attempt_id, guardrail_events.seq'), {
      extendedCode: 'SQLITE_CONSTRAINT_UNIQUE',
    });
    expect(isForeignKeyViolation(Object.assign(new Error('Failed query'), { cause }))).toBe(false);
  });
});

describe('Runner.cancelForTask — run row deleted mid-settle', () => {
  let dir: string;
  let repoDir: string;
  let asyncDb: AsyncDbHandle;
  let settingsStore: SettingsStore;
  let tasks: TaskService;
  let runs: RunStore;
  let runner: Runner;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-cancel-gone-'));
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

  it('resolves as a no-op (no crash, nothing logged) when the run vanishes between read and settle', async () => {
    const task = await tasks.create({ prompt: 'cancel me', isolationMode: 'direct', workingDir: repoDir });
    const snapshot: RunGuardrailSnapshot = {
      guardrailConfig: defaultConfig().guardrails,
      priceTable: defaultConfig().prices,
    };
    await runs.create(task.id, snapshot);

    // Reproduce the production TOCTOU: settleTaskRun's parked branch lists the
    // still-running row, then reads it via runStore.get — but a racing delete
    // (e.g. a task-delete cascade) removes the row before the coordinator's own
    // re-read inside settle(). Delete on read to force that window; the second
    // read then throws `not_found` (ADR-0001 #388 S-E's settle is a guarded
    // UPDATE, not an INSERT with an FK to fail).
    const realGet = runs.get.bind(runs);
    vi.spyOn(runs, 'get').mockImplementation(async (id: number) => {
      const row = await realGet(id);
      await runs.delete(id);
      return row;
    });

    // The guard swallows the run-gone `not_found` as an expected no-op, so
    // cancelForTask's own containment catch (which logs) is never reached: no
    // error is logged. Without the guard the error would propagate to that
    // catch (a logged error) — asserting console.error stays quiet is what
    // proves the root-cause guard, not just the containment layer.
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(runner.cancelForTask(task.id)).resolves.toBeUndefined();
    expect(logged).not.toHaveBeenCalled();
  });
});
