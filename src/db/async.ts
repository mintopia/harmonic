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

/**
 * The libsql-backed Drizzle database (ADR-0029): every `.get/.all/.run` is a
 * Promise.
 */
export type AsyncDb = LibSQLDatabase<typeof schema>;

/**
 * The transaction handle drizzle hands an async `db.transaction(async (tx) => …)`
 * callback — structurally the same query surface as {@link AsyncDb}, extracted so
 * cascade-style helpers (e.g. `deleteRunsAndChildrenAsync`) can run inside a
 * write-queue unit.
 */
export type AsyncTx = Parameters<Parameters<AsyncDb['transaction']>[0]>[0];

const noop = (): void => {};

/**
 * Default per-query wall-clock ceiling (ADR-0029 §5, issue #212). Generous
 * enough that a healthy local SQLite query never trips it, tight enough that a
 * pathological one surfaces as an error instead of an unbounded caller wait.
 */
export const DEFAULT_QUERY_TIMEOUT_MS = 30_000;

/**
 * Raised when a facade call (`read`/`write`/`transaction`) outlives its
 * wall-clock deadline. Detectable via {@link isQueryTimeout}, just as write
 * conflicts are detected via `isUniqueViolation`, so callers and monitoring can
 * tell a timeout apart from an ordinary query failure.
 */
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

/** Which facade call a timeout is bounding — carried into the error message. */
type QueryKind = 'read' | 'write' | 'transaction';

/** Per-call override of the handle's default wall-clock timeout. */
export interface QueryTimeoutOptions {
  /**
   * Wall-clock ceiling in ms for this call, overriding the handle default. A
   * value `<= 0` disables the timeout for this call (for the rare genuinely
   * unbounded operation).
   */
  timeoutMs?: number;
}

/**
 * Race `work` against a wall-clock deadline. On expiry the returned promise
 * rejects with a {@link QueryTimeoutError}; the timer is cleared the moment
 * `work` settles and is `unref`'d so a pending query never keeps the process
 * alive. `timeoutMs <= 0` disables the bound and returns `work` untouched.
 *
 * Note (ADR-0029 §5): the local libsql `file:` client exposes no per-query
 * interrupt — only `client.close()` aborts, and that tears down the whole
 * connection. So the deadline bounds the *caller's* wait and surfaces the
 * pathology; the underlying statement is not forcibly cancelled and may still
 * run to completion in the driver.
 */
function withTimeout<T>(work: Promise<T>, timeoutMs: number, kind: QueryKind): Promise<T> {
  // `!(timeoutMs > 0)` also treats NaN as "disabled", so a bad config never arms a
  // timer that can never clear.
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
 * The read/write queue facade over an async libsql {@link AsyncDb} (ADR-0029 §2).
 *
 * - `read(fn)` runs immediately and concurrently — WAL lets readers proceed
 *   without waiting on the writer.
 * - `write(fn)` serialises through a single-writer queue: at most one write is in
 *   flight, the next starts only after the previous settles.
 * - `transaction(fn)` is one exclusive write-queue unit wrapping a real DB
 *   transaction, so multi-statement atomic sequences (the 6 `.transaction()`
 *   sites) run without any other write interleaving.
 *
 * A failed write does not poison the queue: the tail is chained through a
 * swallowed continuation so the next write always runs.
 *
 * Every call is bounded by a per-query wall-clock timeout (ADR-0029 §5, #212):
 * the handle default (see {@link DEFAULT_QUERY_TIMEOUT_MS}), overridable per call
 * via {@link QueryTimeoutOptions}. The deadline bounds the *caller's* total wait —
 * measured from submission, so for a write it includes any time spent queued
 * behind other writes. That is the guarantee that matters: no caller waits on the
 * DB past the deadline, even if a pathological write ahead of it holds the single
 * writer. Because the local libsql statement cannot be cancelled, a timed-out
 * write's real work still runs to completion and keeps holding the queue until it
 * settles; the timeout frees the *caller* and flags the pathology, it never lets a
 * second writer onto the connection ahead of the one in flight.
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

  /**
   * Concurrent read: runs immediately, without queueing behind pending writes.
   * WAL is what lets a reader proceed while the single writer is in flight; this
   * facade's job is only to keep reads off the write queue.
   */
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
    // The real work. The queue tail chains on *this*, not on the timeout race, so
    // the next write only starts once this write's statement has truly settled — a
    // caller timeout never lets a second writer onto the single connection.
    //
    // INVARIANT: writes run strictly in enqueue order, and a later write's real
    // work does not begin until an earlier write has fully settled (ADR-0029)
    // — the single-writer queue every transactional caller in this codebase
    // relies on for cross-write ordering. Reordering the chaining below (or
    // letting a later write start before an earlier one settles) would
    // silently break that invariant.
    const real = this.#writeTail.then(() => fn(this.db));
    this.#writeTail = real.then(noop, noop);
    // Bound the caller's total wait, timed from submission, so a caller queued
    // behind a pathological write is freed at the deadline instead of hanging for
    // the upstream write's full (uncancellable) duration.
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

/** Settings marker so the legacy-tracker carry-over runs exactly once. */
const TRACKER_BACKFILL_KEY = 'trackerEnabledBackfilled';

/**
 * Runs as one write-queue unit so the read-then-write backfill can't interleave
 * with other writers.
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
 * Boot the async libsql `Db` (ADR-0007): WAL, foreign-key enforcement off at the
 * connection level while the schema converges onto the baseline, `foreign_key_check`,
 * then foreign keys on for runtime.
 */
export async function openAsyncDb(
  dataDir: string,
  options: { queryTimeoutMs?: number } = {},
): Promise<AsyncDbHandle> {
  mkdirSync(dataDir, { recursive: true });
  // `@libsql/client` against a local `file:` URL runs on a single connection, so
  // connection-level pragmas below (`foreign_keys`, `journal_mode`) apply to the
  // same connection drizzle then issues every query on — the FK on/off dance is
  // sound. (A pooled client would need per-connection pragma setup instead.)
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
