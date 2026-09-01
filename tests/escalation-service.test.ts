import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { defaultConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import { AttemptStore } from '../src/domain/attempts.js';
import { AttemptSettleCoordinator } from '../src/domain/attempt-settle.js';
import type { MergeEffectExec } from '../src/domain/merge.js';
import { EscalationService } from '../src/domain/escalation.js';
import { DomainError } from '../src/domain/errors.js';
import type { AttemptRow, TaskRow } from '../src/db/schema.js';
import type { SettingsStore } from '../src/server/settings-store.js';
import type { VerificationDecision } from '../src/verification/combine.js';
import { allWorkspaces, makeSettingsStore } from './helpers.js';

describe('EscalationService', () => {
  let dir: string;
  let asyncDb: AsyncDbHandle;
  let settingsStore: SettingsStore;
  let tasks: TaskService;
  let attempts: AttemptStore;
  let settle: AttemptSettleCoordinator;
  let resumed: Array<{ taskId: number; guidance: string; startNow: boolean }>;
  let cleaned: Array<{ taskId: number; attemptId: number | undefined }>;
  let effects: MergeEffectExec[];
  let candidateHeadValue: string | null;
  let verifyDecision: VerificationDecision;
  let candidateHeadCalls: Array<{ taskId: number; runId: number }>;
  let verifyCandidateCalls: Array<{ taskId: number; runId: number; head: string }>;
  let service: EscalationService;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-escalation-service-'));
    asyncDb = await openAsyncDb(dir);
    settingsStore = await makeSettingsStore(dir);
    tasks = new TaskService(asyncDb, () => defaultConfig(), allWorkspaces(asyncDb, settingsStore));
    attempts = new AttemptStore(asyncDb);
    settle = new AttemptSettleCoordinator(tasks, attempts);
    resumed = [];
    cleaned = [];
    effects = [];
    candidateHeadValue = 'cand-oid';
    verifyDecision = { outcome: 'proceed', reason: '' };
    candidateHeadCalls = [];
    verifyCandidateCalls = [];
    service = new EscalationService(attempts, tasks, settle, () => effects, {
      resume: async (task, guidance, startNow) => {
        resumed.push({ taskId: task.id, guidance, startNow });
      },
      cleanup: async (task, run) => {
        cleaned.push({ taskId: task.id, attemptId: run?.id });
      },
      candidateHead: async (task, run) => {
        candidateHeadCalls.push({ taskId: task.id, runId: run.id });
        return candidateHeadValue;
      },
      verifyCandidate: async (task, run, head) => {
        verifyCandidateCalls.push({ taskId: task.id, runId: run.id, head });
        return verifyDecision;
      },
    });
  });
  afterEach(async () => {
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function escalated(candidate = true): Promise<{ task: TaskRow; run: AttemptRow }> {
    const created = await tasks.create({ prompt: 'p', state: 'ready' });
    await tasks.setState(created.id, 'working');
    let run = await attempts.create(created.id);
    if (candidate) run = await attempts.update(run.id, { verifiedHeadOid: 'b'.repeat(40) });
    await settle.settle(await tasks.get(created.id), run, 'escalate', {
      runState: 'failed',
      taskAction: 'escalate',
      reason: 'escalated to human: attempt 2 of 2 failed',
    });
    return { task: await tasks.get(created.id), run: await attempts.get(run.id) };
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
    it('unverified candidate: verify passes, merges the candidate under the operator-accept disposition and moves the ticket to done', async () => {
      const { task, run } = await escalated();
      expect(task.state).toBe('escalated');
      expect(run).toMatchObject({ state: 'escalated' });
      let applied = 0;
      effects = [{ effect: 'target-ref', idempotencyKey: 'main<-branch', expected: {}, apply: async () => { applied++; return { ok: true, observed: {} }; } }];

      const accepted = await service.accept(task.id);

      expect(candidateHeadCalls).toEqual([{ taskId: task.id, runId: run.id }]);
      expect(verifyCandidateCalls).toEqual([{ taskId: task.id, runId: run.id, head: 'cand-oid' }]);
      expect(applied).toBe(1);
      expect(accepted).toMatchObject({ state: 'done', escalationReason: null });
      // The operator's accept is the one disposition allowed to override an
      // already-`escalated` Attempt/Run (ADR-0001 #388 S-E's guarded transition).
      expect(await attempts.get(run.id)).toMatchObject({ state: 'passed', reason: 'operator-accept', verifiedHeadOid: 'cand-oid' });
      expect(resumed).toEqual([]);
    });

    it('unverified candidate: verify fails (block), hands the reason to the loop as feedback without merging', async () => {
      const { task, run } = await escalated();
      verifyDecision = { outcome: 'block', reason: 'boom' };
      let applied = 0;
      effects = [{ effect: 'target-ref', idempotencyKey: 'main<-branch', expected: {}, apply: async () => { applied++; return { ok: true, observed: {} }; } }];

      const accepted = await service.accept(task.id);

      expect(applied).toBe(0);
      expect(resumed).toHaveLength(1);
      expect(resumed[0]).toMatchObject({ taskId: task.id, startNow: false });
      expect(resumed[0]!.guidance).toContain('boom');
      expect(resumed[0]!.guidance).toContain('Operator Accept ran verification');
      expect(accepted.state).toBe('escalated');
      expect(await attempts.get(run.id)).toMatchObject({ state: 'escalated' });
    });

    it('unverified candidate: verify fails (escalate outcome), also hands the reason to the loop without merging', async () => {
      const { task } = await escalated();
      verifyDecision = { outcome: 'escalate', reason: 'flaky verifier' };

      const accepted = await service.accept(task.id);

      expect(resumed).toHaveLength(1);
      expect(resumed[0]).toMatchObject({ taskId: task.id, startNow: false });
      expect(resumed[0]!.guidance).toContain('flaky verifier');
      expect(accepted.state).toBe('escalated');
    });

    it('force skips verification and merges the candidate as-is', async () => {
      const { task, run } = await escalated();
      verifyDecision = { outcome: 'block', reason: 'would fail if consulted' };
      let applied = 0;
      effects = [{ effect: 'target-ref', idempotencyKey: 'main<-branch', expected: {}, apply: async () => { applied++; return { ok: true, observed: {} }; } }];

      const accepted = await service.accept(task.id, { force: true });

      expect(verifyCandidateCalls).toEqual([]);
      expect(applied).toBe(1);
      expect(accepted).toMatchObject({ state: 'done', escalationReason: null });
      expect(await attempts.get(run.id)).toMatchObject({ state: 'passed', reason: 'operator-accept', verifiedHeadOid: 'cand-oid' });
      expect(resumed).toEqual([]);
    });

    it('409s conflict when there is no candidate to accept, leaving the ticket escalated', async () => {
      const { task } = await escalated();
      candidateHeadValue = null;

      const err = await service.accept(task.id).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).code).toBe('conflict');
      expect((err as DomainError).message).toContain('no candidate to accept');
      expect((await tasks.get(task.id)).state).toBe('escalated');
      expect(verifyCandidateCalls).toEqual([]);
      expect(resumed).toEqual([]);
    });

    it('a failed merging effect surfaces its detail and leaves the ticket escalated with nothing further applied', async () => {
      const { task, run } = await escalated();
      effects = [{ effect: 'target-ref', idempotencyKey: 'main<-branch', expected: {}, apply: async () => ({ ok: false, detail: 'merge conflict in src/a.ts' }) }];

      await expect(service.accept(task.id)).rejects.toThrow('merge conflict in src/a.ts');

      expect((await tasks.get(task.id)).state).toBe('escalated');
      expect(await attempts.get(run.id)).toMatchObject({ state: 'escalated' });
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
      expect(cleaned).toEqual([{ taskId: task.id, attemptId: run.id }]);
      expect(resumed).toEqual([]);
    });

    it('cleans up an escalated ticket that never had a Run (an infrastructure escalation before spawn)', async () => {
      const created = await tasks.create({ prompt: 'p', state: 'ready' });
      await tasks.escalate(created.id, 'escalated to human: integration branch epic/9 missing for 60s');
      const closed = await service.close(created.id);
      expect(closed.state).toBe('cancelled');
      expect(cleaned).toEqual([{ taskId: created.id, attemptId: undefined }]);
    });
  });
});
