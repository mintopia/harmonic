import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { baselineConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import { DomainError } from '../src/domain/errors.js';
import type { TaskState } from '../src/db/schema.js';
import type { SettingsStore } from '../src/server/settings-store.js';
import { allWorkspaces, makeSettingsStore, seedWorkspace } from './helpers.js';

const STATES: TaskState[] = ['draft', 'ready', 'working', 'paused', 'escalated', 'done', 'cancelled'];

/** ADR-0020's legal transition table (amended by ADR-0038's escalated → working
 * operator-Accept step-advance) — the single source of truth the guard enforces. */
const LEGAL: Record<TaskState, TaskState[]> = {
  draft: ['ready', 'cancelled'],
  ready: ['working', 'escalated', 'done', 'cancelled'],
  working: ['ready', 'paused', 'escalated', 'done', 'cancelled'],
  paused: ['working', 'cancelled'],
  escalated: ['ready', 'working', 'done', 'cancelled'],
  done: [],
  cancelled: ['ready'],
};

describe('Task lifecycle state machine (ADR-0020)', () => {
  let dir: string;
  let asyncDb: AsyncDbHandle;
  let settingsStore: SettingsStore;
  let tasks: TaskService;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-lifecycle-'));
    asyncDb = await openAsyncDb(dir);
    await seedWorkspace(asyncDb);
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
    if (state === 'working' || state === 'paused' || state === 'done' || state === 'cancelled') {
      if (state !== 'done') await tasks.setState(id, 'working');
      if (state === 'working') return id;
    }
    if (state === 'paused') {
      await tasks.setState(id, 'paused');
      return id;
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

    it('pauses and resumes through the lifecycle transition guard', async () => {
      const created = await tasks.create({ prompt: 'p', state: 'ready' });
      await tasks.setState(created.id, 'working');

      expect((await tasks.pause(created.id)).state).toBe('paused');
      expect((await tasks.resume(created.id)).state).toBe('working');

      const resumeErr = await tasks.resume(created.id).catch((e: unknown) => e);
      expect(resumeErr).toBeInstanceOf(DomainError);
      expect((resumeErr as DomainError).code).toBe('invalid_state');

      await tasks.setState(created.id, 'ready');
      const err = await tasks.pause(created.id).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).code).toBe('invalid_state');
    });
  });
});
