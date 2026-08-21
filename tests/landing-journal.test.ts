import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openDb, type Db } from '../src/db/index.js';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { defaultConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import { RunStore } from '../src/domain/runs.js';
import { LandingJournalStore } from '../src/domain/landing-journal.js';
import { poncCutoff } from '../src/domain/landing.js';
import { allWorkspaces } from './helpers.js';

/**
 * The append-only landing journal store (issue #115, reliability-design
 * §0.3) — mirrors tests/run-facts.test.ts, same guarantees for the sibling
 * table.
 */
describe('LandingJournalStore (issue #115)', () => {
  let dir: string;
  let db: Db;
  // RunStore migrated to the async libsql Db (ADR-0029 #203); this fixture
  // runs both connections on the one file.
  let asyncDb: AsyncDbHandle;
  let journal: LandingJournalStore;
  let runId: number;
  let otherRunId: number;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-landing-journal-'));
    db = openDb(dir);
    asyncDb = await openAsyncDb(dir);
    const tasks = new TaskService(db, () => defaultConfig(), allWorkspaces(db));
    const runStore = new RunStore(asyncDb);
    journal = new LandingJournalStore(db);

    const task = tasks.create({ prompt: 'land it', state: 'ready' });
    runId = (await runStore.create(task.id)).id;
    const otherTask = tasks.create({ prompt: 'separate log', state: 'ready' });
    otherRunId = (await runStore.create(otherTask.id)).id;
  });
  afterEach(async () => {
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('assigns a 1-based monotonic seq per Run and stores the row', () => {
    const first = journal.append(runId, 'intent', { effect: 'target-ref', idempotencyKey: 'main@abc', payload: { expected: { oid: 'abc' } } });
    expect(first).toMatchObject({ runId, seq: 1, kind: 'intent', effect: 'target-ref', idempotencyKey: 'main@abc' });
    expect(JSON.parse(first.payload)).toEqual({ expected: { oid: 'abc' } });

    const second = journal.append(runId, 'result', { effect: 'target-ref', idempotencyKey: 'main@abc', payload: { ok: true } });
    expect(second.seq).toBe(2);
  });

  it('sequences each Run independently', () => {
    journal.writePonc(runId, 0);
    const other = journal.writePonc(otherRunId, 0);
    expect(other.seq).toBe(1); // a fresh Run starts at 1 regardless of other Runs
    expect(journal.recordIntent(runId, { effect: 'target-ref', idempotencyKey: 'k', expected: {} }).seq).toBe(2);
  });

  it("list returns a Run's rows in seq order, and only that Run's", () => {
    journal.writePonc(runId, 3);
    journal.recordIntent(runId, { effect: 'target-ref', idempotencyKey: 'k1', expected: {} });
    journal.writePonc(otherRunId, 0);

    const log = journal.list(runId);
    expect(log.map((r) => r.seq)).toEqual([1, 2]);
    expect(log.map((r) => r.kind)).toEqual(['ponc', 'intent']);
  });

  it('the (run_id, seq) unique index rejects a duplicate seq (append-only integrity)', () => {
    journal.writePonc(runId, 0); // seq 1
    const sqlite = new Database(join(dir, 'harmonic.db'));
    const insert = sqlite.prepare(
      `insert into landing_journal (run_id, seq, ts, kind, effect, idempotency_key, payload) values (?, 1, ?, 'intent', 'target-ref', 'k', '{}')`,
    );
    expect(() => insert.run(runId, Date.now())).toThrow(/UNIQUE constraint failed/);
    sqlite.close();
  });

  it('writePonc/ponc round-trip the cutoff seq', () => {
    expect(journal.ponc(runId)).toBeNull(); // no PONC yet
    journal.recordIntent(runId, { effect: 'target-ref', idempotencyKey: 'k', expected: {} }); // seq 1, not a ponc row
    journal.writePonc(runId, 7); // seq 2
    expect(journal.ponc(runId)).toBe(7);
    // feeds poncCutoff directly, same answer via the pure function over `views`
    expect(poncCutoff(journal.views(runId))).toBe(7);
  });

  it('recordIntent/recordResult round-trip effect + idempotencyKey as row columns, detail in payload', () => {
    journal.recordIntent(runId, { effect: 'target-ref', idempotencyKey: 'main@abc', expected: { oid: 'abc' } });
    journal.recordResult(runId, { effect: 'target-ref', idempotencyKey: 'main@abc', ok: true, observed: { oid: 'abc' } });

    const views = journal.views(runId);
    expect(views).toEqual([
      { seq: 1, kind: 'intent', effect: 'target-ref', idempotencyKey: 'main@abc', payload: { expected: { oid: 'abc' } } },
      { seq: 2, kind: 'result', effect: 'target-ref', idempotencyKey: 'main@abc', payload: { ok: true, observed: { oid: 'abc' } } },
    ]);
  });
});
