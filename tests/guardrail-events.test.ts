import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../src/db/index.js';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { defaultConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import { RunStore } from '../src/domain/runs.js';
import { GuardrailEventStore } from '../src/domain/guardrail-events.js';
import { allWorkspaces } from './helpers.js';

/**
 * The append-only Guardrail-trip event log store (issue #127, ADR-0019,
 * mirroring `tests/verification-attempts.test.ts`'s template for
 * `VerificationAttemptStore`, issue #136).
 */
describe('GuardrailEventStore (issue #127)', () => {
  let dir: string;
  let db: Db;
  // RunStore migrated to the async libsql Db (ADR-0029 #203); this fixture
  // runs both connections on the one file.
  let asyncDb: AsyncDbHandle;
  let events: GuardrailEventStore;
  let runId: number;
  let otherRunId: number;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-guardrail-events-'));
    db = openDb(dir);
    asyncDb = await openAsyncDb(dir);
    const tasks = new TaskService(db, () => defaultConfig(), allWorkspaces(db));
    const runStore = new RunStore(asyncDb);
    events = new GuardrailEventStore(db);

    const task = tasks.create({ prompt: 'trip me', state: 'ready' });
    runId = (await runStore.create(task.id)).id;
    const otherTask = tasks.create({ prompt: 'separate log', state: 'ready' });
    otherRunId = (await runStore.create(otherTask.id)).id;
  });
  afterEach(async () => {
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('appends a wall-clock trip and reads it back, seq 1, fields persisted', () => {
    const row = events.append(runId, {
      dimension: 'wall-clock',
      phase: 'executing',
      limitValue: 3_600_000,
      observedValue: 3_600_001,
      configSource: 'default',
    });
    expect(row).toMatchObject({
      runId,
      seq: 1,
      dimension: 'wall-clock',
      phase: 'executing',
      limitValue: 3_600_000,
      observedValue: 3_600_001,
      configSource: 'default',
      payload: '{}',
    });

    const [back] = events.list(runId);
    expect(back).toEqual(row);
  });

  it('payload round-trips through JSON.stringify, defaulting to {} when omitted', () => {
    const row = events.append(runId, {
      dimension: 'wall-clock',
      phase: 'validating',
      limitValue: 1000,
      observedValue: 1500,
      configSource: 'workspace',
      payload: { note: 'evidence', elapsedMs: 1500 },
    });
    expect(JSON.parse(row.payload)).toEqual({ note: 'evidence', elapsedMs: 1500 });

    const withoutPayload = events.append(runId, {
      dimension: 'wall-clock',
      phase: 'verifying',
      limitValue: 2000,
      observedValue: 2001,
      configSource: 'default',
    });
    expect(withoutPayload.payload).toBe('{}');
  });

  it('assigns a 1-based monotonic seq per Run, sequencing each Run independently', () => {
    events.append(runId, {
      dimension: 'wall-clock',
      phase: 'executing',
      limitValue: 100,
      observedValue: 101,
      configSource: 'default',
    });
    const second = events.append(runId, {
      dimension: 'wall-clock',
      phase: 'executing',
      limitValue: 100,
      observedValue: 102,
      configSource: 'default',
    });
    expect(second.seq).toBe(2);

    const other = events.append(otherRunId, {
      dimension: 'wall-clock',
      phase: 'executing',
      limitValue: 100,
      observedValue: 103,
      configSource: 'workspace',
    });
    expect(other.seq).toBe(1); // a fresh Run starts at 1 regardless of other Runs
  });

  it("list returns a Run's events in seq order, and only that Run's", () => {
    events.append(runId, {
      dimension: 'wall-clock',
      phase: 'executing',
      limitValue: 100,
      observedValue: 101,
      configSource: 'default',
    });
    events.append(runId, {
      dimension: 'wall-clock',
      phase: 'validating',
      limitValue: 100,
      observedValue: 102,
      configSource: 'default',
    });
    events.append(otherRunId, {
      dimension: 'wall-clock',
      phase: 'executing',
      limitValue: 100,
      observedValue: 103,
      configSource: 'default',
    });

    const log = events.list(runId);
    expect(log.map((e) => e.seq)).toEqual([1, 2]);
    expect(log.map((e) => e.phase)).toEqual(['executing', 'validating']);
  });
});
