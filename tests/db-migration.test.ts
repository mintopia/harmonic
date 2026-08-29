import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readdirSync, copyFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { eq } from 'drizzle-orm';
import { openAsyncDb } from '../src/db/async.js';
import * as schema from '../src/db/schema.js';

const REPO_MIGRATIONS = join(import.meta.dirname, '..', 'drizzle');
/** ADR-0008 (Workspaces) merged as migration 0014 — everything before it is "pre-Workspace". */
const WORKSPACES_MIGRATION = '0014';

/** A migrations folder frozen at the last pre-Workspace migration, built by
 * copying the repo's real migrations/snapshots and trimming the journal — so
 * the test below upgrades a real historical schema, not a hand-rolled one. */
function preWorkspaceMigrationsFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harmonic-premigrations-'));
  mkdirSync(join(dir, 'meta'));
  for (const file of readdirSync(REPO_MIGRATIONS)) {
    if (file.endsWith('.sql') && file < WORKSPACES_MIGRATION) copyFileSync(join(REPO_MIGRATIONS, file), join(dir, file));
  }
  for (const file of readdirSync(join(REPO_MIGRATIONS, 'meta'))) {
    if (file.endsWith('_snapshot.json') && file < WORKSPACES_MIGRATION) {
      copyFileSync(join(REPO_MIGRATIONS, 'meta', file), join(dir, 'meta', file));
    }
  }
  const journal = JSON.parse(readFileSync(join(REPO_MIGRATIONS, 'meta', '_journal.json'), 'utf8'));
  journal.entries = journal.entries.filter((e: { tag: string }) => e.tag < WORKSPACES_MIGRATION);
  writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify(journal));
  return dir;
}

/** A migrations folder frozen just before `boundary` (e.g. '0018'), built the
 * same way as {@link preWorkspaceMigrationsFolder} — upgrades a real historical
 * schema rather than a hand-rolled one. */
function migrationsFolderBefore(boundary: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'harmonic-migrations-'));
  mkdirSync(join(dir, 'meta'));
  for (const file of readdirSync(REPO_MIGRATIONS)) {
    if (file.endsWith('.sql') && file < boundary) copyFileSync(join(REPO_MIGRATIONS, file), join(dir, file));
  }
  for (const file of readdirSync(join(REPO_MIGRATIONS, 'meta'))) {
    if (file.endsWith('_snapshot.json') && file < boundary) {
      copyFileSync(join(REPO_MIGRATIONS, 'meta', file), join(dir, 'meta', file));
    }
  }
  const journal = JSON.parse(readFileSync(join(REPO_MIGRATIONS, 'meta', '_journal.json'), 'utf8'));
  journal.entries = journal.entries.filter((e: { tag: string }) => e.tag < boundary);
  writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify(journal));
  return dir;
}

describe('run event firehose pruning (issue #245)', () => {
  it('removes historical session updates while retaining structured run events', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'harmonic-firehose-migrate-'));
    const migrationsFolder = migrationsFolderBefore('0042');
    const client = createClient({ url: `file:${join(dataDir, 'harmonic.db')}` });
    const db = drizzle(client, { schema });

    await migrate(db, { migrationsFolder });
    await client.execute(
      `insert into tasks (prompt, working_dir, state, created_at, updated_at) values ('legacy', '/tmp/legacy', 'ready', 1, 1)`,
    );
    await client.execute(`insert into runs (task_id, attempt, state, started_at) values (1, 1, 'completed', 1)`);
    await client.execute({
      sql: `insert into run_events (run_id, seq, ts, type, payload) values
        (1, 1, 1, 'session_update', '{"sessionUpdate":"agent_message_chunk"}'),
        (1, 2, 2, 'lifecycle', '{"event":"finished"}'),
        (1, 3, 3, 'permission_request', '{}')`,
    });
    await client.execute({
      sql: `with recursive sequence(n) as (values(4) union all select n + 1 from sequence where n < 64)
        insert into run_events (run_id, seq, ts, type, payload)
        select 1, n, n, 'session_update', hex(zeroblob(50000)) from sequence`,
    });
    const pagesBefore = Number((await client.execute('PRAGMA page_count')).rows[0]?.page_count);

    client.close();
    const upgraded = await openAsyncDb(dataDir);

    const events = await upgraded.read((database) =>
      database.select({ type: schema.runEvents.type }).from(schema.runEvents).orderBy(schema.runEvents.seq).all(),
    );
    expect(events.map((event) => event.type)).toEqual(['lifecycle', 'permission_request']);

    await upgraded.close();
    const compacted = createClient({ url: `file:${join(dataDir, 'harmonic.db')}` });
    const pagesAfter = Number((await compacted.execute('PRAGMA page_count')).rows[0]?.page_count);
    const markers = await compacted.execute(
      "select 1 from sqlite_master where type = 'table' and name = 'run_event_firehose_pruning'",
    );
    compacted.close();
    expect(pagesAfter).toBeLessThan(pagesBefore);
    expect(markers.rows).toHaveLength(0);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(migrationsFolder, { recursive: true, force: true });
  });
});

describe('run diff revision migration (issue #323)', () => {
  it('adds nullable stored diff revision columns to existing runs', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'harmonic-run-diff-migrate-'));
    const migrationsFolder = migrationsFolderBefore('0053');
    const client = createClient({ url: `file:${join(dataDir, 'harmonic.db')}` });

    await migrate(drizzle(client, { schema }), { migrationsFolder });
    await client.execute(
      `insert into tasks (prompt, working_dir, state, created_at, updated_at) values ('legacy', '/tmp/legacy', 'ready', 1, 1)`,
    );
    await client.execute(`insert into runs (task_id, attempt, state, started_at) values (1, 1, 'completed', 1)`);
    client.close();

    const db = await openAsyncDb(dataDir);
    const [run] = await db.read((d) => d.select().from(schema.runs).all());
    expect(run).toMatchObject({ diffBaseOid: null, diffHeadOid: null });

    await db.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(migrationsFolder, { recursive: true, force: true });
  });
});

describe('Setting Override storage move (ADR-0009, issue #391)', () => {
  it('drops the per-Workspace override columns at head — overrides live in the YAML settings file, not the DB', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'harmonic-override-migrate-'));
    const migrationsFolder = migrationsFolderBefore('0018');

    // A pre-override install: migrate up to just before 0018 and seed a
    // Workspace the way an upgraded instance would have one — none of the
    // override columns exist yet.
    const client = createClient({ url: `file:${join(dataDir, 'harmonic.db')}` });
    await client.execute('PRAGMA foreign_keys = ON');
    await migrate(drizzle(client, { schema }), { migrationsFolder });
    const now = Date.now();
    await client.execute({
      sql: `insert into workspaces (name, working_dir, tracker_enabled, tracker_poll_interval_seconds, created_at, updated_at)
         values ('Legacy', '/tmp/legacy-project', 0, 60, ?, ?)`,
      args: [now, now],
    });
    client.close();

    // Boot to head: 0018 added the override columns, 0061 dropped them again
    // (clean break, ADR-0009) — the workspaces row is identity-only now, and a
    // Workspace with no YAML override entry resolves every override as inherit.
    const db = await openAsyncDb(dataDir);
    const ws = await db.read((d) => d.select().from(schema.workspaces).all());
    const legacy = ws.find((w) => w.name === 'Legacy')!;
    expect(legacy).not.toHaveProperty('harness');
    expect(legacy).not.toHaveProperty('model');
    expect(legacy).not.toHaveProperty('autoRunnerEnabled');
    expect(legacy).toMatchObject({ name: 'Legacy', trackerEnabled: false });

    await db.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(migrationsFolder, { recursive: true, force: true });
  });
});

describe('per-task-defaults table rebuild (ADR-0016, issue #81)', () => {
  it('migrates a populated pre-0019 DB (Task + Dependency edge + Run) through 0019 and boots green', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'harmonic-fk-migrate-'));
    const migrationsFolder = migrationsFolderBefore('0019');

    // Build a populated pre-0019 install: migrate to just before 0019, then seed
    // a Workspace, a Dependency edge, a Run, and a Channel edge — the exact child
    // rows in task_dependencies/runs/task_channels that reference tasks and would
    // make 0019's `DROP TABLE tasks` raise SQLITE_CONSTRAINT_FOREIGNKEY when
    // foreign keys are enforced during migration.
    const client = createClient({ url: `file:${join(dataDir, 'harmonic.db')}` });
    await client.execute('PRAGMA foreign_keys = ON');
    await migrate(drizzle(client, { schema }), { migrationsFolder });
    const now = Date.now();
    await client.execute({
      sql: `insert into workspaces (name, working_dir, tracker_enabled, tracker_poll_interval_seconds, created_at, updated_at)
         values ('Legacy', '/tmp/legacy-project', 0, 60, ?, ?)`,
      args: [now, now],
    });
    const INSERT_TASK_SQL =
      `insert into tasks (prompt, harness, model, working_dir, isolation_mode, priority, state, workspace_id, origin, created_at, updated_at)
       values (?, 'claude', 'sonnet', '/tmp/legacy-project', 'direct', 'normal', 'ready', 1, 'native', ?, ?)`;
    const blockerId = Number((await client.execute({ sql: INSERT_TASK_SQL, args: ['a blocker task', now, now] })).lastInsertRowid);
    const dependentId = Number((await client.execute({ sql: INSERT_TASK_SQL, args: ['a dependent task', now, now] })).lastInsertRowid);
    await client.execute({
      sql: `insert into task_dependencies (task_id, depends_on_id) values (?, ?)`,
      args: [dependentId, blockerId],
    });
    await client.execute({
      sql: `insert into runs (task_id, attempt, state, started_at) values (?, 1, 'completed', ?)`,
      args: [blockerId, now],
    });
    await client.execute({
      sql: `insert into channels (name, type, config, events, created_at) values ('ops', 'webhook', '{}', '[]', ?)`,
      args: [now],
    });
    await client.execute({ sql: `insert into task_channels (task_id, channel_id) values (?, 1)`, args: [blockerId] });
    client.close();

    // The real boot path: this used to throw FOREIGN KEY constraint failed on
    // 0019's DROP TABLE tasks. It must now boot cleanly.
    const db = await openAsyncDb(dataDir);

    expect(await db.read((d) => d.select().from(schema.tasks).all())).toHaveLength(2);
    expect(await db.read((d) => d.select().from(schema.taskDependencies).all())).toEqual([
      { taskId: dependentId, dependsOnId: blockerId },
    ]);
    expect(await db.read((d) => d.select().from(schema.runs).all())).toHaveLength(1);
    expect(await db.read((d) => d.select().from(schema.taskChannels).all())).toEqual([{ taskId: blockerId, channelId: 1 }]);

    // Foreign keys are enforced for runtime writes after boot: a Run pointing at
    // a non-existent Task is rejected with a foreign-key constraint error. The
    // libsql drizzle wrapper carries the SQLite message on the error's `cause`
    // (its own top-level message is a generic "Failed query: …").
    let fkError: unknown;
    try {
      await db.write((d) => d.insert(schema.runs).values({ taskId: 999999, attempt: 1, state: 'completed', startedAt: now }).run());
    } catch (err) {
      fkError = err;
    }
    expect((fkError as { cause?: { message?: string } })?.cause?.message).toMatch(/FOREIGN KEY constraint failed/);

    await db.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(migrationsFolder, { recursive: true, force: true });
  });
});

describe('pre-Workspace DB migration (ADR-0008, issue #39)', () => {
  it('creates exactly one default Workspace from defaults.workingDir and backfills every existing Task/Conversation', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'harmonic-premigrate-'));
    const migrationsFolder = preWorkspaceMigrationsFolder();

    // Build the DB as it looked before ADR-0008: migrate up to the last
    // pre-Workspace migration, then seed a config + a Task + a Conversation
    // exactly as a real pre-Workspace install would have them — no
    // workspace_id column exists on either table yet.
    const client = createClient({ url: `file:${join(dataDir, 'harmonic.db')}` });
    await client.execute('PRAGMA foreign_keys = ON');
    await migrate(drizzle(client, { schema }), { migrationsFolder });
    const workingDir = '/tmp/pre-workspace-project';
    await client.execute({
      sql: `insert into settings (key, value) values ('config', ?)`,
      args: [JSON.stringify({ defaults: { workingDir } })],
    });
    const now = Date.now();
    await client.execute({
      sql: `insert into tasks (prompt, harness, model, working_dir, isolation_mode, priority, state, created_at, updated_at)
         values (?, 'claude', 'sonnet', ?, 'direct', 'normal', 'ready', ?, ?)`,
      args: ['a pre-Workspace task', workingDir, now, now],
    });
    await client.execute({
      sql: `insert into conversations (title, harness, model, working_dir, state, created_at, updated_at)
         values (null, 'claude', 'sonnet', ?, 'active', ?, ?)`,
      args: [workingDir, now, now],
    });
    client.close();

    // The real boot path: migrate to head, then the boot-time backfill.
    const db = await openAsyncDb(dataDir);

    const workspaces = await db.read((d) => d.select().from(schema.workspaces).all());
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]).toMatchObject({ name: 'Default', workingDir });

    const tasks = await db.read((d) => d.select().from(schema.tasks).all());
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.workspaceId).toBe(workspaces[0]!.id);

    const conversations = await db.read((d) => d.select().from(schema.conversations).all());
    expect(conversations).toHaveLength(1);
    expect(conversations[0]!.workspaceId).toBe(workspaces[0]!.id);

    await db.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(migrationsFolder, { recursive: true, force: true });
  });

  it('is idempotent: re-opening an already-backfilled DB never creates a second default Workspace', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'harmonic-premigrate-idempotent-'));
    const first = await openAsyncDb(dataDir); // first boot: creates the default Workspace from process.cwd()
    const db = await openAsyncDb(dataDir); // second boot: must be a no-op
    expect(await db.read((d) => d.select().from(schema.workspaces).all())).toHaveLength(1);
    await first.close();
    await db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('carries the legacy global tracker setting onto the Default Workspace (issue #45 regression)', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'harmonic-tracker-backfill-'));
    const migrationsFolder = preWorkspaceMigrationsFolder();

    // A pre-Workspace install that had global tracking ON.
    const client = createClient({ url: `file:${join(dataDir, 'harmonic.db')}` });
    await migrate(drizzle(client, { schema }), { migrationsFolder });
    await client.execute({
      sql: `insert into settings (key, value) values ('config', ?)`,
      args: [JSON.stringify({ defaults: { workingDir: '/tmp/p' }, tracker: { enabled: true, pollIntervalSeconds: 120 } })],
    });
    client.close();

    const db = await openAsyncDb(dataDir);
    const ws = await db.read((d) => d.select().from(schema.workspaces).all());
    expect(ws).toHaveLength(1);
    expect(ws[0]).toMatchObject({ trackerEnabled: true, trackerPollIntervalSeconds: 120 });

    await db.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(migrationsFolder, { recursive: true, force: true });
  });

  it('is a one-shot: never re-enables tracker after a later disable', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'harmonic-tracker-oneshot-'));
    const migrationsFolder = preWorkspaceMigrationsFolder();

    const client = createClient({ url: `file:${join(dataDir, 'harmonic.db')}` });
    await migrate(drizzle(client, { schema }), { migrationsFolder });
    await client.execute({
      sql: `insert into settings (key, value) values ('config', ?)`,
      args: [JSON.stringify({ defaults: { workingDir: '/tmp/p' }, tracker: { enabled: true, pollIntervalSeconds: 60 } })],
    });
    client.close();

    const db1 = await openAsyncDb(dataDir); // carry-over runs once -> enabled
    const id = (await db1.read((d) => d.select().from(schema.workspaces).all()))[0]!.id;
    await db1.write((d) => d.update(schema.workspaces).set({ trackerEnabled: false }).where(eq(schema.workspaces.id, id)).run());

    const db2 = await openAsyncDb(dataDir); // must NOT re-enable
    expect((await db2.read((d) => d.select().from(schema.workspaces).all()))[0]!.trackerEnabled).toBe(false);

    await db1.close();
    await db2.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(migrationsFolder, { recursive: true, force: true });
  });
});

describe('work_context_leases teardown (ADR-0001, issue #384)', () => {
  it('neither work_context_leases nor work_context_lease_dispositions exists at head', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'harmonic-wcl-migrate-'));
    const db = await openAsyncDb(dataDir);

    const sqlite = createClient({ url: `file:${join(dataDir, 'harmonic.db')}` });
    const tables = await sqlite.execute(
      `select name from sqlite_master where type = 'table' and name like 'work_context%'`,
    );
    expect(tables.rows).toHaveLength(0);

    sqlite.close();
    await db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
});

describe('run_facts table (issue #112)', () => {
  it('exists at head with a (run_id, seq) unique index that rejects a duplicate seq for the same Run', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'harmonic-run-facts-migrate-'));
    const db = await openAsyncDb(dataDir);

    const task = await db.write((d) => d.insert(schema.tasks).values({
      prompt: 'seed',
      workingDir: '/tmp/p',
      state: 'ready',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }).returning().get());
    const run = await db.write((d) => d.insert(schema.runs).values({ taskId: task.id, attempt: 1, state: 'running', startedAt: Date.now() }).returning().get());

    // Raw libsql connection against the same file, exercising the migrated unique
    // index directly rather than through the store.
    const sqlite = createClient({ url: `file:${join(dataDir, 'harmonic.db')}` });
    const insertSql = `insert into run_facts (run_id, seq, ts, type, payload) values (?, ?, ?, 'failed', '{}')`;
    const now = Date.now();
    await sqlite.execute({ sql: insertSql, args: [run.id, 1, now] });
    // A second fact at seq 1 for the same Run is rejected; a different seq is fine.
    await expect(sqlite.execute({ sql: insertSql, args: [run.id, 1, now] })).rejects.toThrow(/UNIQUE constraint failed/);
    await expect(sqlite.execute({ sql: insertSql, args: [run.id, 2, now] })).resolves.toBeDefined();

    sqlite.close();
    await db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
});

describe('durable tracker facts migration (issue #233, ADR-0030 expand)', () => {
  it('adds nullable fact columns; a pre-0043 mirrored row survives and reads them null', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'harmonic-tracker-facts-migrate-'));
    const migrationsFolder = migrationsFolderBefore('0043');

    // A pre-facts install: migrate up to just before 0043 and seed a mirrored
    // Task the way an upgraded instance would have one — none of the tracker
    // fact columns exist yet, so it is seeded via raw SQL over the legacy shape.
    const client = createClient({ url: `file:${join(dataDir, 'harmonic.db')}` });
    await client.execute('PRAGMA foreign_keys = ON');
    await migrate(drizzle(client, { schema }), { migrationsFolder });
    const now = Date.now();
    await client.execute({
      sql: `insert into tasks (prompt, working_dir, state, origin, tracker_ref, escalated, created_at, updated_at)
        values ('Legacy mirrored', '/tmp/legacy-project', 'ready', 'mirrored', 233, 0, ?, ?)`,
      args: [now, now],
    });
    client.close();

    // Boot to head applies 0043 and leaves the existing row's facts null.
    const db = await openAsyncDb(dataDir);
    const legacy = await db.read((database) =>
      database.select().from(schema.tasks).where(eq(schema.tasks.trackerRef, 233)).get(),
    );
    if (!legacy) throw new Error('missing migrated tracker task 233');
    expect(legacy).toMatchObject({ prompt: 'Legacy mirrored', origin: 'mirrored' });
    expect(legacy.trackerState).toBeNull();
    expect(legacy.trackerParent).toBeNull();
    expect(legacy.trackerBlockedBy).toBeNull();
    expect(legacy.trackerLabels).toBeNull();
    expect(legacy.trackerTitle).toBeNull();
    expect(legacy.trackerBody).toBeNull();
    expect(legacy.trackerUrl).toBeNull();
    expect(legacy.trackerCreatedAt).toBeNull();

    // The migrated columns are real and usable: a subsequent poll's facts write
    // and round-trip through them (JSON columns included).
    await db.write((database) =>
      database.update(schema.tasks).set({
        trackerState: 'open',
        trackerParent: 229,
        trackerBlockedBy: [{ number: 230, title: 'eligibility', state: 'closed' }],
        trackerLabels: ['ready-for-agent'],
      }).where(eq(schema.tasks.id, legacy.id)).run(),
    );
    const updated = await db.read((database) =>
      database.select().from(schema.tasks).where(eq(schema.tasks.id, legacy.id)).get(),
    );
    if (!updated) throw new Error('missing updated tracker task 233');
    expect(updated.trackerState).toBe('open');
    expect(updated.trackerParent).toBe(229);
    expect(updated.trackerBlockedBy).toEqual([{ number: 230, title: 'eligibility', state: 'closed' }]);
    expect(updated.trackerLabels).toEqual(['ready-for-agent']);

    await db.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(migrationsFolder, { recursive: true, force: true });
  });
});

describe('attempt timeline migration (issue #309, ADR-0041)', () => {
  it('preserves historical Run implementation work and re-keys its facts', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'harmonic-attempt-migrate-'));
    const migrationsFolder = migrationsFolderBefore('0049');
    const client = createClient({ url: `file:${join(dataDir, 'harmonic.db')}` });
    await migrate(drizzle(client, { schema }), { migrationsFolder });
    const taskId = Number((await client.execute(`insert into tasks (prompt, working_dir, state, created_at, updated_at) values ('legacy', '/tmp/p', 'failed', 10, 20)`)).lastInsertRowid);
    const sessionId = Number((await client.execute(`insert into sessions (harness, harness_session_id, model, cwd, last_active_at, created_at, updated_at) values ('claude', 'legacy-session', 'sonnet', '/tmp/p', 20, 10, 20)`)).lastInsertRowid);
    const runId = Number((await client.execute({ sql: `insert into runs (task_id, attempt, state, session_row_id, started_at, finished_at) values (?, 1, 'failed', ?, 10, 20)`, args: [taskId, sessionId] })).lastInsertRowid);
    await client.execute({ sql: `insert into run_facts (run_id, seq, ts, type, payload) values (?, 1, 20, 'failed', '{}')`, args: [runId] });
    client.close();

    const db = await openAsyncDb(dataDir);
    const attempt = await db.read((database) => database.select().from(schema.attempts).get());
    expect(attempt).toMatchObject({ taskId, number: 1, state: 'failed', startedAt: 10, endedAt: 20 });
    expect(await db.read((database) => database.select().from(schema.steps).get())).toMatchObject({
      attemptId: attempt!.id, type: 'implementation', position: 1, state: 'failed', verdict: 'fail',
      logLocator: `session:${sessionId}`, startedAt: 10, endedAt: 20,
    });
    expect(await db.read((database) => database.select().from(schema.runFacts).get())).toMatchObject({ runId, attemptId: attempt!.id });
    await db.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(migrationsFolder, { recursive: true, force: true });
  });
});

describe('blocker edge migration (issue #308)', () => {
  it('moves legacy blocked rows to ready while retaining their dependency edges', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'harmonic-blocker-migrate-'));
    const migrationsFolder = migrationsFolderBefore('0048');
    const client = createClient({ url: `file:${join(dataDir, 'harmonic.db')}` });
    await migrate(drizzle(client, { schema }), { migrationsFolder });
    const now = Date.now();
    await client.execute({ sql: "insert into tasks (prompt, working_dir, state, created_at, updated_at) values ('blocker', '/tmp', 'ready', ?, ?)", args: [now, now] });
    await client.execute({ sql: "insert into tasks (prompt, working_dir, state, created_at, updated_at) values ('dependent', '/tmp', 'blocked', ?, ?)", args: [now, now] });
    await client.execute('insert into task_dependencies (task_id, depends_on_id) values (2, 1)');
    client.close();

    const db = await openAsyncDb(dataDir);
    expect((await db.read((d) => d.select().from(schema.tasks).where(eq(schema.tasks.id, 2)).get()))?.state).toBe('ready');
    expect(await db.read((d) => d.select().from(schema.taskDependencies).all())).toEqual([{ taskId: 2, dependsOnId: 1 }]);
    await db.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(migrationsFolder, { recursive: true, force: true });
  });
});
