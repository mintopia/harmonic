import { createClient, type Client } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { isNull, eq } from 'drizzle-orm';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from './schema.js';
import { conversations, settings, tasks, workspaces } from './schema.js';
import { defaultConfig } from '../config.js';

/**
 * The async, libsql-backed sibling of the sync {@link import('./index.js').Db}.
 * ADR-0029: every `.get/.all/.run` is a Promise. This lives *alongside* the sync
 * driver during the expand-contract migration — the sync `Db` remains the live
 * path until stores are ported over one batch at a time.
 */
export type AsyncDb = LibSQLDatabase<typeof schema>;

/**
 * The transaction handle drizzle hands an async `db.transaction(async (tx) => …)`
 * callback — the async twin of {@link import('../domain/run-cascade.js').CascadeTx},
 * derived the same way so cascade-style helpers can run inside a write-queue unit.
 */
export type AsyncTx = Parameters<Parameters<AsyncDb['transaction']>[0]>[0];

const noop = (): void => {};

/**
 * The read/write queue facade over an async libsql {@link AsyncDb} (ADR-0029 §2).
 *
 * - `read(fn)` runs immediately and concurrently — WAL lets readers proceed
 *   without waiting on the writer.
 * - `write(fn)` serialises through a single-writer queue: at most one write is in
 *   flight, the next starts only after the previous settles. This preserves the
 *   single-writer invariant the coordination spine assumes (lease `acquire`,
 *   `run_facts` `seq`) which synchronous better-sqlite3 gave for free.
 * - `transaction(fn)` is one exclusive write-queue unit wrapping a real DB
 *   transaction, so multi-statement atomic sequences (the 6 `.transaction()`
 *   sites) run without any other write interleaving.
 *
 * A failed write does not poison the queue: the tail is chained through a
 * swallowed continuation so the next write always runs.
 */
export class AsyncDbHandle {
  readonly db: AsyncDb;
  readonly #client: Client;
  #writeTail: Promise<unknown> = Promise.resolve();

  constructor(db: AsyncDb, client: Client) {
    this.db = db;
    this.#client = client;
  }

  /** Concurrent read (WAL). Does not queue behind pending writes. */
  read<T>(fn: (db: AsyncDb) => Promise<T>): Promise<T> {
    return fn(this.db);
  }

  /** Serialised single-writer write: one in flight at a time. */
  write<T>(fn: (db: AsyncDb) => Promise<T>): Promise<T> {
    const run = this.#writeTail.then(() => fn(this.db));
    this.#writeTail = run.then(noop, noop);
    return run;
  }

  /** Exclusive write-queue unit wrapping a real DB transaction. */
  transaction<T>(fn: (tx: AsyncTx) => Promise<T>): Promise<T> {
    return this.write((db) => db.transaction(fn));
  }

  /** Drain the write queue, then close the underlying client. */
  async close(): Promise<void> {
    await this.#writeTail.catch(noop);
    this.#client.close();
  }
}

type LegacyStoredConfig = {
  defaults?: { workingDir?: string };
  tracker?: { enabled?: boolean; pollIntervalSeconds?: number };
};

/** Settings marker so the legacy-tracker carry-over runs exactly once. */
const TRACKER_BACKFILL_KEY = 'trackerEnabledBackfilled';

/**
 * Async port of the sync `backfillDefaultWorkspace` (see src/db/index.ts). Runs
 * as one write-queue unit so the read-then-write backfill can't interleave with
 * other writers. Kept as a faithful duplicate rather than shared during
 * expand-contract; the sync copy is deleted in the contract step.
 */
async function backfillDefaultWorkspaceAsync(handle: AsyncDbHandle): Promise<void> {
  await handle.write(async (db) => {
    const stored = await db.select().from(settings).where(eq(settings.key, 'config')).get();
    const storedConfig = stored ? (JSON.parse(stored.value) as LegacyStoredConfig) : undefined;

    let defaultWorkspace = await db.select().from(workspaces).orderBy(workspaces.id).get();
    if (!defaultWorkspace) {
      const workingDir = storedConfig?.defaults?.workingDir ?? defaultConfig().defaults.workingDir;
      const now = Date.now();
      defaultWorkspace = await db
        .insert(workspaces)
        .values({ name: 'Default', workingDir, createdAt: now, updatedAt: now })
        .returning()
        .get();
    }

    const backfilled = await db
      .select()
      .from(settings)
      .where(eq(settings.key, TRACKER_BACKFILL_KEY))
      .get();
    if (!backfilled) {
      if (storedConfig?.tracker?.enabled) {
        await db
          .update(workspaces)
          .set({
            trackerEnabled: true,
            trackerPollIntervalSeconds: storedConfig.tracker.pollIntervalSeconds ?? 60,
          })
          .where(eq(workspaces.id, defaultWorkspace.id))
          .run();
      }
      await db.insert(settings).values({ key: TRACKER_BACKFILL_KEY, value: 'true' }).run();
    }

    await db.update(tasks).set({ workspaceId: defaultWorkspace.id }).where(isNull(tasks.workspaceId)).run();
    await db
      .update(conversations)
      .set({ workspaceId: defaultWorkspace.id })
      .where(isNull(conversations.workspaceId))
      .run();
  });
}

/**
 * Boot the async libsql `Db`, ADR-0029 + ADR-0016. Mirrors the sync `openDb`
 * boot dance: WAL, disable FK enforcement at the connection level *before*
 * `migrate()` (SQLite ignores `PRAGMA foreign_keys` inside the transaction
 * drizzle wraps each migration in), verify integrity with `foreign_key_check`,
 * then enforce FK for runtime.
 */
export async function openAsyncDb(dataDir: string): Promise<AsyncDbHandle> {
  mkdirSync(dataDir, { recursive: true });
  const client = createClient({ url: `file:${join(dataDir, 'harmonic.db')}` });
  await client.execute('PRAGMA journal_mode = WAL');
  await client.execute('PRAGMA foreign_keys = OFF');
  const db = drizzle(client, { schema });
  const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle');
  await migrate(db, { migrationsFolder });
  const violations = await client.execute('PRAGMA foreign_key_check');
  if (violations.rows.length > 0) {
    throw new Error(
      `Database failed foreign_key_check after migration: ${JSON.stringify(violations.rows)}`,
    );
  }
  await client.execute('PRAGMA foreign_keys = ON');
  const handle = new AsyncDbHandle(db, client);
  await backfillDefaultWorkspaceAsync(handle);
  return handle;
}
