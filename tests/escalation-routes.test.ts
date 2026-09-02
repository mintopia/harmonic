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
      expect(attempts.map((a) => ({ number: a.number, state: a.state }))).toEqual([
        { number: 1, state: 'failed' },
        { number: 2, state: 'escalated' },
        { number: 3, state: 'passed' },
      ]);
      expect(attempts[1]!.feedback).toBe('The timeout is intentional; see the linked ticket.');

      const runs = (await server.api('GET', `/api/tasks/${taskId}/attempts`)).body.attempts;
      expect(runs).toHaveLength(3);
      expect(runs[2].number).toBe(3);
      expect(runs[2].prompt).toContain('The timeout is intentional');
      expect(branch).toBe(`harmonic/task-${taskId}`);
      expect(runs[2].branch).toBe(branch);
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
