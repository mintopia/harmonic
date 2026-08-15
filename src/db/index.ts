import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { isNull, eq } from 'drizzle-orm';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from './schema.js';
import { conversations, settings, tasks, workspaces } from './schema.js';
import { defaultConfig } from '../config.js';

export type Db = BetterSQLite3Database<typeof schema>;

/** Settings marker so the legacy-tracker carry-over below runs exactly once. */
const TRACKER_BACKFILL_KEY = 'trackerEnabledBackfilled';

/**
 * The subset of a raw stored config the backfill reads directly off JSON,
 * including the legacy global `tracker` block that no longer exists in the
 * current config schema (ADR-0014). Decoupled from AppConfig on purpose so the
 * one-shot carry-over keeps working after the schema drops the field.
 */
type LegacyStoredConfig = {
  defaults?: { workingDir?: string };
  tracker?: { enabled?: boolean; pollIntervalSeconds?: number };
};

/**
 * ADR-0008 migration: a pre-Workspace database has no `workspaces` row and
 * every Task/Conversation's `workspace_id` is null (SQLite can't add that
 * column NOT NULL to an existing table in one step — see the schema.ts
 * comment). Idempotent: once every row is backfilled, both queries below
 * touch nothing, so this is cheap to run on every boot rather than needing
 * a one-shot migrated flag.
 *
 * Also carries the legacy global tracker setting onto the Default Workspace.
 * Per-Workspace `trackerEnabled` (issue #45) defaults false, and the ADR-0008
 * migration created the Default Workspace without it — so an upgraded instance
 * that had global tracking on silently stopped mirroring. This is a one-shot
 * (guarded by a settings marker) so re-enabling never fights a user who later
 * turns tracking back off.
 */
function backfillDefaultWorkspace(db: Db): void {
  const stored = db.select().from(settings).where(eq(settings.key, 'config')).get();
  const storedConfig = stored ? (JSON.parse(stored.value) as LegacyStoredConfig) : undefined;

  let defaultWorkspace = db.select().from(workspaces).orderBy(workspaces.id).get();
  if (!defaultWorkspace) {
    const workingDir = storedConfig?.defaults?.workingDir ?? defaultConfig().defaults.workingDir;
    const now = Date.now();
    defaultWorkspace = db
      .insert(workspaces)
      .values({ name: 'Default', workingDir, createdAt: now, updatedAt: now })
      .returning()
      .get();
  }

  const backfilled = db.select().from(settings).where(eq(settings.key, TRACKER_BACKFILL_KEY)).get();
  if (!backfilled) {
    if (storedConfig?.tracker?.enabled) {
      db.update(workspaces)
        .set({
          trackerEnabled: true,
          trackerPollIntervalSeconds: storedConfig.tracker.pollIntervalSeconds ?? 60,
        })
        .where(eq(workspaces.id, defaultWorkspace.id))
        .run();
    }
    db.insert(settings).values({ key: TRACKER_BACKFILL_KEY, value: 'true' }).run();
  }

  db.update(tasks).set({ workspaceId: defaultWorkspace.id }).where(isNull(tasks.workspaceId)).run();
  db.update(conversations).set({ workspaceId: defaultWorkspace.id }).where(isNull(conversations.workspaceId)).run();
}

export function openDb(dataDir: string): Db {
  mkdirSync(dataDir, { recursive: true });
  const sqlite = new Database(join(dataDir, 'harmonic.db'));
  sqlite.pragma('journal_mode = WAL');
  // ADR-0016: table-rebuild migrations (create __new_x, copy, DROP TABLE x,
  // rename) need foreign-key enforcement OFF, and SQLite ignores
  // `PRAGMA foreign_keys` inside a transaction (drizzle wraps each migration in
  // one), so the pragma the generated migration emits is a no-op. Disable at the
  // connection level *before* migrate(), verify integrity with
  // foreign_key_check, then enforce foreign keys for runtime.
  sqlite.pragma('foreign_keys = OFF');
  const db = drizzle(sqlite, { schema });
  const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle');
  migrate(db, { migrationsFolder });
  const violations = sqlite.pragma('foreign_key_check') as unknown[];
  if (violations.length > 0) {
    throw new Error(`Database failed foreign_key_check after migration: ${JSON.stringify(violations)}`);
  }
  sqlite.pragma('foreign_keys = ON');
  backfillDefaultWorkspace(db);
  return db;
}
