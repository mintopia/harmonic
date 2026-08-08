import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readdirSync, copyFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { openDb } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';

const REPO_MIGRATIONS = join(import.meta.dirname, '..', 'drizzle');
/** ADR-0008 (Workspaces) landed as migration 0014 — everything before it is "pre-Workspace". */
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

describe('pre-Workspace DB migration (ADR-0008, issue #39)', () => {
  it('creates exactly one default Workspace from defaults.workingDir and backfills every existing Task/Conversation', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'harmonic-premigrate-'));
    const migrationsFolder = preWorkspaceMigrationsFolder();

    // Build the DB as it looked before ADR-0008: migrate up to the last
    // pre-Workspace migration, then seed a config + a Task + a Conversation
    // exactly as a real pre-Workspace install would have them — no
    // workspace_id column exists on either table yet.
    const sqlite = new Database(join(dataDir, 'harmonic.db'));
    sqlite.pragma('foreign_keys = ON');
    migrate(drizzle(sqlite, { schema }), { migrationsFolder });
    const workingDir = '/tmp/pre-workspace-project';
    sqlite.prepare(`insert into settings (key, value) values ('config', ?)`).run(
      JSON.stringify({ defaults: { workingDir } }),
    );
    const now = Date.now();
    sqlite
      .prepare(
        `insert into tasks (prompt, harness, model, working_dir, isolation_mode, priority, state, created_at, updated_at)
         values (?, 'claude', 'sonnet', ?, 'direct', 'normal', 'ready', ?, ?)`,
      )
      .run('a pre-Workspace task', workingDir, now, now);
    sqlite
      .prepare(
        `insert into conversations (title, harness, model, working_dir, state, created_at, updated_at)
         values (null, 'claude', 'sonnet', ?, 'active', ?, ?)`,
      )
      .run(workingDir, now, now);
    sqlite.close();

    // The real boot path: migrate to head, then the boot-time backfill.
    const db = openDb(dataDir);

    const workspaces = db.select().from(schema.workspaces).all();
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]).toMatchObject({ name: 'Default', workingDir });

    const tasks = db.select().from(schema.tasks).all();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.workspaceId).toBe(workspaces[0]!.id);

    const conversations = db.select().from(schema.conversations).all();
    expect(conversations).toHaveLength(1);
    expect(conversations[0]!.workspaceId).toBe(workspaces[0]!.id);

    rmSync(dataDir, { recursive: true, force: true });
    rmSync(migrationsFolder, { recursive: true, force: true });
  });

  it('is idempotent: re-opening an already-backfilled DB never creates a second default Workspace', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'harmonic-premigrate-idempotent-'));
    openDb(dataDir); // first boot: creates the default Workspace from process.cwd()
    const db = openDb(dataDir); // second boot: must be a no-op
    expect(db.select().from(schema.workspaces).all()).toHaveLength(1);
    rmSync(dataDir, { recursive: true, force: true });
  });
});
