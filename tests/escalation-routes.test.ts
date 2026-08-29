import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, stubHarness, waitFor, type TestServer } from './helpers.js';
import { VerificationAttemptStore } from '../src/domain/verification-attempts.js';
import { AttemptStore } from '../src/domain/attempts.js';
import type { CriticHarnessDrive, CriticDriveRequest } from '../src/verification/critic.js';
import type { Verdict } from '../src/verification/critic-schema.js';

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

/** A throwaway git repo on branch main with one committed file (same template
 * as tests/verification-critic.test.ts). */
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

/** The decomposed review-override fields (issue #337) for a configured critic. */
const critic = () => ({ reviewEnabled: true, reviewPrompt: 'Review the diff for correctness.', reviewModel: 'stub-model' });

/**
 * ADR-0041's escalation surface on a worktree ticket the critic rejected twice:
 * Accept merges the verified head as-is (the critic's opinion is not a gate any
 * more once a human decides), Reject with guidance resumes the loop with the
 * budget reset, Close removes the branch and worktree. Replaces the retired
 * "Adopt & review" / "Note to critic" escape hatches (ADR-0027).
 */
describe('escalation actions on a worktree ticket (ADR-0041)', () => {
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
    await server.app.ctx.configStore.update({ maxAttempts: 2 });
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

  // An accepted run merges its file into main, so a repeated identical write
  // would leave the next stub agent nothing to commit (and thus no verifiable
  // head). A unique file per run keeps every run's commit real.
  let implSeq = 0;
  async function createAndRun(): Promise<{ taskId: number; runId: number; file: string }> {
    const file = `escalation-feature-${++implSeq}.txt`;
    const created = await server.api('POST', '/api/tasks', {
      prompt: JSON.stringify({ writeFiles: { [file]: 'work\n' } }),
      workingDir: repoDir,
      isolationMode: 'worktree',
    });
    expect(created.status).toBe(201);
    const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
    expect(started.status).toBe(201);
    return { taskId: created.body.id, runId: started.body.id, file };
  }

  /** Drive a fresh task+run to escalation via a failing critic on both attempts. */
  async function escalateViaCriticFail(): Promise<{ taskId: number; runId: number; file: string }> {
    const { taskId, runId, file } = await createAndRun();
    const task = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/tasks/${taskId}`);
      return body.state === 'escalated' ? body : undefined;
    });
    expect(task.escalationReason).toMatch(/attempt 2 of 2 failed/);
    expect((await server.api('GET', `/api/tasks/${taskId}/attempts/current`)).body).toMatchObject({ state: 'failed' });
    return { taskId, runId, file };
  }

  const ticketAttempts = (taskId: number) => new AttemptStore(server.app.ctx.asyncDb).listForTask(taskId);
  // `verification_attempts` is keyed off `attempt_id`, not `run_id`
  // (ADR-0001 #388 S-F): a self-heal loop's failed attempts share one Run row
  // but each get their own Attempt row, so "this ticket's verification
  // attempts" now folds the log across every one of its Attempts.
  const verificationAttempts = async (taskId: number) => {
    const store = new VerificationAttemptStore(server.app.ctx.asyncDb);
    const taskAttemptRows = await ticketAttempts(taskId);
    return (await Promise.all(taskAttemptRows.map((a) => store.list(a.id)))).flat();
  };

  it('escalates with the exhausted Attempt marked escalated, its verified head retained, and the branch kept as evidence', async () => {
    const { taskId } = await escalateViaCriticFail();
    expect(await verificationAttempts(taskId)).toHaveLength(2);
    const run = (await server.api('GET', `/api/tasks/${taskId}/attempts/current`)).body;
    expect(run.candidateOid).toMatch(/^[0-9a-f]{40}$/);
    expect(git(repoDir, 'rev-parse', '--verify', run.branch)).toBe(run.candidateOid);
    const attempts = await ticketAttempts(taskId);
    expect(attempts.map((a) => a.state)).toEqual(['failed', 'escalated']);
    expect((await server.api('GET', `/api/tasks/${taskId}`)).body.candidateRef).not.toBeNull();
  });

  describe('POST /tasks/:id/accept', () => {
    it('merges the verified head into the base branch and moves the ticket to done — an operator accept overrides the escalated Attempt', async () => {
      const baseOidBefore = git(repoDir, 'rev-parse', 'main');
      const { taskId, file } = await escalateViaCriticFail();

      const accepted = await server.api('POST', `/api/tasks/${taskId}/accept`);
      expect(accepted.status).toBe(200);
      expect(accepted.body).toMatchObject({ state: 'done', escalationReason: null });

      const run = (await server.api('GET', `/api/tasks/${taskId}/attempts/current`)).body;
      expect(run).toMatchObject({ state: 'completed' });

      // The operator's accept is the one disposition allowed to move an
      // already-`escalated` Attempt (ADR-0001 #388 S-E's guarded transition).
      const attempts = await ticketAttempts(taskId);
      expect(attempts.at(-1)).toMatchObject({ state: 'passed', reason: 'operator-accept' });

      // The merge actually happened: the base branch moved and carries the work.
      expect(git(repoDir, 'rev-parse', 'main')).not.toBe(baseOidBefore);
      expect(git(repoDir, 'show', `main:${file}`)).toBe('work');
    });

    it('409s invalid_state when the ticket is not escalated (a passing critic merges on its own)', async () => {
      criticResult = { verdict: 'pass', summary: 'looks correct' };
      const { taskId } = await createAndRun();
      await waitFor(async () => ((await server.api('GET', `/api/tasks/${taskId}`)).body.state === 'done' ? true : undefined));

      const res = await server.api('POST', `/api/tasks/${taskId}/accept`);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('invalid_state');
    });

    it('409s conflict when the escalated ticket never produced a verified head', async () => {
      // Direct mode + a dirty tree: no commit, so verification fails closed with
      // nothing a corrective turn could fix (mirrors verification-critic.test.ts).
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
        expect(task.candidateRef).toBeNull();

        const res = await server.api('POST', `/api/tasks/${created.body.id}/accept`);
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('conflict');
        // Reject and Close still apply without a head.
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

      // Attempt 3 is the fresh budget: it runs, the critic now passes, it merges.
      const done = await waitFor(async () => {
        const { body } = await server.api('GET', `/api/tasks/${taskId}`);
        return body.state === 'done' ? body : undefined;
      });
      expect(done.state).toBe('done');
      const attempts = await ticketAttempts(taskId);
      expect(attempts.map((a) => ({ number: a.number, state: a.state }))).toEqual([
        { number: 1, state: 'failed' },
        { number: 2, state: 'escalated' },
        { number: 3, state: 'passed' },
      ]);
      expect(attempts[1]!.feedback).toBe('The timeout is intentional; see the linked ticket.');

      // The same ticket, a fresh Attempt for the resumed loop — not a detached
      // re-attempt task. Attempt is the single execution ledger now (ADR-0001
      // #388 S-G): one row per turn, so all three Attempts list here (not just
      // the pre-fold "one Run row per resume cycle"). The next Attempt reuses
      // the Task's existing worktree and branch (ADR-0046): it resumes the
      // prior candidate in the same working copy rather than cutting a fresh
      // branch from the base.
      const runs = (await server.api('GET', `/api/tasks/${taskId}/attempts`)).body.attempts;
      expect(runs).toHaveLength(3);
      expect(runs[2].number).toBe(3);
      expect(runs[2].prompt).toContain('The timeout is intentional');
      expect(branch).toBe(`harmonic/task-${taskId}`); // per-Task, no -run-<attempt> suffix
      expect(runs[2].branch).toBe(branch); // same working copy across Attempts
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
