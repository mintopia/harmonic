import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { defaultConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import type { SettingsStore } from '../src/server/settings-store.js';
import { allWorkspaces, makeSettingsStore } from './helpers.js';

describe('TaskService.mdFeatureIndex', () => {
  let dir: string;
  let asyncDb: AsyncDbHandle;
  let settingsStore: SettingsStore;
  let tasks: TaskService;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'md-idx-'));
    asyncDb = await openAsyncDb(dir);
    settingsStore = await makeSettingsStore(dir);
    tasks = new TaskService(asyncDb, () => defaultConfig(), allWorkspaces(asyncDb, settingsStore));
  });
  afterEach(async () => {
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('assigns dense first-seen indices, stable across re-queries', async () => {
    expect(await tasks.mdFeatureIndex(1, 'musicparty-soloist')).toBe(0);
    expect(await tasks.mdFeatureIndex(1, 'autoplay-webhooks')).toBe(1);
    expect(await tasks.mdFeatureIndex(1, 'autoplay-webhooks')).toBe(1);
    expect(await tasks.mdFeatureIndex(1, 'musicparty-soloist')).toBe(0);
    expect(await tasks.mdFeatureIndex(1, 'a-sorts-first')).toBe(2);
  });

  it('namespaces indices per Workspace', async () => {
    expect(await tasks.mdFeatureIndex(1, 'feat')).toBe(0);
    expect(await tasks.mdFeatureIndex(2, 'feat')).toBe(0);
    expect(await tasks.mdFeatureIndex(2, 'other')).toBe(1);
    expect(await tasks.mdFeatureIndex(1, 'feat')).toBe(0);
  });

  it('survives a fresh TaskService over the same db (persisted in settings)', async () => {
    expect(await tasks.mdFeatureIndex(1, 'alpha')).toBe(0);
    expect(await tasks.mdFeatureIndex(1, 'beta')).toBe(1);
    const reopened = new TaskService(asyncDb, () => defaultConfig(), allWorkspaces(asyncDb, settingsStore));
    expect(await reopened.mdFeatureIndex(1, 'beta')).toBe(1);
    expect(await reopened.mdFeatureIndex(1, 'gamma')).toBe(2);
  });
});
