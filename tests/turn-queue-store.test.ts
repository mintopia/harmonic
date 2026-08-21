import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../src/db/index.js';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { defaultConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import { RunStore } from '../src/domain/runs.js';
import { TurnQueueStore } from '../src/domain/turn-queue-store.js';
import { allWorkspaces } from './helpers.js';

/**
 * The Session turn queue's persisted substrate (issue #116, reliability-design
 * §0.4).
 */
describe('TurnQueueStore (issue #116)', () => {
  let dir: string;
  let db: Db;
  // RunStore migrated to the async libsql Db (ADR-0029 #203); this fixture
  // runs both connections on the one file.
  let asyncDb: AsyncDbHandle;
  let store: TurnQueueStore;
  let runId: number;
  let otherRunId: number;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-turn-queue-'));
    db = openDb(dir);
    asyncDb = await openAsyncDb(dir);
    const tasks = new TaskService(asyncDb, () => defaultConfig(), allWorkspaces(db));
    const runStore = new RunStore(asyncDb);
    store = new TurnQueueStore(db);

    const task = await tasks.create({ prompt: 'drive turns', state: 'ready' });
    runId = (await runStore.create(task.id)).id;
    const otherTask = await tasks.create({ prompt: 'separate session', state: 'ready' });
    otherRunId = (await runStore.create(otherTask.id)).id;
  });
  afterEach(async () => {
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('assigns a 1-based monotonic seq per Session and stores the turn', () => {
    const first = store.enqueue('session-a', runId, 'initial');
    expect(first).toMatchObject({ sessionId: 'session-a', runId, seq: 1, status: 'queued', purpose: 'initial' });

    const second = store.enqueue('session-a', runId, 'continue');
    expect(second.seq).toBe(2);
  });

  it('sequences each Session independently', () => {
    store.enqueue('session-a', runId, 'initial');
    const otherSession = store.enqueue('session-b', otherRunId, 'initial');
    expect(otherSession.seq).toBe(1); // a fresh Session starts at 1 regardless of other Sessions
    expect(store.enqueue('session-a', runId, 'continue').seq).toBe(2);
  });

  describe('mutating turns must bind expectedWorkspaceOID and expectedFingerprint', () => {
    it('throws when a self-heal is enqueued without both bindings', () => {
      expect(() => store.enqueue('session-a', runId, 'self-heal')).toThrow(
        /mutating turn "self-heal" must bind expectedWorkspaceOID and expectedFingerprint/,
      );
      expect(() => store.enqueue('session-a', runId, 'self-heal', { expectedWorkspaceOID: 'oid-a' })).toThrow(
        /mutating turn "self-heal" must bind expectedWorkspaceOID and expectedFingerprint/,
      );
      expect(() => store.enqueue('session-a', runId, 'self-heal', { expectedFingerprint: 'fp-a' })).toThrow(
        /mutating turn "self-heal" must bind expectedWorkspaceOID and expectedFingerprint/,
      );
    });

    it('succeeds when both bindings are present', () => {
      const row = store.enqueue('session-a', runId, 'self-heal', {
        expectedWorkspaceOID: 'oid-a',
        expectedFingerprint: 'fp-a',
      });
      expect(row.status).toBe('queued');
    });
  });

  it('enqueue maps expectedWorkspaceOID to the expected_workspace_oid column', () => {
    const row = store.enqueue('session-a', runId, 'self-heal', {
      expectedPhase: 'executing',
      expectedGeneration: 1,
      expectedWorkspaceOID: 'oid-a',
      expectedFingerprint: 'fp-a',
    });
    expect(row.expectedWorkspaceOid).toBe('oid-a');
    expect(row.expectedPhase).toBe('executing');
    expect(row.expectedGeneration).toBe(1);
    expect(row.expectedFingerprint).toBe('fp-a');
  });

  it("listForSession returns a Session's queue in seq order, and only that Session's", () => {
    store.enqueue('session-a', runId, 'initial');
    store.enqueue('session-a', runId, 'continue');
    store.enqueue('session-b', otherRunId, 'initial');

    const queue = store.listForSession('session-a');
    expect(queue.map((t) => t.seq)).toEqual([1, 2]);
    expect(queue.map((t) => t.purpose)).toEqual(['initial', 'continue']);
  });

  it('claim -> markInFlight -> settle transitions persist', () => {
    const enqueued = store.enqueue('session-a', runId, 'initial');
    const claimed = store.claim(enqueued.id);
    expect(claimed.status).toBe('claimed');
    expect(claimed.claimedAt).not.toBeNull();

    const inFlight = store.markInFlight(enqueued.id, 'idem-1');
    expect(inFlight.status).toBe('in_flight');
    expect(inFlight.idempotencyKey).toBe('idem-1');
    expect(inFlight.sentAt).not.toBeNull();

    const settled = store.settle(enqueued.id, 'done');
    expect(settled.status).toBe('done');
    expect(settled.settledAt).not.toBeNull();
  });

  it('cancel sets status and cancelReason', () => {
    const enqueued = store.enqueue('session-a', runId, 'continue');
    const cancelled = store.cancel(enqueued.id, 'wrong-phase');
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancelReason).toBe('wrong-phase');
    expect(cancelled.settledAt).not.toBeNull();
  });

  describe('single-flight backstop (AC1, DB-level proof)', () => {
    it('rejects a second concurrent in_flight turn for the same Session', () => {
      const first = store.enqueue('session-a', runId, 'initial');
      const second = store.enqueue('session-a', runId, 'continue');

      store.claim(first.id);
      store.markInFlight(first.id, 'idem-1');

      store.claim(second.id);
      expect(() => store.markInFlight(second.id, 'idem-2')).toThrow(/UNIQUE constraint failed/);
    });

    it('allows the next turn in_flight once the first has settled', () => {
      const first = store.enqueue('session-a', runId, 'initial');
      const second = store.enqueue('session-a', runId, 'continue');

      store.claim(first.id);
      store.markInFlight(first.id, 'idem-1');
      store.settle(first.id, 'done');

      store.claim(second.id);
      const inFlight = store.markInFlight(second.id, 'idem-2');
      expect(inFlight.status).toBe('in_flight');
    });
  });
});
