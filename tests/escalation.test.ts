// Merged escalation suite (direct-mode actions, EscalationService domain, HTTP routes).
// Consolidated so the isolated-pool import graph is paid once. Each source file's helpers
// stay block-scoped for byte-identical behavior.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { baselineConfig } from '../src/config.js';
import { type AsyncDbHandle, openAsyncDb } from '../src/db/async.js';
import { type AttemptRow, type TaskRow } from '../src/db/schema.js';
import { AttemptSettleCoordinator } from '../src/domain/attempt-settle.js';
import { AttemptStore } from '../src/domain/attempts.js';
import { DomainError } from '../src/domain/errors.js';
import { EscalationService } from '../src/domain/escalation.js';
import { type MergeEffectExec } from '../src/domain/merge.js';
import { TaskService } from '../src/domain/tasks.js';
import { VerificationAttemptStore } from '../src/domain/verification-attempts.js';
import { type SettingsStore } from '../src/server/settings-store.js';
import { type VerificationDecision } from '../src/verification/combine.js';
import { type Verdict } from '../src/verification/critic-schema.js';
import { type CriticDriveRequest, type CriticHarnessDrive } from '../src/verification/critic.js';
import { allWorkspaces, makeSettingsStore, startServer, stubHarness, type TestServer, waitFor } from './helpers.js';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ===== escalation.test.ts =====
{
  describe('escalation: the three actions (direct mode)', () => {
    let server: TestServer;

    beforeAll(async () => {
      server = await startServer({ ...stubHarness(), maxAttempts: 1 });
    });
    afterAll(async () => {
      await server.close();
    });

    const timeline = async (taskId: number) =>
      (await server.api('GET', `/api/tasks/${taskId}/attempts/timeline`)).body.attempts as Array<{
        number: number;
        state: string;
        feedback: string | null;
        steps: { type: string }[];
      }>;

    async function runToDone(prompt = 'do the thing'): Promise<number> {
      const created = await server.api('POST', '/api/tasks', { prompt });
      await server.api('POST', `/api/tasks/${created.body.id}/run`);
      await waitFor(async () => (await server.api('GET', `/api/tasks/${created.body.id}`)).body.state === 'done');
      return created.body.id;
    }

    async function runToEscalated(scenario: Record<string, unknown> = {}): Promise<number> {
      const created = await server.api('POST', '/api/tasks', {
        prompt: JSON.stringify({ exit: 'crash-before-response', ...scenario }),
      });
      await server.api('POST', `/api/tasks/${created.body.id}/run`);
      await waitFor(async () => (await server.api('GET', `/api/tasks/${created.body.id}`)).body.state === 'escalated');
      return created.body.id;
    }

    it('a passing native run merges to done with no human gate; done is terminal', async () => {
      const taskId = await runToDone();
      const task = (await server.api('GET', `/api/tasks/${taskId}`)).body;
      expect(task.state).toBe('done');
      expect(task.escalationReason).toBeNull();

      expect((await server.api('POST', `/api/tasks/${taskId}/cancel`)).status).toBe(409);
      expect((await server.api('POST', `/api/tasks/${taskId}/accept`)).status).toBe(409);
      expect((await server.api('POST', `/api/tasks/${taskId}/reject`, { guidance: 'x' })).status).toBe(409);
      expect((await server.api('POST', `/api/tasks/${taskId}/close`)).status).toBe(409);

      const run = (await server.api('GET', `/api/tasks/${taskId}/attempts`)).body.attempts[0];
      expect(run).toMatchObject({ state: 'completed' });
      const attempt = await new AttemptStore(server.app.ctx.asyncDb).getForTaskNumber(taskId, run.number);
      expect(attempt).toMatchObject({ state: 'passed', reason: 'agent-finish/unresolved' });
    });

    it('an exhausted attempt budget escalates with the reason recorded on the ticket and the attempt', async () => {
      const taskId = await runToEscalated();
      const task = (await server.api('GET', `/api/tasks/${taskId}`)).body;
      expect(task.state).toBe('escalated');
      expect(task.escalationReason).toMatch(/^escalated to human: attempt 1 of 1 failed/);

      const attempts = await timeline(taskId);
      expect(attempts.map((attempt) => attempt.state)).toEqual(['escalated']);
      const run = (await server.api('GET', `/api/tasks/${taskId}/attempts`)).body.attempts[0];
      expect(run.state).toBe('failed');
      expect(run.reason).toContain('escalated to human');
    });

    it('Accept refuses (409) when the escalated ticket has no verified branch head to merge', async () => {
      const taskId = await runToEscalated();
      const accepted = await server.api('POST', `/api/tasks/${taskId}/accept`);
      expect(accepted.status).toBe(409);
      expect(accepted.body.error.code).toBe('conflict');
      expect((await server.api('GET', `/api/tasks/${taskId}`)).body.state).toBe('escalated');
    });

    it('Reject with start now resumes the loop: the guidance is feedback and the budget resets', async () => {
      const taskId = await runToEscalated();
      const rejected = await server.api('POST', `/api/tasks/${taskId}/reject`, {
        guidance: 'Do not crash; write the CSV header first.',
        start: true,
      });
      expect(rejected.status).toBe(200);
      expect(['working', 'escalated']).toContain(rejected.body.state);

      // Unified manual resume (issue #506): the escalated Attempt is resumed in place —
      // re-running implementation with the guidance folded in — not replaced by a second Attempt.
      const again = await waitFor(async () => {
        const { body } = await server.api('GET', `/api/tasks/${taskId}`);
        const attempts = await timeline(taskId);
        return body.state === 'escalated' &&
          attempts.length === 1 &&
          attempts[0]!.steps.filter((step) => step.type === 'implementation').length >= 2
          ? body
          : undefined;
      });
      // Budget reset: the resumed Attempt re-escalates as "attempt 1 of 1".
      expect(again.escalationReason).toMatch(/attempt 1 of 1 failed/);
      const attemptsAfter = await timeline(taskId);
      expect(attemptsAfter.map((attempt) => ({ number: attempt.number, state: attempt.state }))).toEqual([
        { number: 1, state: 'escalated' },
      ]);
      const runs = (await server.api('GET', `/api/tasks/${taskId}/attempts`)).body.attempts;
      expect(runs).toHaveLength(1);
      expect(runs[0].prompt).toContain('Do not crash; write the CSV header first.');
      expect(runs[0].prompt).toContain('crash-before-response');
    });

    it('Reject without start requeues to ready and records the guidance, but does not force-start', async () => {
      const taskId = await runToEscalated();
      const rejected = await server.api('POST', `/api/tasks/${taskId}/reject`, {
        guidance: 'Do not crash; write the CSV header first.',
      });
      expect(rejected.status).toBe(200);
      expect(rejected.body.state).toBe('ready');
      await new Promise((r) => setTimeout(r, 50));
      expect((await server.api('GET', `/api/tasks/${taskId}`)).body.state).toBe('ready');
      const runs = (await server.api('GET', `/api/tasks/${taskId}/attempts`)).body.attempts;
      expect(runs).toHaveLength(1);
      expect((await timeline(taskId)).find((a) => a.number === 1)!.feedback).toBe(
        'Do not crash; write the CSV header first.',
      );
    });

    it('Reject without guidance is a validation error and changes nothing', async () => {
      const taskId = await runToEscalated();
      const rejected = await server.api('POST', `/api/tasks/${taskId}/reject`, { guidance: '   ' });
      expect(rejected.status).toBe(400);
      expect((await server.api('GET', `/api/tasks/${taskId}`)).body.state).toBe('escalated');
    });

    it('Close cancels the ticket and clears the escalation reason', async () => {
      const taskId = await runToEscalated();
      const closed = await server.api('POST', `/api/tasks/${taskId}/close`);
      expect(closed.status).toBe(200);
      expect(closed.body).toMatchObject({ state: 'cancelled', escalationReason: null });
      expect((await server.api('POST', `/api/tasks/${taskId}/close`)).status).toBe(409);
      expect((await server.api('POST', `/api/tasks/${taskId}/uncancel`)).body.state).toBe('ready');
    });

    it('the three actions apply to escalated tickets only', async () => {
      const created = await server.api('POST', '/api/tasks', { prompt: 'p' });
      expect((await server.api('POST', `/api/tasks/${created.body.id}/accept`)).status).toBe(409);
      expect((await server.api('POST', `/api/tasks/${created.body.id}/reject`, { guidance: 'x' })).status).toBe(409);
      expect((await server.api('POST', `/api/tasks/${created.body.id}/close`)).status).toBe(409);
      expect((await server.api('POST', `/api/tasks/${created.body.id}/requeue`, {})).status).toBe(404);
      expect((await server.api('POST', `/api/tasks/${created.body.id}/unescalate`)).status).toBe(404);
      expect((await server.api('POST', `/api/tasks/${created.body.id}/adopt-review`)).status).toBe(404);
      expect((await server.api('POST', `/api/tasks/${created.body.id}/note-to-critic`, { note: 'x' })).status).toBe(404);
    });

    it("the agent's escalate_task escalates to a human immediately, superseding the retry budget", async () => {
      const escServer = await startServer({ ...stubHarness(), maxAttempts: 3 });
      try {
        await escServer.app.ctx.settingsStore.updateGlobal({
          drive: { prompt: JSON.stringify({ mcpEscalate: { reason: 'need a decision on the schema' } }) },
        });
        const workspaceId = (await escServer.app.ctx.workspaces.list())[0]!.id;
        const mirrored = await escServer.app.ctx.tasks.upsertMirrored(
          { trackerRef: 31_401, prompt: 'ticket 31401', workflow: 'implement', wayfinderType: null, mapRef: null, closed: false },
          workspaceId,
        );
        expect((await escServer.api('POST', `/api/tasks/${mirrored.id}/run`)).status).toBe(201);
        await waitFor(async () => (await escServer.api('GET', `/api/tasks/${mirrored.id}`)).body.state === 'escalated');
        const task = (await escServer.api('GET', `/api/tasks/${mirrored.id}`)).body;
        expect(task.escalationReason).toMatch(/the agent asked for a human: need a decision on the schema/);
        const attempts = await new AttemptStore(escServer.app.ctx.asyncDb).listForTask(mirrored.id);
        expect(attempts.map((attempt) => attempt.state)).toEqual(['escalated']);
      } finally {
        await escServer.close();
      }
    });
  });
}

// ===== escalation-service.test.ts =====
{
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
      tasks = new TaskService(asyncDb, () => baselineConfig(), allWorkspaces(asyncDb, settingsStore));
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
}

// ===== escalation-routes.test.ts =====
{
  const git = (dir: string, ...args: string[]) =>
    execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

  function makeRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'harmonic-escalation-routes-'));
    execFileSync('git', ['init', '-b', 'main', dir], { encoding: 'utf8' });
    git(dir, 'config', 'user.name', 'Test');
    git(dir, 'config', 'user.email', 'test@example.com');
    writeFileSync(join(dir, 'README.md'), '# repo\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-m', 'init');
    return dir;
  }

  const critic = () => ({ reviewEnabled: true, reviewPrompt: 'Review the diff for correctness.', reviewModel: 'stub-model' });

  describe('escalation actions on a worktree ticket', () => {
    let server: TestServer;
    let repoDir: string;
    let workspaceId: number;
    let criticResult: { verdict: Verdict; summary: string };

    const criticDrive: CriticHarnessDrive = {
      run: async (_req: CriticDriveRequest) => ({ output: JSON.stringify(criticResult), permissionRequests: [] }),
    };

    beforeAll(async () => {
      repoDir = makeRepo();
      server = await startServer(stubHarness(), { criticDrive });
      const ws = (await server.app.ctx.workspaces.list())[0]!;
      workspaceId = ws.id;
      await server.app.ctx.workspaces.update(workspaceId, { workingDir: repoDir });
      await server.app.ctx.settingsStore.updateGlobal({ maxAttempts: 2 });
    });
    afterAll(async () => {
      await server.close();
      rmSync(repoDir, { recursive: true, force: true });
    });
    beforeEach(async () => {
      criticResult = { verdict: 'fail', summary: 'not good enough yet' };
      await server.app.ctx.workspaces.update(workspaceId, {
        isolationMode: 'worktree',
        verificationCommand: null,
        ...critic(),
      });
    });

    let implSeq = 0;
    async function createAndRun(): Promise<{ taskId: number; attemptId: number; file: string }> {
      const file = `escalation-feature-${++implSeq}.txt`;
      const created = await server.api('POST', '/api/tasks', {
        prompt: JSON.stringify({ writeFiles: { [file]: 'work\n' } }),
        workingDir: repoDir,
        isolationMode: 'worktree',
      });
      expect(created.status).toBe(201);
      const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
      expect(started.status).toBe(201);
      return { taskId: created.body.id, attemptId: started.body.id, file };
    }

    async function escalateViaCriticFail(): Promise<{ taskId: number; attemptId: number; file: string }> {
      const { taskId, attemptId, file } = await createAndRun();
      const task = await waitFor(async () => {
        const { body } = await server.api('GET', `/api/tasks/${taskId}`);
        return body.state === 'escalated' ? body : undefined;
      });
      expect(task.escalationReason).toMatch(/attempt 2 of 2 failed/);
      expect((await server.api('GET', `/api/tasks/${taskId}/attempts/current`)).body).toMatchObject({ state: 'failed' });
      return { taskId, attemptId, file };
    }

    const ticketAttempts = (taskId: number) => new AttemptStore(server.app.ctx.asyncDb).listForTask(taskId);
    const verificationAttempts = async (taskId: number) => {
      const store = new VerificationAttemptStore(server.app.ctx.asyncDb);
      const taskAttemptRows = await ticketAttempts(taskId);
      return (await Promise.all(taskAttemptRows.map((a) => store.list(a.id)))).flat();
    };

    it('escalates with the exhausted Attempt marked escalated, its verified head retained, and the branch kept as evidence', async () => {
      const { taskId } = await escalateViaCriticFail();
      expect(await verificationAttempts(taskId)).toHaveLength(2);
      const run = (await server.api('GET', `/api/tasks/${taskId}/attempts/current`)).body;
      expect(run.verifiedHeadOid).toMatch(/^[0-9a-f]{40}$/);
      expect(git(repoDir, 'rev-parse', '--verify', run.branch)).toBe(run.verifiedHeadOid);
      const attempts = await ticketAttempts(taskId);
      expect(attempts.map((a) => a.state)).toEqual(['failed', 'escalated']);
      expect((await server.api('GET', `/api/tasks/${taskId}`)).body.verifiedRef).not.toBeNull();
    });

    describe('POST /tasks/:id/accept', () => {
      it('force: true merges the candidate as-is, overriding a still-failing critic — an operator override', async () => {
        const baseOidBefore = git(repoDir, 'rev-parse', 'main');
        const { taskId, file } = await escalateViaCriticFail();

        const accepted = await server.api('POST', `/api/tasks/${taskId}/accept`, { force: true });
        expect(accepted.status).toBe(200);
        expect(accepted.body).toMatchObject({ state: 'done', escalationReason: null });

        const run = (await server.api('GET', `/api/tasks/${taskId}/attempts/current`)).body;
        expect(run).toMatchObject({ state: 'completed' });

        const attempts = await ticketAttempts(taskId);
        expect(attempts.at(-1)).toMatchObject({ state: 'passed', reason: 'operator-accept' });

        expect(git(repoDir, 'rev-parse', 'main')).not.toBe(baseOidBefore);
        expect(git(repoDir, 'show', `main:${file}`)).toBe('work');
      });

      it('a default accept (no force) verifies the candidate first; a passing verify merges it and moves the ticket to done (issue #429)', async () => {
        const baseOidBefore = git(repoDir, 'rev-parse', 'main');
        const { taskId, file } = await escalateViaCriticFail();
        criticResult = { verdict: 'pass', summary: 'looks correct now' };

        const accepted = await server.api('POST', `/api/tasks/${taskId}/accept`);
        expect(accepted.status).toBe(200);
        expect(accepted.body).toMatchObject({ state: 'done', escalationReason: null });
        expect(git(repoDir, 'rev-parse', 'main')).not.toBe(baseOidBefore);
        expect(git(repoDir, 'show', `main:${file}`)).toBe('work');
      });

      it('an empty body ({}) also defaults force to false and still verifies', async () => {
        const { taskId } = await escalateViaCriticFail();
        criticResult = { verdict: 'pass', summary: 'looks correct now' };

        const accepted = await server.api('POST', `/api/tasks/${taskId}/accept`, {});
        expect(accepted.status).toBe(200);
        expect(accepted.body).toMatchObject({ state: 'done', escalationReason: null });
      });

      it('409s invalid_state when the ticket is not escalated (a passing critic merges on its own)', async () => {
        criticResult = { verdict: 'pass', summary: 'looks correct' };
        const { taskId } = await createAndRun();
        await waitFor(async () => ((await server.api('GET', `/api/tasks/${taskId}`)).body.state === 'done' ? true : undefined));

        const res = await server.api('POST', `/api/tasks/${taskId}/accept`);
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('invalid_state');
      });

      it('409s conflict when the escalated ticket has no candidate to accept (the branch has no commits ahead of its base)', async () => {
        await server.app.ctx.workspaces.update(workspaceId, { isolationMode: 'direct' });
        writeFileSync(join(repoDir, 'uncommitted-escalation.txt'), 'dirty\n');
        try {
          const created = await server.api('POST', '/api/tasks', {
            prompt: JSON.stringify({ stopReason: 'end_turn' }),
          });
          expect(created.status).toBe(201);
          const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
          expect(started.status).toBe(201);
          const task = await waitFor(async () => {
            const { body } = await server.api('GET', `/api/tasks/${created.body.id}`);
            return body.state === 'escalated' ? body : undefined;
          });
          expect(task.verifiedRef).toBeNull();

          const res = await server.api('POST', `/api/tasks/${created.body.id}/accept`);
          expect(res.status).toBe(409);
          expect(res.body.error.code).toBe('conflict');
          expect((await server.api('POST', `/api/tasks/${created.body.id}/close`)).status).toBe(200);
        } finally {
          rmSync(join(repoDir, 'uncommitted-escalation.txt'), { force: true });
        }
      });
    });

    describe('POST /tasks/:id/reject', () => {
      it('resumes the loop on the same ticket and branch with the guidance as feedback and the budget reset', async () => {
        const { taskId } = await escalateViaCriticFail();
        const branch = (await server.api('GET', `/api/tasks/${taskId}/attempts/current`)).body.branch as string;

        criticResult = { verdict: 'pass', summary: 'the guidance was followed' };
        const rejected = await server.api('POST', `/api/tasks/${taskId}/reject`, {
          guidance: 'The timeout is intentional; see the linked ticket.',
          start: true,
        });
        expect(rejected.status).toBe(200);
        expect(rejected.body.escalationReason).toBeNull();

        const done = await waitFor(async () => {
          const { body } = await server.api('GET', `/api/tasks/${taskId}`);
          return body.state === 'done' ? body : undefined;
        });
        expect(done.state).toBe('done');
        const attempts = await ticketAttempts(taskId);
        // Resume-in-place (issue #506): the escalated Attempt 2 is resumed on the same
        // branch and now passes — no third Attempt row is created.
        expect(attempts.map((a) => ({ number: a.number, state: a.state }))).toEqual([
          { number: 1, state: 'failed' },
          { number: 2, state: 'passed' },
        ]);

        const runs = (await server.api('GET', `/api/tasks/${taskId}/attempts`)).body.attempts;
        expect(runs).toHaveLength(2);
        expect(runs[1].number).toBe(2);
        expect(runs[1].prompt).toContain('The timeout is intentional');
        expect(branch).toBe(`harmonic/task-${taskId}`);
        expect(runs[1].branch).toBe(branch);
        expect(runs[0].branch).toBe(branch);
      });

      it('400s on empty guidance and leaves the ticket escalated', async () => {
        const { taskId } = await escalateViaCriticFail();
        const res = await server.api('POST', `/api/tasks/${taskId}/reject`, { guidance: '' });
        expect(res.status).toBe(400);
        expect((await server.api('GET', `/api/tasks/${taskId}`)).body.state).toBe('escalated');
      });
    });

    describe('POST /tasks/:id/close', () => {
      it('cancels the ticket and removes its branch and worktree', async () => {
        const { taskId } = await escalateViaCriticFail();
        const run = (await server.api('GET', `/api/tasks/${taskId}/attempts/current`)).body;
        expect(git(repoDir, 'branch', '--list', run.branch)).not.toBe('');
        const session = await server.app.ctx.sessions.get(run.sessionRowId);
        expect(session.worktreePath && existsSync(session.worktreePath)).toBe(true);

        const closed = await server.api('POST', `/api/tasks/${taskId}/close`);
        expect(closed.status).toBe(200);
        expect(closed.body).toMatchObject({ state: 'cancelled', escalationReason: null });

        await waitFor(async () => (existsSync(session.worktreePath!) ? undefined : true));
        expect(git(repoDir, 'branch', '--list', run.branch)).toBe('');
        await waitFor(async () => ((await server.app.ctx.sessions.get(run.sessionRowId)).status === 'retired' ? true : undefined));
        expect(git(repoDir, 'status', '--porcelain')).toBe('');
      });
    });
  });
}
