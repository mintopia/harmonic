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

describe('Issue Workflow expand (ADR-0053)', () => {
  it('backfills issue_workflow from workflow on a pre-change database', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'harmonic-iw-mig-'));
    const first = await openAsyncDb(dir);
    await first.close();
    const sqlite = createClient({ url: `file:${join(dir, 'harmonic.db')}` });
    await sqlite.execute("INSERT INTO workspaces (name, working_dir, tracker_enabled, tracker_poll_interval_seconds, created_at, updated_at) VALUES ('w', '/tmp/w', 0, 60, 1, 1)");
    const insert = (flow: string | null, i: number) =>
      sqlite.execute({
        sql: "INSERT INTO tasks (prompt, working_dir, state, workspace_id, workflow, created_at, updated_at) VALUES (?, '/tmp/w', 'ready', 1, ?, 1, 1)",
        args: [`t${i}`, flow],
      });
    await insert('wayfinder', 1);
    await insert('implement', 2);
    await insert(null, 3);
    await sqlite.execute('ALTER TABLE tasks DROP COLUMN issue_workflow');

    const second = await openAsyncDb(dir);
    await second.close();
    const rows = (await sqlite.execute('select workflow, issue_workflow from tasks order by id')).rows;
    expect(rows.map((r) => [r.workflow, r.issue_workflow])).toEqual([
      ['wayfinder', 'wayfinder'],
      ['implement', 'implement'],
      [null, null],
    ]);
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('dual-write', () => {
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
      trackerRef: trackerRef(5), prompt: 'p', wayfinderType: null, mapRef: null, closed: false, ...over,
    });

    it.each([
      ['workflow', { workflow: 'wayfinder' }],
      ['issueWorkflow', { issueWorkflow: 'wayfinder' }],
    ] as const)('writing %s updates both columns and the API returns both', async (_name, over) => {
      const created = await tasks.upsertMirrored(input(over));
      expect([created.workflow, created.issueWorkflow]).toEqual(['wayfinder', 'wayfinder']);
      const updated = await tasks.upsertMirrored(input({ issueWorkflow: 'implement' }));
      expect([updated.workflow, updated.issueWorkflow]).toEqual(['implement', 'implement']);
      const dto = taskToApiDto(
        { ...updated, overrides: { isolationMode: null, priority: null }, dependsOn: [], dependents: [], blockedOnFailed: false } as never,
        [],
        { toolCount: null, currentStep: null, hasCandidate: false, url: null, mapTitle: null, trackerLabel: null, skipReason: null, contextWindow: null },
      );
      expect([dto.workflow, dto.issueWorkflow]).toEqual(['implement', 'implement']);
    });
  });
});
