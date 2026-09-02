import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { baselineConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import { AttemptStore } from '../src/domain/attempts.js';
import { AttemptSettleCoordinator } from '../src/domain/attempt-settle.js';
import { EscalationService } from '../src/domain/escalation.js';
import { DomainError } from '../src/domain/errors.js';
import type { MergeEffectExec } from '../src/domain/merge.js';
import type { TaskState } from '../src/db/schema.js';
import type { SettingsStore } from '../src/server/settings-store.js';
import { allWorkspaces, makeSettingsStore } from './helpers.js';

const STATES: TaskState[] = ['draft', 'ready', 'working', 'escalated', 'done', 'cancelled'];

/** ADR-0020's legal transition table — the single source of truth the guard enforces. */
const LEGAL: Record<TaskState, TaskState[]> = {
  draft: ['ready', 'cancelled'],
  ready: ['working', 'escalated', 'done', 'cancelled'],
  working: ['ready', 'escalated', 'done', 'cancelled'],
  escalated: ['ready', 'done', 'cancelled'],
  done: [],
  cancelled: ['ready'],
};

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('Task lifecycle state machine (ADR-0020)', () => {
  let dir: string;
  let asyncDb: AsyncDbHandle;
  let settingsStore: SettingsStore;
  let tasks: TaskService;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-lifecycle-'));
    asyncDb = await openAsyncDb(dir);
    settingsStore = await makeSettingsStore(dir);
    tasks = new TaskService(asyncDb, () => baselineConfig(), allWorkspaces(asyncDb, settingsStore));
  });
  afterEach(async () => {
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Create a Task and walk it to `state` along legal edges only. */
  async function arrange(state: TaskState): Promise<number> {
    if (state === 'draft') return (await tasks.create({ prompt: 'p', state: 'draft' })).id;
    const { id } = await tasks.create({ prompt: 'p', state: 'ready' });
    if (state === 'ready') return id;
    if (state === 'working' || state === 'done' || state === 'cancelled') {
      if (state !== 'done') await tasks.setState(id, 'working');
      if (state === 'working') return id;
    }
    if (state === 'escalated') {
      await tasks.setState(id, 'working');
      await tasks.setState(id, 'escalated');
      return id;
    }
    await tasks.setState(id, state);
    return id;
  }

  describe('transition guard', () => {
    for (const from of STATES) {
      for (const to of STATES) {
        const isSelf = from === to;
        const isLegal = LEGAL[from].includes(to);
        if (isSelf) {
          it(`${from} → ${to} (self): no-op, state unchanged`, async () => {
            const id = await arrange(from);
            const row = await tasks.setState(id, to);
            expect(row.state).toBe(from);
          });
        } else if (isLegal) {
          it(`${from} → ${to}: allowed`, async () => {
            const id = await arrange(from);
            const row = await tasks.setState(id, to);
            expect(row.state).toBe(to);
          });
        } else {
          it(`${from} → ${to}: throws invalid_state, state unchanged`, async () => {
            const id = await arrange(from);
            const err = await tasks.setState(id, to).catch((e: unknown) => e);
            expect(err).toBeInstanceOf(DomainError);
            expect((err as DomainError).code).toBe('invalid_state');
            expect((await tasks.get(id)).state).toBe(from);
          });
        }
      }
    }

    it('escalate and requeue reject illegal source states', async () => {
      const done = await arrange('done');
      const escErr = await tasks.escalate(done, 'boom').catch((e: unknown) => e);
      expect((escErr as DomainError).code).toBe('invalid_state');

      const reqErr = await tasks.requeue(done).catch((e: unknown) => e);
      expect((reqErr as DomainError).code).toBe('invalid_state');
    });
  });

  describe('per-Task serialization (regression: task 452)', () => {
    it('Accept-merge holds the Task across verify→merge→settle so a racing requeue-to-ready cannot strand it', async () => {
      const attempts = new AttemptStore(asyncDb);
      const settle = new AttemptSettleCoordinator(tasks, attempts);

      // Escalate a Task with a candidate to accept.
      const created = await tasks.create({ prompt: 'p', state: 'ready' });
      await tasks.setState(created.id, 'working');
      const run = await attempts.update((await attempts.create(created.id)).id, { verifiedHeadOid: 'b'.repeat(40) });
      await settle.settle(await tasks.get(created.id), run, 'escalate', {
        runState: 'failed',
        taskAction: 'escalate',
        reason: 'escalated to human',
      });
      expect((await tasks.get(created.id)).state).toBe('escalated');

      // A merge effect that blocks mid-flight, modelling the slow conflict-resolving
      // merge under the Workspace mutex that stranded task 452.
      const mergeEntered = deferred();
      const releaseMerge = deferred();
      const effects: MergeEffectExec[] = [
        {
          effect: 'target-ref',
          idempotencyKey: 'main<-branch',
          expected: {},
          apply: async () => {
            mergeEntered.resolve();
            await releaseMerge.promise;
            return { ok: true, observed: {} };
          },
        },
      ];
      const service = new EscalationService(attempts, tasks, settle, () => effects, {
        resume: async () => {},
        cleanup: async () => {},
        candidateHead: async () => 'cand-oid',
        verifyCandidate: async () => ({ outcome: 'proceed', reason: '' }),
      });

      const acceptDone = service.accept(created.id);
      await mergeEntered.promise; // Accept is now inside its merge, holding the Task lock.

      // The verify/requeue loop fires a raw setState(ready) — as runner.ts and
      // auto-runner.ts do on a transient fault — while the merge is in flight.
      const requeue = tasks.setState(created.id, 'ready').catch((e: unknown) => e);

      releaseMerge.resolve();

      const accepted = await acceptDone;
      const requeueResult = await requeue;

      // The Task ends done, never ready; the racing requeue was serialized behind
      // the Accept and then failed cleanly (done → ready is illegal), never a blind write.
      expect(accepted.state).toBe('done');
      expect((await tasks.get(created.id)).state).toBe('done');
      expect(requeueResult).toBeInstanceOf(DomainError);
      expect((requeueResult as DomainError).code).toBe('invalid_state');
      expect(await attempts.get(run.id)).toMatchObject({ state: 'passed', reason: 'operator-accept' });
    });
  });
});
