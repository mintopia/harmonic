import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { createClient } from '@libsql/client';
import {
  openAsyncDb,
  QueryTimeoutError,
  isQueryTimeout,
  type AsyncDbHandle,
} from '../src/db/async.js';
import { isUniqueViolation } from '../src/db/errors.js';
import { attempts, guardrailEvents, tasks, workspaces } from '../src/db/schema.js';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function seedRunAsync(h: AsyncDbHandle): Promise<number> {
  const now = Date.now();
  const ws = (await h.db.select().from(workspaces).get())!;
  const task = await h.db
    .insert(tasks)
    .values({ prompt: 'p', state: 'ready', workingDir: '/tmp', createdAt: now, updatedAt: now, workspaceId: ws.id })
    .returning()
    .get();
  const attempt = await h.db
    .insert(attempts)
    .values({ taskId: task.id, number: 1, state: 'running', startedAt: now })
    .returning()
    .get();
  return attempt.id;
}

const guardrailEventValues = (attemptId: number, seq: number, now: number) => ({
  attemptId,
  seq,
  ts: now,
  dimension: 'wall-clock' as const,
  limitValue: 1,
  observedValue: 1,
  configSource: 'default' as const,
  payload: '{}',
});

describe('openAsyncDb boot', () => {
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
      h.db.insert(guardrailEvents).values(guardrailEventValues(999_999, 1, now)).run(),
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

describe('read/write queue facade', () => {
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

describe('transactions as exclusive write-queue units', () => {
  let dir: string;
  let h: AsyncDbHandle;
  let attemptId: number;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-async-tx-'));
    h = await openAsyncDb(dir);
    attemptId = await seedRunAsync(h);
  });
  afterEach(async () => {
    await h.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('commits multi-statement work atomically', async () => {
    await h.transaction(async (tx) => {
      await tx.insert(guardrailEvents).values(guardrailEventValues(attemptId, 1, Date.now())).run();
      await tx.insert(guardrailEvents).values(guardrailEventValues(attemptId, 2, Date.now())).run();
    });
    const events = await h.db.select().from(guardrailEvents).where(eq(guardrailEvents.attemptId, attemptId)).all();
    expect(events).toHaveLength(2);
  });

  it('rolls back the whole unit when the callback throws', async () => {
    await expect(
      h.transaction(async (tx) => {
        await tx.insert(guardrailEvents).values(guardrailEventValues(attemptId, 1, Date.now())).run();
        throw new Error('rollback me');
      }),
    ).rejects.toThrow('rollback me');
    const events = await h.db.select().from(guardrailEvents).where(eq(guardrailEvents.attemptId, attemptId)).all();
    expect(events).toHaveLength(0);
  });

  it('excludes other writes for the full duration of the transaction', async () => {
    const order: string[] = [];
    const txP = h.transaction(async (tx) => {
      order.push('tx-start');
      await tx.insert(guardrailEvents).values(guardrailEventValues(attemptId, 1, Date.now())).run();
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

describe('per-query wall-clock timeouts (#212)', () => {
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
    await expect(
      h.read(async () => {
        await delay(60);
      }, { timeoutMs: 10 }),
    ).rejects.toBeInstanceOf(QueryTimeoutError);
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
    const a = h.write(async () => {
      await delay(60);
    });
    await expect(
      h.write(async () => {
      }, { timeoutMs: 20 }),
    ).rejects.toBeInstanceOf(QueryTimeoutError);
    await a;
  });

  it('a caller timeout does not break single-writer serialisation', async () => {
    const events: string[] = [];
    const a = h.write(async () => {
      events.push('a-start');
      await delay(40);
      events.push('a-end');
    }, { timeoutMs: 10 });
    await expect(a).rejects.toBeInstanceOf(QueryTimeoutError);
    await h.write(async () => {
      events.push('b');
    });
    expect(events).toEqual(['a-start', 'a-end', 'b']);
  });
});

describe('unique-index CAS behaviour unchanged under libsql', () => {
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

  it('guardrail_events (attempt_id, seq) CAS: the losing insert surfaces a detectable UNIQUE violation', async () => {
    const attemptId = await seedRunAsync(h);
    const now = Date.now();
    await h.db.insert(guardrailEvents).values(guardrailEventValues(attemptId, 1, now)).run();
    let caught: unknown;
    try {
      await h.db.insert(guardrailEvents).values(guardrailEventValues(attemptId, 1, now)).run();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(isUniqueViolation(caught)).toBe(true);
  });

  it('guardrail_events seq stays monotonic when appends route through the single-writer queue', async () => {
    const attemptId = await seedRunAsync(h);
    const append = () =>
      h.write(async (db) => {
        const seq =
          ((
            await db
              .select({ n: sql<number>`coalesce(max(${guardrailEvents.seq}), 0)` })
              .from(guardrailEvents)
              .where(eq(guardrailEvents.attemptId, attemptId))
              .get()
          )?.n ?? 0) + 1;
        return db.insert(guardrailEvents).values(guardrailEventValues(attemptId, seq, Date.now())).returning().get();
      });

    const rows = await Promise.all(Array.from({ length: 25 }, append));
    const seqs: number[] = rows.map((r) => r.seq).sort((a, b) => a - b);
    expect(new Set(seqs).size).toBe(25);
    expect(seqs).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
  });

  it('guardrail_events seq: naive concurrent appends collide — proving the write queue is load-bearing', async () => {
    const attemptId = await seedRunAsync(h);
    const naiveAppend = async () => {
      const seq =
        ((
          await h.db
            .select({ n: sql<number>`coalesce(max(${guardrailEvents.seq}), 0)` })
            .from(guardrailEvents)
            .where(eq(guardrailEvents.attemptId, attemptId))
            .get()
        )?.n ?? 0) + 1;
      return h.db.insert(guardrailEvents).values(guardrailEventValues(attemptId, seq, Date.now())).returning().get();
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
