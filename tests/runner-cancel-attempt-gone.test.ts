import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { baselineConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import { AttemptStore, type AttemptGuardrailSnapshot } from '../src/domain/attempts.js';
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
  let runs: AttemptStore;
  let runner: Runner;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-cancel-gone-'));
    repoDir = join(dir, 'repo');
    mkdirSync(repoDir);
    asyncDb = await openAsyncDb(dir);
    settingsStore = await makeSettingsStore(dir);
    tasks = new TaskService(asyncDb, () => baselineConfig(), allWorkspaces(asyncDb, settingsStore));
    runs = new AttemptStore(asyncDb);
    runner = new Runner(tasks, asyncDb, () => baselineConfig());
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    runner.shutdown();
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('resolves as a no-op (no crash, nothing logged) when the run vanishes between read and settle', async () => {
    const task = await tasks.create({ prompt: 'cancel me', isolationMode: 'direct', workingDir: repoDir });
    const snapshot: AttemptGuardrailSnapshot = {
      guardrailConfig: baselineConfig().guardrails,
      priceTable: baselineConfig().prices,
    };
    await runs.create(task.id, snapshot);

    const realGet = runs.get.bind(runs);
    vi.spyOn(runs, 'get').mockImplementation(async (id: number) => {
      const row = await realGet(id);
      await runs.delete(id);
      return row;
    });

    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(runner.cancelForTask(task.id)).resolves.toBeUndefined();
    expect(logged).not.toHaveBeenCalled();
  });
});
