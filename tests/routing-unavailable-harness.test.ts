import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { baselineConfig, type AppConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import { AttemptStore } from '../src/domain/attempts.js';
import { Runner } from '../src/execution/runner.js';
import { executionPlumbing, allWorkspaces, makeSettingsStore, seedWorkspace } from './helpers.js';

describe('unavailable Harness at Attempt start (#822)', () => {
  let dir: string;
  let asyncDb: AsyncDbHandle;
  let tasks: TaskService;
  let runs: AttemptStore;
  let runner: Runner;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-unavailable-harness-'));
    const repoDir = join(dir, 'repo');
    mkdirSync(repoDir);
    asyncDb = await openAsyncDb(dir);
    await seedWorkspace(asyncDb);
    const settingsStore = await makeSettingsStore(dir);
    tasks = new TaskService(asyncDb, () => baselineConfig(), allWorkspaces(asyncDb, settingsStore));
    runs = new AttemptStore(asyncDb);
    const withoutClaude = (): AppConfig => {
      const config = baselineConfig();
      delete (config.harnesses as Record<string, unknown>).claude;
      return config;
    };
    runner = new Runner(tasks, asyncDb, withoutClaude, executionPlumbing());
  });

  afterEach(async () => {
    await runner.shutdown();
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('escalates naming the Harness, starts no run, and a Harness set on the escalated Ticket requeues it', async () => {
    const task = await tasks.create({ prompt: 'needs claude', isolationMode: 'worktree', workingDir: dir, harness: 'claude' });
    const claimed = await tasks.claimReady(task.id);
    expect(claimed).toBeTruthy();

    await runner.launchClaimed(task.id);

    const escalated = await tasks.get(task.id);
    expect(escalated.state).toBe('escalated');
    expect(escalated.harness).toBe('claude');
    const attempts = await runs.listForTask(task.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.state).toBe('escalated');
    expect(escalated.escalationReason).toContain("Harness 'claude' is not configured");

    const updated = await tasks.update(task.id, { harness: 'codex' });
    expect(updated.harness).toBe('codex');
    await expect(tasks.update(task.id, { prompt: 'rewrite' })).rejects.toThrow(/only draft, ready/);
    await tasks.requeue(task.id);
    expect((await tasks.get(task.id)).state).toBe('ready');
  });
});
