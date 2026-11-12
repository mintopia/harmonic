import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient, LibsqlError, type InStatement } from '@libsql/client';
import { openAsyncDb } from '../src/db/async.js';
import { seedWorkspace } from './helpers.js';
import { parseBaseline, syncSchema } from '../src/db/schema-sync.js';
import { logger } from '../src/logger.js';
import { tasks } from '../src/db/schema.js';

const BASELINE = join(import.meta.dirname, '..', 'drizzle', '0000_baseline.sql');

describe('schema convergence onto the baseline (ADR-0007)', () => {
  it('parses every baseline statement as a table or an index', () => {
    const baseline = parseBaseline(readFileSync(BASELINE, 'utf8'));
    expect(baseline.tables.map((t) => t.name)).toContain('epics');
    expect(baseline.tables.find((t) => t.name === 'epics')?.columns.map((c) => c.name)).toEqual([
      'workspace_id', 'tracker_ref', 'kind', 'merge_commit', 'state', 'member_refs', 'workflow_ref',
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

  it('creates the attempt_events (attempt_id, seq) unique index on an existing data dir', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'harmonic-sync-events-idx-'));
    const first = await openAsyncDb(dataDir);
    await first.close();
    const sqlite = createClient({ url: `file:${join(dataDir, 'harmonic.db')}` });
    await sqlite.execute('DROP INDEX attempt_events_attempt_seq_unique');

    const second = await openAsyncDb(dataDir);
    await second.close();
    const index = (await sqlite.execute("select sql from sqlite_master where type = 'index' and name = 'attempt_events_attempt_seq_unique'")).rows[0];
    expect(String(index?.sql)).toMatch(/UNIQUE INDEX .*attempt_events.*\(`attempt_id`,\s*`seq`\)/);
    sqlite.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('boots an existing data dir whose attempt_events hold duplicate (attempt_id, seq) rows, keeping the first of each', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'harmonic-sync-events-dupes-'));
    const first = await openAsyncDb(dataDir);
    await first.close();
    const sqlite = createClient({ url: `file:${join(dataDir, 'harmonic.db')}` });
    await sqlite.execute('DROP INDEX attempt_events_attempt_seq_unique');
    await sqlite.execute("INSERT INTO workspaces (name, working_dir, tracker_enabled, tracker_poll_interval_seconds, created_at, updated_at) VALUES ('keep', '/tmp/keep', 0, 60, 1, 1)");
    const columns = (await sqlite.execute('pragma table_info(attempt_events)')).rows.map((r) => String(r.name));
    expect(columns).toEqual(expect.arrayContaining(['attempt_id', 'seq', 'ts', 'type', 'payload']));
    const workspaceId = Number((await sqlite.execute('select id from workspaces limit 1')).rows[0]?.id);
    await sqlite.execute(`INSERT INTO epics (workspace_id, tracker_ref, kind, state) VALUES (${workspaceId}, 538, 'epic', 'ready')`);
    await sqlite.execute(`INSERT INTO attempts (workspace_id, epic_ref, number, state, started_at) VALUES (${workspaceId}, 538, 1, 'running', 1)`);
    await sqlite.execute(`INSERT INTO attempts (workspace_id, epic_ref, number, state, started_at) VALUES (${workspaceId}, 538, 2, 'running', 1)`);
    for (const [attemptId, seq, payload] of [[1, 1, 'a'], [1, 1, 'b'], [1, 2, 'c'], [2, 1, 'd']] as const) {
      await sqlite.execute({ sql: 'INSERT INTO attempt_events (attempt_id, seq, ts, type, payload) VALUES (?, ?, 0, ?, ?)', args: [attemptId, seq, 'lifecycle', payload] });
    }

    const second = await openAsyncDb(dataDir);
    await second.close();
    const rows = (await sqlite.execute('select attempt_id, seq, payload from attempt_events order by attempt_id, seq')).rows.map((r) => [r.attempt_id, r.seq, r.payload]);
    expect(rows).toEqual([[1, 1, 'a'], [1, 2, 'c'], [2, 1, 'd']]);
    expect((await sqlite.execute("select name from sqlite_master where type = 'index' and name = 'attempt_events_attempt_seq_unique'")).rows).toHaveLength(1);
    expect((await sqlite.execute("select count(*) as n from workspaces")).rows[0]?.n).toBe(1);
    sqlite.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('rebuilds a constraint-drifted attempts table without losing its task attempts', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'harmonic-sync-attempts-'));
    const first = await openAsyncDb(dataDir);
    await seedWorkspace(first);
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

    it.each([
      ['an I/O error', new LibsqlError('disk I/O error', 'SQLITE_IOERR')],
      ['a lock timeout', new LibsqlError('database is locked', 'SQLITE_BUSY')],
      ['a dropped connection', new Error('WebSocket closed unexpectedly')],
    ])('propagates %s and leaves the database untouched instead of clean-break recreating', async (_label, transientError) => {
      const dataDir = mkdtempSync(join(tmpdir(), 'harmonic-sync-transient-'));
      const dbPath = join(dataDir, 'harmonic.db');
      const client = createClient({ url: `file:${dbPath}` });
      await client.execute('CREATE TABLE `foo` (`id` integer, `old_col` text)');
      await client.execute("INSERT INTO `foo` (`id`, `old_col`) VALUES (1, 'x')");

      const baseline = ['CREATE TABLE `foo` (', '\t`id` integer,', '\t`old_col` text', ');'].join('\n');

      const realExecute = client.execute.bind(client);
      const warnSpy = vi.spyOn(logger, 'warn');
      const executeSpy = vi.spyOn(client, 'execute').mockImplementation(async (stmt: InStatement) => {
        const sql = typeof stmt === 'string' ? stmt : stmt.sql;
        if (sql.startsWith('pragma table_info')) {
          throw transientError;
        }
        return realExecute(stmt);
      });

      await expect(syncSchema(client, baseline)).rejects.toThrow(transientError);
      executeSpy.mockRestore();

      const tables = (await client.execute("select name from sqlite_master where type = 'table'")).rows.map((r) =>
        String(r.name),
      );
      expect(tables).toContain('foo');
      expect((await client.execute('select id, old_col from `foo`')).rows).toEqual([{ id: 1, old_col: 'x' }]);
      expect(warnSpy).not.toHaveBeenCalled();

      client.close();
      rmSync(dataDir, { recursive: true, force: true });
    });
  });
});

describe('workflow_step_runs Epic owner upgrade', () => {
  it('rebuilds an older workflow_step_runs with a NOT NULL task_id, keeping Ticket rows', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'harmonic-sync-stepruns-'));
    const first = await openAsyncDb(dataDir);
    const taskId = (await first.write((d) => d.insert(tasks).values({ prompt: 'p', state: 'ready', workingDir: '/tmp/x', createdAt: 1, updatedAt: 1 } as typeof tasks.$inferInsert).returning().get())).id;
    await first.close();
    const sqlite = createClient({ url: `file:${join(dataDir, 'harmonic.db')}` });
    await sqlite.execute('PRAGMA foreign_keys = OFF');
    await sqlite.execute('DROP TABLE workflow_step_runs');
    await sqlite.execute(
      'CREATE TABLE `workflow_step_runs` (`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL, `task_id` integer NOT NULL, `workflow_ref` text NOT NULL, `step_id` text NOT NULL, `position` integer NOT NULL, `action` text NOT NULL, `outcome` text, `outputs` text, `summary` text, `resolved_prompt` text, `attempt` integer, `started_at` integer NOT NULL, `ended_at` integer)',
    );
    await sqlite.execute(`INSERT INTO workflow_step_runs (task_id, workflow_ref, step_id, position, action, started_at) VALUES (${taskId}, 'w@1', 's', 0, 'run', 1)`);

    const second = await openAsyncDb(dataDir);
    await second.close();
    const columns = (await sqlite.execute('pragma table_info(workflow_step_runs)')).rows;
    expect(columns.map((r) => String(r.name))).toEqual(expect.arrayContaining(['workspace_id', 'epic_ref', 'attempt_id', 'session_row_id', 'harness', 'model', 'usage']));
    expect(columns.find((r) => r.name === 'task_id')?.notnull).toBe(0);
    expect((await sqlite.execute('select task_id, workspace_id, epic_ref from workflow_step_runs')).rows.map((r) => [r.task_id, r.workspace_id, r.epic_ref])).toEqual([[taskId, null, null]]);
    const indexes = (await sqlite.execute("select name from sqlite_master where type = 'index' and tbl_name = 'workflow_step_runs'")).rows.map((r) => String(r.name));
    expect(indexes).toEqual(expect.arrayContaining(['workflow_step_runs_epic_idx', 'workflow_step_runs_attempt_idx']));
    sqlite.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
});

describe('legacy tasks without a workspace', () => {
  it('backfills a null workspace_id from the matching working_dir, creating the workspace when none exists', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'harmonic-sync-orphan-'));
    const first = await openAsyncDb(dataDir);
    await first.close();
    const sqlite = createClient({ url: `file:${join(dataDir, 'harmonic.db')}` });
    await sqlite.execute(
      "INSERT INTO workspaces (name, working_dir, tracker_enabled, tracker_poll_interval_seconds, created_at, updated_at) VALUES ('known', '/tmp/known', 0, 60, 1, 1)",
    );
    const insertTask = (dir: string) =>
      sqlite.execute(`INSERT INTO tasks (prompt, working_dir, state, origin, workspace_id, created_at, updated_at) VALUES ('p', '${dir}', 'cancelled', 'native', NULL, 1, 1)`);
    await insertTask('/tmp/known');
    await insertTask('/tmp/legacy-only');

    const second = await openAsyncDb(dataDir);
    await second.close();
    const rows = (
      await sqlite.execute('select t.working_dir as dir, w.working_dir as wdir from tasks t join workspaces w on w.id = t.workspace_id order by t.id')
    ).rows.map((r) => [r.dir, r.wdir]);
    expect(rows).toEqual([
      ['/tmp/known', '/tmp/known'],
      ['/tmp/legacy-only', '/tmp/legacy-only'],
    ]);
    expect((await sqlite.execute('select count(*) as c from tasks where workspace_id is null')).rows[0]?.c).toBe(0);
    sqlite.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('leaves a legacy task unscoped, without wiping the database, when attaching it would duplicate a tracker_ref', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'harmonic-sync-orphan-dup-'));
    const first = await openAsyncDb(dataDir);
    await first.close();
    const sqlite = createClient({ url: `file:${join(dataDir, 'harmonic.db')}` });
    await sqlite.execute(
      "INSERT INTO workspaces (id, name, working_dir, tracker_enabled, tracker_poll_interval_seconds, created_at, updated_at) VALUES (7, 'known', '/tmp/known', 0, 60, 1, 1)",
    );
    const insertTask = (workspaceId: string) =>
      sqlite.execute(`INSERT INTO tasks (prompt, working_dir, state, origin, tracker_ref, workspace_id, created_at, updated_at) VALUES ('p', '/tmp/known', 'cancelled', 'native', '12', ${workspaceId}, 1, 1)`);
    await insertTask('7');
    await insertTask('NULL');

    const second = await openAsyncDb(dataDir);
    await second.close();
    expect((await sqlite.execute('select count(*) as c from tasks')).rows[0]?.c).toBe(2);
    expect((await sqlite.execute('select count(*) as c from tasks where workspace_id is null')).rows[0]?.c).toBe(1);
    expect((await sqlite.execute('select count(*) as c from workspaces where id = 7')).rows[0]?.c).toBe(1);
    sqlite.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
});
