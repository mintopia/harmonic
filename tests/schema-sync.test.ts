import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@libsql/client';
import { openAsyncDb } from '../src/db/async.js';
import { parseBaseline } from '../src/db/schema-sync.js';

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
});
