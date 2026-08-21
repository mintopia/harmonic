import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { createClient } from '@libsql/client';
import {
  openAsyncDb,
  openAsyncReadHandle,
  QueryTimeoutError,
  isQueryTimeout,
  type AsyncDbHandle,
} from '../src/db/async.js';
import { openDb, type Db } from '../src/db/index.js';
import { isUniqueViolation } from '../src/domain/work-context-leases.js';
import { workContextLeases, runFacts, runs, tasks, workspaces } from '../src/db/schema.js';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Seed a task + run on the async DB so lease/run_facts inserts satisfy their FKs. */
async function seedRunAsync(h: AsyncDbHandle): Promise<number> {
  const now = Date.now();
  const ws = (await h.db.select().from(workspaces).get())!;
  const task = await h.db
    .insert(tasks)
    .values({ prompt: 'p', state: 'ready', workingDir: '/tmp', createdAt: now, updatedAt: now, workspaceId: ws.id })
    .returning()
    .get();
  const run = await h.db
    .insert(runs)
    .values({ taskId: task.id, attempt: 1, state: 'running', startedAt: now })
    .returning()
    .get();
  return run.id;
}

/** The sync twin, for the cross-driver CAS parity check. */
function seedRunSync(db: Db): number {
  const now = Date.now();
  const ws = db.select().from(workspaces).get()!;
  const task = db
    .insert(tasks)
    .values({ prompt: 'p', state: 'ready', workingDir: '/tmp', createdAt: now, updatedAt: now, workspaceId: ws.id })
    .returning()
    .get();
  const run = db.insert(runs).values({ taskId: task.id, attempt: 1, state: 'running', startedAt: now }).returning().get();
  return run.id;
}

const leaseValues = (key: string, ownerRunId: number, now: number) => ({
  key,
  phase: 'running',
  ownerRunId,
  heartbeat: now,
  expiry: now + 1000,
  state: 'held' as const,
  acquiredAt: now,
});

describe('openAsyncDb boot (ADR-0029 Expand)', () => {
  let dir: string;
  let h: AsyncDbHandle;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-async-boot-'));
    h = await openAsyncDb(dir);
  });
  afterEach(async () => {
    await h.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('opens the database in WAL journal mode', async () => {
    const probe = createClient({ url: `file:${join(dir, 'harmonic.db')}` });
    try {
      const res = await probe.execute('PRAGMA journal_mode');
      expect(res.rows[0]).toMatchObject({ journal_mode: 'wal' });
    } finally {
      probe.close();
    }
  });

  it('runs migrations and backfills the Default workspace', async () => {
    const all = await h.db.select().from(workspaces).all();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ name: 'Default' });
  });

  it('enforces foreign keys after boot (FK on/off dance leaves them ON)', async () => {
    const now = Date.now();
    await expect(
      h.db.insert(workContextLeases).values(leaseValues('fk-probe', 999_999, now)).run(),
    ).rejects.toThrow();
  });

  it('reopens an existing database cleanly (idempotent boot + backfill)', async () => {
    await h.close();
    const again = await openAsyncDb(dir);
    try {
      const all = await again.db.select().from(workspaces).all();
      expect(all).toHaveLength(1);
    } finally {
      await again.close();
    }
  });
});

describe('openAsyncReadHandle — concurrent-read attach (#213, ADR-0029 §5)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-async-read-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('attaches to an already-booted DB and reads rows the sync writer committed', async () => {
    // The sync driver owns boot (migrate + backfill) and writes a run…
    const sync = openDb(dir);
    const runId = seedRunSync(sync);

    // …and a plain read-attach connection sees that committed row over WAL,
    // having run no migrate/backfill of its own.
    const read = openAsyncReadHandle(dir);
    try {
      const seen = await read.read((db) => db.select().from(runs).where(eq(runs.id, runId)).all());
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ id: runId, state: 'running' });
    } finally {
      await read.close();
    }
  });
});

describe('read/write queue facade (ADR-0029 §2)', () => {
  let dir: string;
  let h: AsyncDbHandle;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-async-queue-'));
    h = await openAsyncDb(dir);
  });
  afterEach(async () => {
    await h.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('write() serialises to a single writer in flight', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        h.write(async () => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await delay(5);
          inFlight -= 1;
        }),
      ),
    );
    expect(maxInFlight).toBe(1);
  });

  it('write() runs in submission order', async () => {
    const order: number[] = [];
    const writes = [30, 5, 15].map((ms, i) =>
      h.write(async () => {
        await delay(ms);
        order.push(i);
      }),
    );
    await Promise.all(writes);
    expect(order).toEqual([0, 1, 2]);
  });

  it('read() is not queued behind a pending write (facade keeps reads off the write queue)', async () => {
    // Proves the facade contract: a read issued while a write is in flight
    // resolves without waiting for the write queue to drain. (True reader/writer
    // concurrency under load is WAL's job in the driver, not this facade's.)
    let writeSettled = false;
    const slowWrite = h
      .write(async () => {
        await delay(40);
      })
      .then(() => {
        writeSettled = true;
      });
    const rows = await h.read((db) => db.select().from(workspaces).all());
    expect(writeSettled).toBe(false);
    expect(rows).toHaveLength(1);
    await slowWrite;
  });

  it('a failed write does not poison the queue', async () => {
    await expect(h.write(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(h.write(async () => 42)).resolves.toBe(42);
  });
});

describe('transactions as exclusive write-queue units (ADR-0029 §3)', () => {
  let dir: string;
  let h: AsyncDbHandle;
  let runId: number;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-async-tx-'));
    h = await openAsyncDb(dir);
    runId = await seedRunAsync(h);
  });
  afterEach(async () => {
    await h.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('commits multi-statement work atomically', async () => {
    await h.transaction(async (tx) => {
      await tx.insert(runFacts).values({ runId, seq: 1, ts: Date.now(), type: 'run-start-state', payload: '{}' }).run();
      await tx.insert(runFacts).values({ runId, seq: 2, ts: Date.now(), type: 'run-start-state', payload: '{}' }).run();
    });
    const facts = await h.db.select().from(runFacts).where(eq(runFacts.runId, runId)).all();
    expect(facts).toHaveLength(2);
  });

  it('rolls back the whole unit when the callback throws', async () => {
    await expect(
      h.transaction(async (tx) => {
        await tx.insert(runFacts).values({ runId, seq: 1, ts: Date.now(), type: 'run-start-state', payload: '{}' }).run();
        throw new Error('rollback me');
      }),
    ).rejects.toThrow('rollback me');
    const facts = await h.db.select().from(runFacts).where(eq(runFacts.runId, runId)).all();
    expect(facts).toHaveLength(0);
  });

  it('excludes other writes for the full duration of the transaction', async () => {
    const order: string[] = [];
    const txP = h.transaction(async (tx) => {
      order.push('tx-start');
      await tx.insert(runFacts).values({ runId, seq: 1, ts: Date.now(), type: 'run-start-state', payload: '{}' }).run();
      await delay(25);
      order.push('tx-end');
    });
    const writeP = h.write(async () => {
      order.push('write');
    });
    await Promise.all([txP, writeP]);
    expect(order).toEqual(['tx-start', 'tx-end', 'write']);
  });
});

describe('per-query wall-clock timeouts (ADR-0029 §5, #212)', () => {
  let dir: string;
  let h: AsyncDbHandle;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-async-timeout-'));
    h = await openAsyncDb(dir);
  });
  afterEach(async () => {
    await h.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('read() rejects with a QueryTimeoutError once the deadline passes', async () => {
    let caught: unknown;
    try {
      await h.read(async () => {
        await delay(60);
        return 'never';
      }, { timeoutMs: 10 });
    } catch (err) {
      caught = err;
    }
    expect(isQueryTimeout(caught)).toBe(true);
    expect((caught as QueryTimeoutError).timeoutMs).toBe(10);
  });

  it('read() resolves normally when it finishes before the deadline', async () => {
    const rows = await h.read((db) => db.select().from(workspaces).all(), { timeoutMs: 1000 });
    expect(rows).toHaveLength(1);
  });

  it('write() rejects with a QueryTimeoutError once the deadline passes', async () => {
    await expect(
      h.write(async () => {
        await delay(60);
      }, { timeoutMs: 10 }),
    ).rejects.toBeInstanceOf(QueryTimeoutError);
  });

  it('transaction() is bounded by the timeout too, and labels the error as a transaction', async () => {
    let caught: unknown;
    try {
      await h.transaction(async () => {
        await delay(60);
      }, { timeoutMs: 10 });
    } catch (err) {
      caught = err;
    }
    expect(isQueryTimeout(caught)).toBe(true);
    expect((caught as QueryTimeoutError).message).toContain('transaction');
  });

  it('a per-call timeoutMs overrides the handle default', async () => {
    // Handle default is generous; a tight per-call override still fires.
    await expect(
      h.read(async () => {
        await delay(60);
      }, { timeoutMs: 10 }),
    ).rejects.toBeInstanceOf(QueryTimeoutError);
    // And a generous per-call override lets a slow op through.
    await expect(
      h.read(async () => {
        await delay(20);
        return 7;
      }, { timeoutMs: 1000 }),
    ).resolves.toBe(7);
  });

  it('timeoutMs <= 0 disables the timeout for that call', async () => {
    await expect(
      h.read(async () => {
        await delay(30);
        return 'slow-but-allowed';
      }, { timeoutMs: 0 }),
    ).resolves.toBe('slow-but-allowed');
  });

  it('the handle default timeout applies when no per-call override is given', async () => {
    const tightDir = mkdtempSync(join(tmpdir(), 'harmonic-async-timeout-default-'));
    const tight = await openAsyncDb(tightDir, { queryTimeoutMs: 10 });
    try {
      await expect(
        tight.read(async () => {
          await delay(60);
        }),
      ).rejects.toBeInstanceOf(QueryTimeoutError);
    } finally {
      await tight.close();
      rmSync(tightDir, { recursive: true, force: true });
    }
  });

  it('bounds a caller queued behind an in-flight write (queue-wait is charged)', async () => {
    // A holds the single writer for 60ms. B is submitted immediately behind A with
    // a 20ms budget. Because the timeout bounds the caller's *total* wait from
    // submission, B's caller is freed at 20ms while still queued behind A, rather
    // than hanging for A's full (uncancellable) duration.
    const a = h.write(async () => {
      await delay(60);
    });
    await expect(
      h.write(async () => {
        /* would only run after A settles, well past B's deadline */
      }, { timeoutMs: 20 }),
    ).rejects.toBeInstanceOf(QueryTimeoutError);
    await a;
  });

  it('a caller timeout does not break single-writer serialisation', async () => {
    // A's caller times out at 10ms, but A's real work runs for 40ms and cannot be
    // cancelled on the local libsql client. B must still wait for A's real work to
    // finish before it starts — the single-writer invariant survives the timeout.
    const events: string[] = [];
    const a = h.write(async () => {
      events.push('a-start');
      await delay(40);
      events.push('a-end');
    }, { timeoutMs: 10 });
    await expect(a).rejects.toBeInstanceOf(QueryTimeoutError);
    // Submitted after A's caller rejected, while A's real work is still in flight.
    await h.write(async () => {
      events.push('b');
    });
    expect(events).toEqual(['a-start', 'a-end', 'b']);
  });
});

describe('unique-index CAS behaviour unchanged under libsql (ADR-0029 §3)', () => {
  let dir: string;
  let h: AsyncDbHandle;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-async-cas-'));
    h = await openAsyncDb(dir);
  });
  afterEach(async () => {
    await h.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('lease acquire: the losing insert surfaces a detectable UNIQUE violation', async () => {
    const runId = await seedRunAsync(h);
    const now = Date.now();
    await h.db.insert(workContextLeases).values(leaseValues('lease-x', runId, now)).run();
    let caught: unknown;
    try {
      await h.db.insert(workContextLeases).values(leaseValues('lease-x', runId, now)).run();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(isUniqueViolation(caught)).toBe(true);
  });

  it('lease acquire: better-sqlite3 and libsql are detected identically', async () => {
    // libsql (async)
    const runIdAsync = await seedRunAsync(h);
    const now = Date.now();
    await h.db.insert(workContextLeases).values(leaseValues('dup', runIdAsync, now)).run();
    let libsqlErr: unknown;
    try {
      await h.db.insert(workContextLeases).values(leaseValues('dup', runIdAsync, now)).run();
    } catch (err) {
      libsqlErr = err;
    }

    // better-sqlite3 (sync) — the live path
    const syncDir = mkdtempSync(join(tmpdir(), 'harmonic-sync-cas-'));
    let syncErr: unknown;
    try {
      const db = openDb(syncDir);
      const runIdSync = seedRunSync(db);
      db.insert(workContextLeases).values(leaseValues('dup', runIdSync, now)).run();
      try {
        db.insert(workContextLeases).values(leaseValues('dup', runIdSync, now)).run();
      } catch (err) {
        syncErr = err;
      }
    } finally {
      rmSync(syncDir, { recursive: true, force: true });
    }

    expect(isUniqueViolation(libsqlErr)).toBe(true);
    expect(isUniqueViolation(syncErr)).toBe(true);
  });

  it('run_facts seq stays monotonic when appends route through the single-writer queue', async () => {
    const runId = await seedRunAsync(h);
    // Mirrors RunFactStore.append: read max(seq)+1 then insert, as one write unit.
    const append = () =>
      h.write(async (db) => {
        const seq =
          ((
            await db
              .select({ n: sql<number>`coalesce(max(${runFacts.seq}), 0)` })
              .from(runFacts)
              .where(eq(runFacts.runId, runId))
              .get()
          )?.n ?? 0) + 1;
        return db.insert(runFacts).values({ runId, seq, ts: Date.now(), type: 'run-start-state', payload: '{}' }).returning().get();
      });

    const rows = await Promise.all(Array.from({ length: 25 }, append));
    const seqs = rows.map((r) => r.seq).sort((a, b) => a - b);
    expect(new Set(seqs).size).toBe(25);
    expect(seqs).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
  });

  it('run_facts seq: naive concurrent appends collide — proving the write queue is load-bearing', async () => {
    const runId = await seedRunAsync(h);
    const naiveAppend = async () => {
      const seq =
        ((
          await h.db
            .select({ n: sql<number>`coalesce(max(${runFacts.seq}), 0)` })
            .from(runFacts)
            .where(eq(runFacts.runId, runId))
            .get()
        )?.n ?? 0) + 1;
      return h.db.insert(runFacts).values({ runId, seq, ts: Date.now(), type: 'run-start-state', payload: '{}' }).returning().get();
    };
    let caught: unknown;
    try {
      await Promise.all(Array.from({ length: 25 }, naiveAppend));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(isUniqueViolation(caught)).toBe(true);
  });
});
