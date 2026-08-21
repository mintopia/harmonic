import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { createClient } from '@libsql/client';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
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

  it('read() runs concurrently without queueing behind a pending write', async () => {
    const order: string[] = [];
    const slowWrite = h.write(async () => {
      await delay(40);
      order.push('write');
    });
    const fastRead = h.read(async (db) => {
      await db.select().from(workspaces).all();
      order.push('read');
    });
    await Promise.all([slowWrite, fastRead]);
    expect(order[0]).toBe('read');
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
