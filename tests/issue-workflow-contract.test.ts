import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@libsql/client';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { baselineConfig } from '../src/config.js';
import { TaskService, type MirrorInput } from '../src/domain/tasks.js';
import { trackerRef } from '../src/tracker/adapter.js';
import { taskToApiDto } from '../src/server/dto.js';
import { allWorkspaces, makeSettingsStore, seedWorkspace } from './helpers.js';

describe('Issue Workflow contract (ADR-0053)', () => {
  const seed = async (dir: string, shape: 'both' | 'old-only') => {
    const first = await openAsyncDb(dir);
    await first.close();
    const sqlite = createClient({ url: `file:${join(dir, 'harmonic.db')}` });
    await sqlite.execute("INSERT INTO workspaces (name, working_dir, tracker_enabled, tracker_poll_interval_seconds, created_at, updated_at) VALUES ('w', '/tmp/w', 0, 60, 1, 1)");
    await sqlite.execute('ALTER TABLE tasks ADD COLUMN workflow text');
    if (shape === 'old-only') await sqlite.execute('ALTER TABLE tasks DROP COLUMN issue_workflow');
    const column = shape === 'both' ? 'workflow, issue_workflow' : 'workflow';
    const marks = shape === 'both' ? '?, ?' : '?';
    const flows: Array<string | null> = ['wayfinder', 'implement', null];
    for (const [i, flow] of flows.entries()) {
      await sqlite.execute({
        sql: `INSERT INTO tasks (prompt, working_dir, state, workspace_id, ${column}, created_at, updated_at) VALUES (?, '/tmp/w', 'ready', 1, ${marks}, 1, 1)`,
        args: shape === 'both' ? [`t${i}`, flow, flow] : [`t${i}`, flow],
      });
    }
    return sqlite;
  };

  it.each(['both', 'old-only'] as const)('drops the old workflow column and keeps the data (%s)', async (shape) => {
    const dir = mkdtempSync(join(tmpdir(), 'harmonic-iw-mig-'));
    const sqlite = await seed(dir, shape);
    const second = await openAsyncDb(dir);
    await second.close();
    const columns = (await sqlite.execute('pragma table_info(`tasks`)')).rows.map((r) => String(r.name));
    expect(columns).not.toContain('workflow');
    expect(columns).toContain('issue_workflow');
    const rows = (await sqlite.execute('select issue_workflow from tasks order by id')).rows;
    expect(rows.map((r) => r.issue_workflow)).toEqual(['wayfinder', 'implement', null]);
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('mirror write', () => {
    let dir: string;
    let db: AsyncDbHandle;
    let tasks: TaskService;
    beforeEach(async () => {
      dir = mkdtempSync(join(tmpdir(), 'harmonic-iw-'));
      db = await openAsyncDb(dir);
      await seedWorkspace(db);
      const store = await makeSettingsStore(dir);
      tasks = new TaskService(db, () => baselineConfig(), allWorkspaces(db, store));
    });
    afterEach(async () => {
      await db.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const input = (over: Partial<MirrorInput>): MirrorInput => ({
      trackerRef: trackerRef(5), prompt: 'p', issueWorkflow: 'implement', wayfinderType: null, mapRef: null, closed: false, ...over,
    });

    it('writing issueWorkflow updates the column and the API returns it', async () => {
      const created = await tasks.upsertMirrored(input({ issueWorkflow: 'wayfinder' }));
      expect(created.issueWorkflow).toBe('wayfinder');
      const updated = await tasks.upsertMirrored(input({ issueWorkflow: 'implement' }));
      expect(updated.issueWorkflow).toBe('implement');
      const dto = taskToApiDto(
        { ...updated, overrides: { isolationMode: null, priority: null }, dependsOn: [], dependents: [], blockedOnFailed: false } as never,
        [],
        { toolCount: null, currentStep: null, hasCandidate: false, url: null, mapTitle: null, trackerLabel: null, skipReason: null, contextWindow: null },
      );
      expect(dto.issueWorkflow).toBe('implement');
      expect(dto).not.toHaveProperty('workflow');
    });
  });
});
