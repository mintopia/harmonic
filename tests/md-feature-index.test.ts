import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../src/db/index.js';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { defaultConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import { allWorkspaces } from './helpers.js';

describe('TaskService.mdFeatureIndex', () => {
  let dir: string;
  let db: Db;
  let asyncDb: AsyncDbHandle;
  let tasks: TaskService;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'md-idx-'));
    db = openDb(dir);
    asyncDb = await openAsyncDb(dir);
    tasks = new TaskService(asyncDb, () => defaultConfig(), allWorkspaces(db));
  });
  afterEach(async () => {
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('assigns dense first-seen indices, stable across re-queries', async () => {
    expect(await tasks.mdFeatureIndex(1, 'musicparty-soloist')).toBe(0);
    expect(await tasks.mdFeatureIndex(1, 'autoplay-webhooks')).toBe(1);
    // Re-query in any order returns the same index — the assignment is persisted.
    expect(await tasks.mdFeatureIndex(1, 'autoplay-webhooks')).toBe(1);
    expect(await tasks.mdFeatureIndex(1, 'musicparty-soloist')).toBe(0);
    // A later feature never steals an earlier one's index (the recycling bug).
    expect(await tasks.mdFeatureIndex(1, 'a-sorts-first')).toBe(2);
  });

  it('namespaces indices per Workspace', async () => {
    expect(await tasks.mdFeatureIndex(1, 'feat')).toBe(0);
    expect(await tasks.mdFeatureIndex(2, 'feat')).toBe(0); // different Workspace, own map
    expect(await tasks.mdFeatureIndex(2, 'other')).toBe(1);
    expect(await tasks.mdFeatureIndex(1, 'feat')).toBe(0);
  });

  it('survives a fresh TaskService over the same db (persisted in settings)', async () => {
    expect(await tasks.mdFeatureIndex(1, 'alpha')).toBe(0);
    expect(await tasks.mdFeatureIndex(1, 'beta')).toBe(1);
    const reopened = new TaskService(asyncDb, () => defaultConfig(), allWorkspaces(db));
    expect(await reopened.mdFeatureIndex(1, 'beta')).toBe(1);
    expect(await reopened.mdFeatureIndex(1, 'gamma')).toBe(2);
  });
});
