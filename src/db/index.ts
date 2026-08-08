import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { isNull, eq } from 'drizzle-orm';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from './schema.js';
import { conversations, settings, tasks, workspaces } from './schema.js';
import { defaultConfig, type AppConfig } from '../config.js';

export type Db = BetterSQLite3Database<typeof schema>;

/**
 * ADR-0008 migration: a pre-Workspace database has no `workspaces` row and
 * every Task/Conversation's `workspace_id` is null (SQLite can't add that
 * column NOT NULL to an existing table in one step — see the schema.ts
 * comment). Idempotent: once every row is backfilled, both queries below
 * touch nothing, so this is cheap to run on every boot rather than needing
 * a one-shot migrated flag.
 */
function backfillDefaultWorkspace(db: Db): void {
  let defaultWorkspace = db.select().from(workspaces).orderBy(workspaces.id).get();
  if (!defaultWorkspace) {
    const stored = db.select().from(settings).where(eq(settings.key, 'config')).get();
    const workingDir = stored
      ? ((JSON.parse(stored.value) as Partial<AppConfig>).defaults?.workingDir ?? defaultConfig().defaults.workingDir)
      : defaultConfig().defaults.workingDir;
    const now = Date.now();
    defaultWorkspace = db
      .insert(workspaces)
      .values({ name: 'Default', workingDir, createdAt: now, updatedAt: now })
      .returning()
      .get();
  }
  db.update(tasks).set({ workspaceId: defaultWorkspace.id }).where(isNull(tasks.workspaceId)).run();
  db.update(conversations).set({ workspaceId: defaultWorkspace.id }).where(isNull(conversations.workspaceId)).run();
}

export function openDb(dataDir: string): Db {
  mkdirSync(dataDir, { recursive: true });
  const sqlite = new Database(join(dataDir, 'harmonic.db'));
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle');
  migrate(db, { migrationsFolder });
  backfillDefaultWorkspace(db);
  return db;
}
