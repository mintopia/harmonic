import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { tasks, type RawTaskRow } from '../src/db/schema.js';
import { baselineConfig, type AppConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import type { SettingsStore } from '../src/server/settings-store.js';
import { allWorkspaces, makeSettingsStore } from './helpers.js';

describe('claimReady pins resolved defaults onto the row (issue #480)', () => {
  let dir: string;
  let asyncDb: AsyncDbHandle;
  let settingsStore: SettingsStore;
  let config: AppConfig;
  let taskService: TaskService;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-claim-pins-'));
    asyncDb = await openAsyncDb(dir);
    settingsStore = await makeSettingsStore(dir);
    config = baselineConfig();
    taskService = new TaskService(asyncDb, () => config, allWorkspaces(asyncDb, settingsStore));
  });

  afterEach(async () => {
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function rawRow(id: number): Promise<RawTaskRow> {
    return (await asyncDb.read((db) => db.select().from(tasks).where(eq(tasks.id, id)).get()))!;
  }

  it('persists the resolved defaults onto an uninherited task at claim time', async () => {
    const task = await taskService.create({ prompt: 'no overrides', state: 'ready' });
    const before = await rawRow(task.id);
    expect(before.harness).toBeNull();
    expect(before.model).toBeNull();
    expect(before.isolationMode).toBeNull();
    expect(before.priority).toBeNull();
    expect(before.conflictResolveTurns).toBeNull();

    await taskService.claimReady(task.id);

    const after = await rawRow(task.id);
    expect(after.state).toBe('working');
    expect(after.harness).toBe('claude');
    expect(after.model).toBe('claude-sonnet-5');
    expect(after.isolationMode).toBe('direct');
    expect(after.priority).toBe('normal');
    expect(after.conflictResolveTurns).toBe(2);
  });

  it('keeps the pinned values even after the board defaults later change', async () => {
    const task = await taskService.create({ prompt: 'immune to drift', state: 'ready' });

    await taskService.claimReady(task.id);
    const pinned = await rawRow(task.id);
    expect(pinned.harness).toBe('claude');
    expect(pinned.model).toBe('claude-sonnet-5');
    expect(pinned.isolationMode).toBe('direct');
    expect(pinned.priority).toBe('normal');
    expect(pinned.conflictResolveTurns).toBe(2);

    config = {
      ...config,
      defaults: { ...config.defaults, harness: 'codex', isolationMode: 'worktree', priority: 'high', conflictResolveTurns: 9 },
    };

    const stillPinned = await rawRow(task.id);
    expect(stillPinned.harness).toBe('claude');
    expect(stillPinned.model).toBe('claude-sonnet-5');
    expect(stillPinned.isolationMode).toBe('direct');
    expect(stillPinned.priority).toBe('normal');
    expect(stillPinned.conflictResolveTurns).toBe(2);

    const resolved = await taskService.get(task.id);
    expect(resolved.harness).toBe('claude');
    expect(resolved.model).toBe('claude-sonnet-5');
    expect(resolved.isolationMode).toBe('direct');
    expect(resolved.priority).toBe('normal');
    expect(resolved.conflictResolveTurns).toBe(2);
  });

  it('leaves an explicit override untouched at claim time', async () => {
    const task = await taskService.create({ prompt: 'harness pinned by author', state: 'ready', harness: 'codex' });
    const before = await rawRow(task.id);
    expect(before.harness).toBe('codex');
    expect(before.model).toBeNull();

    await taskService.claimReady(task.id);

    const after = await rawRow(task.id);
    expect(after.harness).toBe('codex');
    expect(after.model).toBe('gpt-5.6-sol');
    expect(after.isolationMode).toBe('direct');
    expect(after.priority).toBe('normal');
    expect(after.conflictResolveTurns).toBe(2);
  });
});
