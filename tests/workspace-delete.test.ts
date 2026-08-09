import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../src/db/index.js';
import { defaultConfig } from '../src/config.js';
import { WorkspaceService } from '../src/domain/workspaces.js';
import { TaskService } from '../src/domain/tasks.js';
import { allWorkspaces } from './helpers.js';

/**
 * Delete-guard behaviour after issue #61: the "refuse the last Workspace" guard
 * is gone, but the "refuse a running Task" guard stays.
 */
describe('WorkspaceService.delete guards (issue #61)', () => {
  let dataDir: string;
  let db: Db;
  let workspaces: WorkspaceService;
  let tasks: TaskService;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'harmonic-ws-del-'));
    db = openDb(dataDir); // backfills the single Default Workspace
    workspaces = new WorkspaceService(db);
    tasks = new TaskService(db, () => defaultConfig(), allWorkspaces(db));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('deletes the last remaining Workspace (no more last-Workspace guard)', () => {
    const only = workspaces.list()[0]!;
    expect(workspaces.list()).toHaveLength(1);

    expect(() => workspaces.delete(only.id)).not.toThrow();
    expect(workspaces.list()).toHaveLength(0);
  });

  it('still refuses a Workspace with a running Task (409/conflict)', () => {
    const ws = workspaces.list()[0]!;
    const task = tasks.create({ prompt: 'busy' });
    tasks.setState(task.id, 'running');

    expect(() => workspaces.delete(ws.id)).toThrowError(/running task/);
    expect(workspaces.list()).toHaveLength(1); // untouched
  });
});
