import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { defaultConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import { RunStore } from '../src/domain/runs.js';
import { RunFactStore } from '../src/domain/run-facts.js';
import { MergeJournalStore } from '../src/domain/merge-journal.js';
import { RunSettleCoordinator } from '../src/domain/run-settle.js';
import type { MergeEffectExec } from '../src/domain/merge-coordinator.js';
import { EscalationService } from '../src/domain/escalation.js';
import { DomainError } from '../src/domain/errors.js';
import type { RunRow, TaskRow } from '../src/db/schema.js';
import type { SettingsStore } from '../src/server/settings-store.js';
import { allWorkspaces, makeSettingsStore } from './helpers.js';

/**
 * `EscalationService` against the real stores (ADR-0041): exactly three
 * actions, each gated to `escalated`, each with the behaviour the ADR
 * specifies — Accept merges the verified head and continues the success path,
 * Reject with guidance hands the guidance to the loop, Close cancels and
 * cleans up.
 */
describe('EscalationService', () => {
  let dir: string;
  let asyncDb: AsyncDbHandle;
  let settingsStore: SettingsStore;
  let tasks: TaskService;
  let runStore: RunStore;
  let settle: RunSettleCoordinator;
  let resumed: Array<{ taskId: number; guidance: string; startNow: boolean }>;
  let cleaned: Array<{ taskId: number; runId: number | undefined }>;
  let effects: MergeEffectExec[];
  let service: EscalationService;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-escalation-service-'));
    asyncDb = await openAsyncDb(dir);
    settingsStore = await makeSettingsStore(dir);
    tasks = new TaskService(asyncDb, () => defaultConfig(), allWorkspaces(asyncDb, settingsStore));
    runStore = new RunStore(asyncDb);
    const journal = new MergeJournalStore(asyncDb);
    settle = new RunSettleCoordinator(runStore, tasks, new RunFactStore(asyncDb), undefined, journal);
    resumed = [];
    cleaned = [];
    effects = [];
    service = new EscalationService(runStore, tasks, settle, () => effects, {
      resume: async (task, guidance, startNow) => {
        resumed.push({ taskId: task.id, guidance, startNow });
      },
      cleanup: async (task, run) => {
        cleaned.push({ taskId: task.id, runId: run?.id });
      },
    });
  });
  afterEach(async () => {
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** An escalated ticket whose Run settled `failed` with a verified head (unless `candidate` is false). */
  async function escalated(candidate = true): Promise<{ task: TaskRow; run: RunRow }> {
    const created = await tasks.create({ prompt: 'p', state: 'ready' });
    await tasks.setState(created.id, 'working');
    let run = await runStore.create(created.id);
    if (candidate) run = await runStore.update(run.id, { candidateOid: 'b'.repeat(40) });
    await settle.settle(await tasks.get(created.id), run, 'escalate', {
      runState: 'failed',
      taskAction: 'escalate',
      reason: 'escalated to human: attempt 2 of 2 failed',
    });
    return { task: await tasks.get(created.id), run: await runStore.get(run.id) };
  }

  it('every action 409s invalid_state on a ticket that is not escalated', async () => {
    const ready = await tasks.create({ prompt: 'p', state: 'ready' });
    for (const call of [
      () => service.accept(ready.id),
      () => service.reject(ready.id, 'guidance'),
      () => service.close(ready.id),
    ]) {
      const err = await call().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).code).toBe('invalid_state');
    }
    expect((await tasks.get(ready.id)).state).toBe('ready');
  });

  describe('accept', () => {
    it('merges the verified head under the operator-accept disposition and moves the ticket to done', async () => {
      const { task, run } = await escalated();
      expect(task.state).toBe('escalated');
      expect(run).toMatchObject({ state: 'failed', phase: 'terminal' });
      let applied = 0;
      effects = [{ effect: 'target-ref', idempotencyKey: 'main<-branch', expected: {}, apply: async () => { applied++; return { ok: true, observed: {} }; } }];

      const accepted = await service.accept(task.id);

      expect(applied).toBe(1);
      expect(accepted).toMatchObject({ state: 'done', escalationReason: null });
      // The operator's accept outranks the retained escalate fact on the log.
      expect(await runStore.get(run.id)).toMatchObject({ state: 'completed', phase: 'terminal' });
      const types = (await new RunFactStore(asyncDb).list(run.id)).map((f) => f.type);
      expect(types).toContain('escalate');
      expect(types).toContain('operator-accept');
    });

    it('409s conflict when there is no verified head to merge, leaving the ticket escalated', async () => {
      const { task } = await escalated(false);
      const err = await service.accept(task.id).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).code).toBe('conflict');
      expect((await tasks.get(task.id)).state).toBe('escalated');
    });

    it('a failed merging effect surfaces its detail and leaves the ticket escalated with nothing further applied', async () => {
      const { task, run } = await escalated();
      effects = [{ effect: 'target-ref', idempotencyKey: 'main<-branch', expected: {}, apply: async () => ({ ok: false, detail: 'merge conflict in src/a.ts' }) }];

      await expect(service.accept(task.id)).rejects.toThrow('merge conflict in src/a.ts');

      expect((await tasks.get(task.id)).state).toBe('escalated');
      expect(await runStore.get(run.id)).toMatchObject({ state: 'failed', phase: 'terminal' });
      // Accept no longer routes through the journaled MergeCoordinator
      // (ADR-0001, #388 S-B): a failed effect writes nothing to merge_journal.
      expect(await new MergeJournalStore(asyncDb).views(run.id)).toEqual([]);
    });
  });

  describe('reject with guidance', () => {
    it('hands the trimmed guidance to the loop and requeues without a forced start by default', async () => {
      const { task } = await escalated();
      await service.reject(task.id, '  use the shared limiter  ');
      expect(resumed).toEqual([{ taskId: task.id, guidance: 'use the shared limiter', startNow: false }]);
      expect(cleaned).toEqual([]);
    });

    it('propagates the warm-Session "start now" override when requested', async () => {
      const { task } = await escalated();
      await service.reject(task.id, 'use the shared limiter', true);
      expect(resumed).toEqual([{ taskId: task.id, guidance: 'use the shared limiter', startNow: true }]);
    });

    it('requires guidance (validation), and does not resume without it', async () => {
      const { task } = await escalated();
      const err = await service.reject(task.id, '   ').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).code).toBe('validation');
      expect(resumed).toEqual([]);
      expect((await tasks.get(task.id)).state).toBe('escalated');
    });
  });

  describe('close', () => {
    it('cancels the ticket, clears the reason, and runs cleanup with the latest Run', async () => {
      const { task, run } = await escalated();
      const closed = await service.close(task.id);
      expect(closed).toMatchObject({ state: 'cancelled', escalationReason: null });
      expect(cleaned).toEqual([{ taskId: task.id, runId: run.id }]);
      expect(resumed).toEqual([]);
    });

    it('cleans up an escalated ticket that never had a Run (an infrastructure escalation before spawn)', async () => {
      const created = await tasks.create({ prompt: 'p', state: 'ready' });
      await tasks.escalate(created.id, 'escalated to human: integration branch epic/9 missing for 60s');
      const closed = await service.close(created.id);
      expect(closed.state).toBe('cancelled');
      expect(cleaned).toEqual([{ taskId: created.id, runId: undefined }]);
    });
  });
});
