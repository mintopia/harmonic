import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@libsql/client';
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
  let asyncDb: AsyncDbHandle;
  let journal: LandingJournalStore;
  let runId: number;
  let otherRunId: number;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-landing-journal-'));
    asyncDb = await openAsyncDb(dir);
    const tasks = new TaskService(asyncDb, () => defaultConfig(), allWorkspaces(asyncDb));
    const runStore = new RunStore(asyncDb);
    journal = new LandingJournalStore(asyncDb);

    const task = await tasks.create({ prompt: 'land it', state: 'ready' });
    runId = (await runStore.create(task.id)).id;
    const otherTask = await tasks.create({ prompt: 'separate log', state: 'ready' });
    otherRunId = (await runStore.create(otherTask.id)).id;
  });
  afterEach(async () => {
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('assigns a 1-based monotonic seq per Run and stores the row', async () => {
    const first = await journal.append(runId, 'intent', { effect: 'target-ref', idempotencyKey: 'main@abc', payload: { expected: { oid: 'abc' } } });
    expect(first).toMatchObject({ runId, seq: 1, kind: 'intent', effect: 'target-ref', idempotencyKey: 'main@abc' });
    expect(JSON.parse(first.payload)).toEqual({ expected: { oid: 'abc' } });

    const second = await journal.append(runId, 'result', { effect: 'target-ref', idempotencyKey: 'main@abc', payload: { ok: true } });
    expect(second.seq).toBe(2);
  });

  it('sequences each Run independently', async () => {
    await journal.writePonc(runId, 0);
    const other = await journal.writePonc(otherRunId, 0);
    expect(other.seq).toBe(1); // a fresh Run starts at 1 regardless of other Runs
    expect((await journal.recordIntent(runId, { effect: 'target-ref', idempotencyKey: 'k', expected: {} })).seq).toBe(2);
  });

  it("list returns a Run's rows in seq order, and only that Run's", async () => {
    await journal.writePonc(runId, 3);
    await journal.recordIntent(runId, { effect: 'target-ref', idempotencyKey: 'k1', expected: {} });
    await journal.writePonc(otherRunId, 0);

    const log = await journal.list(runId);
    expect(log.map((r) => r.seq)).toEqual([1, 2]);
    expect(log.map((r) => r.kind)).toEqual(['ponc', 'intent']);
  });

  it('the (run_id, seq) unique index rejects a duplicate seq (append-only integrity)', async () => {
    await journal.writePonc(runId, 0); // seq 1
    const raw = createClient({ url: `file:${join(dir, 'harmonic.db')}` });
    await expect(
      raw.execute({
        sql: `insert into landing_journal (run_id, seq, ts, kind, effect, idempotency_key, payload) values (?, 1, ?, 'intent', 'target-ref', 'k', '{}')`,
        args: [runId, Date.now()],
      }),
    ).rejects.toThrow(/UNIQUE constraint failed/);
    raw.close();
  });

  it('writePonc/ponc round-trip the cutoff seq', async () => {
    expect(await journal.ponc(runId)).toBeNull(); // no PONC yet
    await journal.recordIntent(runId, { effect: 'target-ref', idempotencyKey: 'k', expected: {} }); // seq 1, not a ponc row
    await journal.writePonc(runId, 7); // seq 2
    expect(await journal.ponc(runId)).toBe(7);
    // feeds poncCutoff directly, same answer via the pure function over `views`
    expect(poncCutoff(await journal.views(runId))).toBe(7);
  });

  it('recordIntent/recordResult round-trip effect + idempotencyKey as row columns, detail in payload', async () => {
    await journal.recordIntent(runId, { effect: 'target-ref', idempotencyKey: 'main@abc', expected: { oid: 'abc' } });
    await journal.recordResult(runId, { effect: 'target-ref', idempotencyKey: 'main@abc', ok: true, observed: { oid: 'abc' } });

    const views = await journal.views(runId);
    expect(views).toEqual([
      { seq: 1, kind: 'intent', effect: 'target-ref', idempotencyKey: 'main@abc', payload: { expected: { oid: 'abc' } } },
      { seq: 2, kind: 'result', effect: 'target-ref', idempotencyKey: 'main@abc', payload: { ok: true, observed: { oid: 'abc' } } },
    ]);
  });
});
