import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@libsql/client';
import { openAsyncDb } from '../src/db/async.js';
import { parseBaseline, syncSchema } from '../src/db/schema-sync.js';
import { logger } from '../src/logger.js';

const BASELINE = join(import.meta.dirname, '..', 'drizzle', '0000_baseline.sql');

describe('schema convergence onto the baseline (ADR-0007)', () => {
  it('parses every baseline statement as a table or an index', () => {
    const baseline = parseBaseline(readFileSync(BASELINE, 'utf8'));
    expect(baseline.tables.map((t) => t.name)).toContain('epics');
    expect(baseline.tables.find((t) => t.name === 'epics')?.columns.map((c) => c.name)).toEqual([
      'workspace_id', 'tracker_ref', 'kind', 'merge_commit', 'state', 'member_refs',
    ]);
    expect(baseline.indexes.length).toBeGreaterThan(0);
  });

  it('converges an older data dir: adds the missing table and column, drops retired ones, keeps rows', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'harmonic-sync-'));
    const first = await openAsyncDb(dataDir);
    await first.close();
    const sqlite = createClient({ url: `file:${join(dataDir, 'harmonic.db')}` });
    await sqlite.execute('DROP TABLE epics');
    await sqlite.execute('ALTER TABLE tasks DROP COLUMN feedback');
    await sqlite.execute('ALTER TABLE tasks ADD COLUMN retired_col text');
    await sqlite.execute('CREATE TABLE runs (id integer primary key)');
    await sqlite.execute('CREATE TABLE __drizzle_migrations (id integer primary key, hash text, created_at integer)');
    await sqlite.execute(
      "INSERT INTO workspaces (name, working_dir, tracker_enabled, tracker_poll_interval_seconds, created_at, updated_at) VALUES ('keep', '/tmp/keep', 0, 60, 1, 1)",
    );

    const second = await openAsyncDb(dataDir);
    await second.close();
    const tables = (await sqlite.execute("select name from sqlite_master where type = 'table'")).rows.map((r) => String(r.name));
    expect(tables).toContain('epics');
    expect(tables).not.toContain('runs');
    expect(tables).not.toContain('__drizzle_migrations');
    const taskColumns = (await sqlite.execute('pragma table_info(tasks)')).rows.map((r) => String(r.name));
    expect(taskColumns).toContain('feedback');
    expect(taskColumns).not.toContain('retired_col');
    expect((await sqlite.execute("select count(*) as c from workspaces where name = 'keep'")).rows[0]?.c).toBe(1);
    sqlite.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('rebuilds a constraint-drifted attempts table without losing its task attempts', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'harmonic-sync-attempts-'));
    const first = await openAsyncDb(dataDir);
    await first.close();
    const sqlite = createClient({ url: `file:${join(dataDir, 'harmonic.db')}` });
    await sqlite.execute('DROP TABLE attempts');
    await sqlite.execute([
      'CREATE TABLE attempts (',
      '`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,',
      '`task_id` integer NOT NULL,',
      '`number` integer NOT NULL,',
      "`state` text DEFAULT 'running' NOT NULL,",
      '`started_at` integer NOT NULL,',
      'FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action',
      ')',
    ].join('\n'));
    await sqlite.execute("INSERT INTO tasks (id, prompt, working_dir, state, created_at, updated_at) VALUES (1, 'keep', '/tmp/keep', 'ready', 1, 1)");
    await sqlite.execute("INSERT INTO attempts (id, task_id, number, state, started_at) VALUES (1, 1, 1, 'passed', 1)");

    await syncSchema(sqlite, readFileSync(BASELINE, 'utf8'));

    const taskId = (await sqlite.execute('pragma table_info(`attempts`)')).rows.find((row) => row.name === 'task_id');
    expect(taskId?.notnull).toBe(0);
    const attemptsSql = String((await sqlite.execute("select sql from sqlite_master where type = 'table' and name = 'attempts'")).rows[0]?.sql);
    expect(attemptsSql).toContain('FOREIGN KEY (`workspace_id`, `epic_ref`)');
    expect(attemptsSql).toContain('CHECK ((`task_id` IS NOT NULL');
    expect((await sqlite.execute('select id, task_id, number, state from attempts')).rows).toEqual([
      { id: 1, task_id: 1, number: 1, state: 'passed' },
    ]);
    const workspaceId = Number((await sqlite.execute('select id from workspaces limit 1')).rows[0]?.id);
    await sqlite.execute(`INSERT INTO epics (workspace_id, tracker_ref, kind, state) VALUES (${workspaceId}, 538, 'epic', 'ready')`);
    await expect(sqlite.execute(`INSERT INTO attempts (workspace_id, epic_ref, number, state, started_at) VALUES (${workspaceId}, 538, 1, 'running', 2)`)).resolves.toBeDefined();
    await expect(sqlite.execute("INSERT INTO attempts (number, state, started_at) VALUES (2, 'running', 2)")).rejects.toThrow();
    await expect(sqlite.execute(`INSERT INTO attempts (task_id, workspace_id, epic_ref, number, state, started_at) VALUES (1, ${workspaceId}, 538, 2, 'running', 2)`)).rejects.toThrow();

    await syncSchema(sqlite, readFileSync(BASELINE, 'utf8'));
    expect((await sqlite.execute('select count(*) as count from attempts')).rows[0]?.count).toBe(2);
    sqlite.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  describe('rollback and clean-break fallback', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('rolls back the failed incremental convergence and clean-break recreates instead of leaving a half-converged DB', async () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'harmonic-sync-rollback-'));
      const dbPath = join(dataDir, 'harmonic.db');
      const client = createClient({ url: `file:${dbPath}` });
      await client.execute('CREATE TABLE `foo` (`id` integer, `old_col` text)');
      await client.execute("INSERT INTO `foo` (`id`, `old_col`) VALUES (1, 'x')");
      await client.execute('CREATE TABLE `bar` (`id` integer)');

      const baseline = [
        'CREATE TABLE `foo` (',
        '\t`id` integer,',
        '\t`new_col` text NOT NULL',
        ');',
        '--> statement-breakpoint',
        'CREATE UNIQUE INDEX `foo_id_idx` ON `foo` (`id`);',
      ].join('\n');

      const infoSpy = vi.spyOn(logger, 'info');
      const warnSpy = vi.spyOn(logger, 'warn');

      await syncSchema(client, baseline);

      const tables = (await client.execute("select name from sqlite_master where type = 'table'")).rows.map((r) =>
        String(r.name),
      );
      expect(tables).toContain('foo');
      expect(tables).not.toContain('bar');

      const fooColumns = (await client.execute('pragma table_info(`foo`)')).rows.map((r) => String(r.name));
      expect(fooColumns).toContain('id');
      expect(fooColumns).toContain('new_col');
      expect(fooColumns).not.toContain('old_col');

      // The NOT NULL add fails once `foo` still has rows, so the clean-break
      // recreate wipes it — proving the incremental half-drop never survives.
      expect((await client.execute('select count(*) as c from `foo`')).rows[0]?.c).toBe(0);

      const indexes = (await client.execute("select name from sqlite_master where type = 'index'")).rows.map((r) =>
        String(r.name),
      );
      expect(indexes).toContain('foo_id_idx');

      const infoCalls = infoSpy.mock.calls;
      expect(infoCalls.some((call) => JSON.stringify(call).includes('bar'))).toBe(true);
      expect(infoCalls.some((call) => JSON.stringify(call).includes('old_col'))).toBe(true);
      expect(warnSpy).toHaveBeenCalled();

      client.close();
      rmSync(dataDir, { recursive: true, force: true });
    });
  });
});
