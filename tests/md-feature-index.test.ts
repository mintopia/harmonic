import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../src/db/index.js';
import { defaultConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import { allWorkspaces } from './helpers.js';

describe('TaskService.mdFeatureIndex', () => {
  let dir: string;
  let db: Db;
  let tasks: TaskService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'md-idx-'));
    db = openDb(dir);
    tasks = new TaskService(db, () => defaultConfig(), allWorkspaces(db));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('assigns dense first-seen indices, stable across re-queries', () => {
    expect(tasks.mdFeatureIndex(1, 'musicparty-soloist')).toBe(0);
    expect(tasks.mdFeatureIndex(1, 'autoplay-webhooks')).toBe(1);
    // Re-query in any order returns the same index — the assignment is persisted.
    expect(tasks.mdFeatureIndex(1, 'autoplay-webhooks')).toBe(1);
    expect(tasks.mdFeatureIndex(1, 'musicparty-soloist')).toBe(0);
    // A later feature never steals an earlier one's index (the recycling bug).
    expect(tasks.mdFeatureIndex(1, 'a-sorts-first')).toBe(2);
  });

  it('namespaces indices per Workspace', () => {
    expect(tasks.mdFeatureIndex(1, 'feat')).toBe(0);
    expect(tasks.mdFeatureIndex(2, 'feat')).toBe(0); // different Workspace, own map
    expect(tasks.mdFeatureIndex(2, 'other')).toBe(1);
    expect(tasks.mdFeatureIndex(1, 'feat')).toBe(0);
  });

  it('survives a fresh TaskService over the same db (persisted in settings)', () => {
    expect(tasks.mdFeatureIndex(1, 'alpha')).toBe(0);
    expect(tasks.mdFeatureIndex(1, 'beta')).toBe(1);
    const reopened = new TaskService(db, () => defaultConfig(), allWorkspaces(db));
    expect(reopened.mdFeatureIndex(1, 'beta')).toBe(1);
    expect(reopened.mdFeatureIndex(1, 'gamma')).toBe(2);
  });
});
