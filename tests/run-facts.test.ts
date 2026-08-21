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
import { RunFactStore } from '../src/domain/run-facts.js';
import { computeDisposition } from '../src/domain/run-disposition.js';
import { allWorkspaces } from './helpers.js';

/**
 * The append-only Run fact log store (issue #112, reliability-design §0.3).
 */
describe('RunFactStore (issue #112)', () => {
  let dir: string;
  let db: Db;
  // RunStore and RunFactStore both migrated to the async libsql Db (ADR-0029
  // #203); `db` (sync) still backs TaskService and the raw sqlite duplicate-seq
  // check below, so this fixture runs both connections on the one file.
  let asyncDb: AsyncDbHandle;
  let facts: RunFactStore;
  let runId: number;
  let otherRunId: number;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-run-facts-'));
    db = openDb(dir);
    asyncDb = await openAsyncDb(dir);
    const tasks = new TaskService(asyncDb, () => defaultConfig(), allWorkspaces(db));
    const runStore = new RunStore(asyncDb);
    facts = new RunFactStore(asyncDb);

    const task = await tasks.create({ prompt: 'emit facts', state: 'ready' });
    runId = (await runStore.create(task.id)).id;
    const otherTask = await tasks.create({ prompt: 'separate log', state: 'ready' });
    otherRunId = (await runStore.create(otherTask.id)).id;
  });
  afterEach(async () => {
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('assigns a 1-based monotonic seq per Run and stores the fact', async () => {
    const first = await facts.append(runId, 'agent-finish/unresolved', { note: 'done' });
    expect(first).toMatchObject({ runId, seq: 1, type: 'agent-finish/unresolved' });
    expect(JSON.parse(first.payload)).toEqual({ note: 'done' });

    const second = await facts.append(runId, 'failed');
    expect(second.seq).toBe(2);
    expect(second.payload).toBe('{}'); // default empty payload
  });

  it('sequences each Run independently', async () => {
    await facts.append(runId, 'escalate');
    const other = await facts.append(otherRunId, 'operator-cancel');
    expect(other.seq).toBe(1); // a fresh Run starts at 1 regardless of other Runs
    expect((await facts.append(runId, 'process-death')).seq).toBe(2);
  });

  it("list returns a Run's facts in seq order, and only that Run's", async () => {
    await facts.append(runId, 'failed');
    await facts.append(runId, 'escalate');
    await facts.append(otherRunId, 'operator-cancel');

    const log = await facts.list(runId);
    expect(log.map((f) => f.seq)).toEqual([1, 2]);
    expect(log.map((f) => f.type)).toEqual(['failed', 'escalate']);
  });

  it('the (run_id, seq) unique index rejects a duplicate seq (append-only integrity)', async () => {
    await facts.append(runId, 'failed'); // seq 1
    // Force a raw duplicate seq against the same file — the store never does
    // this, but the index must guarantee no two facts share a seq in a Run.
    const sqlite = new Database(join(dir, 'harmonic.db'));
    const insert = sqlite.prepare(
      `insert into run_facts (run_id, seq, ts, type, payload) values (?, 1, ?, 'process-death', '{}')`,
    );
    expect(() => insert.run(runId, Date.now())).toThrow(/UNIQUE constraint failed/);
    sqlite.close();
  });

  it('feeds computeDisposition: the persisted log resolves to the winning disposition', async () => {
    await facts.append(runId, 'process-death');
    await facts.append(runId, 'escalate');
    await facts.append(runId, 'agent-finish/unresolved');
    const log = await facts.list(runId);
    expect(computeDisposition(log, log.length)).toBe('escalate');
  });

  it('boot crash recovery records a process-death fact — the orphan terminal is reconstructable from the log (issue #113)', async () => {
    const runStore = new RunStore(asyncDb);
    const orphans = await runStore.markInterrupted(); // runId + otherRunId are still `running`
    expect(orphans.map((r) => r.id).sort()).toEqual([runId, otherRunId].sort());

    // The Run row is failed/interrupted…
    expect((await runStore.get(runId)).state).toBe('failed');
    // …and that terminal is reconstructable from run_facts alone.
    const log = await facts.list(runId);
    expect(log.map((f) => f.type)).toEqual(['process-death']);
    expect(JSON.parse(log[0]!.payload)).toEqual({
      runState: 'failed',
      taskAction: 'failed',
      reason: 'interrupted',
    });
    expect(computeDisposition(log, log.length)).toBe('process-death');
  });
});
