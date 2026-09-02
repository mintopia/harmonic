import { createClient, type Client } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { isNull, eq } from 'drizzle-orm';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from './schema.js';
import { syncSchema } from './schema-sync.js';
import { conversations, settings, tasks, workspaces } from './schema.js';
import { defaultConfig } from '../config.js';

/** The libsql-backed Drizzle database; every `.get/.all/.run` is a Promise. */
export type AsyncDb = LibSQLDatabase<typeof schema>;

/** The transaction handle drizzle hands an async `db.transaction` callback. */
export type AsyncTx = Parameters<Parameters<AsyncDb['transaction']>[0]>[0];

const noop = (): void => {};

/** Default per-query wall-clock ceiling. */
export const DEFAULT_QUERY_TIMEOUT_MS = 30_000;

/** Raised when a facade call outlives its wall-clock deadline; detect via {@link isQueryTimeout}. */
export class QueryTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(kind: QueryKind, timeoutMs: number) {
    super(`Async DB ${kind} exceeded its ${timeoutMs}ms wall-clock timeout`);
    this.name = 'QueryTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/** Narrow an unknown error to a {@link QueryTimeoutError}. */
export function isQueryTimeout(err: unknown): err is QueryTimeoutError {
  return err instanceof QueryTimeoutError;
}

type QueryKind = 'read' | 'write' | 'transaction';

/** Per-call override of the handle's default wall-clock timeout. */
export interface QueryTimeoutOptions {
  /** Wall-clock ceiling in ms for this call; `<= 0` disables the timeout. */
  timeoutMs?: number;
}

// The local libsql `file:` client has no per-query interrupt (only `client.close()`), so the deadline bounds the caller's wait; the statement still runs to completion.
function withTimeout<T>(work: Promise<T>, timeoutMs: number, kind: QueryKind): Promise<T> {
  if (!(timeoutMs > 0)) return work;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new QueryTimeoutError(kind, timeoutMs)), timeoutMs);
    timer.unref?.();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Read/write queue facade: `read` runs concurrently (WAL), `write`/`transaction` serialise through a
 * single-writer queue. Timeouts bound the caller's wait from submission; a timed-out write still runs
 * to completion and holds the queue until it settles.
 */
export class AsyncDbHandle {
  readonly db: AsyncDb;
  readonly #client: Client;
  readonly #defaultTimeoutMs: number;
  #writeTail: Promise<unknown> = Promise.resolve();

  constructor(db: AsyncDb, client: Client, defaultTimeoutMs: number = DEFAULT_QUERY_TIMEOUT_MS) {
    this.db = db;
    this.#client = client;
    this.#defaultTimeoutMs = defaultTimeoutMs;
  }

  #timeoutFor(opts?: QueryTimeoutOptions): number {
    return opts?.timeoutMs ?? this.#defaultTimeoutMs;
  }

  /** Concurrent read: runs immediately, never queued behind writes. */
  read<T>(fn: (db: AsyncDb) => Promise<T>, opts?: QueryTimeoutOptions): Promise<T> {
    return withTimeout(fn(this.db), this.#timeoutFor(opts), 'read');
  }

  /** Serialised single-writer write: one in flight at a time. */
  write<T>(fn: (db: AsyncDb) => Promise<T>, opts?: QueryTimeoutOptions): Promise<T> {
    return this.#enqueueWrite(fn, 'write', opts);
  }

  /** Exclusive write-queue unit wrapping a real DB transaction. */
  transaction<T>(fn: (tx: AsyncTx) => Promise<T>, opts?: QueryTimeoutOptions): Promise<T> {
    return this.#enqueueWrite((db) => db.transaction(fn), 'transaction', opts);
  }

  #enqueueWrite<T>(fn: (db: AsyncDb) => Promise<T>, kind: QueryKind, opts?: QueryTimeoutOptions): Promise<T> {
    // The tail chains on the real work, not the timeout race: a caller timeout never lets a second writer onto the single connection.
    const real = this.#writeTail.then(() => fn(this.db));
    this.#writeTail = real.then(noop, noop);
    return withTimeout(real, this.#timeoutFor(opts), kind);
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

const TRACKER_BACKFILL_KEY = 'trackerEnabledBackfilled';

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

/** Boot the async libsql DB: WAL, foreign keys off while the schema converges onto the baseline, `foreign_key_check`, then foreign keys on. */
export async function openAsyncDb(
  dataDir: string,
  options: { queryTimeoutMs?: number } = {},
): Promise<AsyncDbHandle> {
  mkdirSync(dataDir, { recursive: true });
  // `@libsql/client` on a local `file:` URL uses a single connection, so these connection-level pragmas apply to every drizzle query.
  const client = createClient({ url: `file:${join(dataDir, 'harmonic.db')}` });
  await client.execute('PRAGMA journal_mode = WAL');
  await client.execute('PRAGMA foreign_keys = OFF');
  const db = drizzle(client, { schema });
  const baseline = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle', '0000_baseline.sql');
  await syncSchema(client, readFileSync(baseline, 'utf8'));
  const violations = await client.execute('PRAGMA foreign_key_check');
  if (violations.rows.length > 0) {
    throw new Error(
      `Database failed foreign_key_check after schema convergence: ${JSON.stringify(violations.rows)}`,
    );
  }
  await client.execute('PRAGMA foreign_keys = ON');
  const handle = new AsyncDbHandle(db, client, options.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS);
  await backfillDefaultWorkspaceAsync(handle);
  return handle;
}
