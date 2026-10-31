import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type VerificationCommand, verificationCommandSchema } from '../src/config.js';
import { startServer, stubHarness, type TestServer, waitFor } from './helpers.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const localCommands = (...commands: VerificationCommand[]) =>
  commands.map((command) => ({ kind: 'local' as const, enabled: true, command }));

describe('verification-attempts-route', () => {
  describe('GET /api/attempts/:id/verification-attempts (issue #169)', () => {
    let server: TestServer;
    const ctx = () => server.app.ctx;

    beforeEach(async () => {
      server = await startServer(stubHarness());
    });
    afterEach(async () => {
      await server.close();
    });

    it("lists a run's verification attempts in seq order", async () => {
      const created = await server.api('POST', '/api/tasks', { prompt: 'verification target' });
      const task = await ctx().tasks.get(created.body.id);
      const run = await ctx().attempts.create(task.id);
      const attempt = run;

      await ctx().verificationAttempts.append(attempt.id, {
        mechanism: 'command',
        inputOid: 'oid1',
        verdict: 'pass',
        summary: 'ok',
        output: '',
      });
      await ctx().verificationAttempts.append(attempt.id, {
        mechanism: 'critic',
        inputOid: 'oid2',
        verdict: 'fail',
        summary: 'nope',
        output: 'details',
      });

      const res = await server.api('GET', `/api/attempts/${run.id}/verification-attempts`);
      expect(res.status).toBe(200);
      expect(res.body.verificationAttempts).toHaveLength(2);
      expect(res.body.verificationAttempts[0]).toMatchObject({
        attemptId: attempt.id,
        seq: 1,
        mechanism: 'command',
        inputOid: 'oid1',
        verdict: 'pass',
        summary: 'ok',
        output: '',
      });
      expect(res.body.verificationAttempts[1]).toMatchObject({
        attemptId: attempt.id,
        seq: 2,
        mechanism: 'critic',
        inputOid: 'oid2',
        verdict: 'fail',
        summary: 'nope',
        output: 'details',
      });
      expect(res.body.verifierStatuses).toEqual(expect.arrayContaining([
        { mechanism: 'command', state: 'passed', reason: null },
        { mechanism: 'critic', state: 'failed', reason: null },
      ]));
    });

    it('reports a mechanism with no recorded attempt as disabled, since Tickets configure no verifiers', async () => {
      const created = await server.api('POST', '/api/tasks', { prompt: 'verification status target' });
      const task = await server.app.ctx.tasks.get(created.body.id);
      const run = await server.app.ctx.attempts.create(task.id);
      await server.app.ctx.verificationAttempts.append(run.id, {
        mechanism: 'critic',
        inputOid: 'oid1',
        verdict: 'pass',
        summary: 'looks good',
        output: '',
      });

      const res = await server.api('GET', `/api/attempts/${run.id}/verification-attempts`);

      expect(res.status).toBe(200);
      expect(res.body.verifierStatuses).toEqual([
        { mechanism: 'command', state: 'disabled', reason: 'No command verifier is configured.' },
        { mechanism: 'critic', state: 'passed', reason: null },
      ]);
    });

    it('404s for an unknown run', async () => {
      const res = await server.api('GET', '/api/attempts/999999/verification-attempts');
      expect(res.status).toBe(404);
    });
  });
});

describe('verification-command', () => {
  const git = (dir: string, ...args: string[]) =>
    execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

  function makeRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'harmonic-cmdverify-e2e-'));
    execFileSync('git', ['init', '-b', 'main', dir], { encoding: 'utf8' });
    git(dir, 'config', 'user.name', 'Test');
    git(dir, 'config', 'user.email', 'test@example.com');
    writeFileSync(join(dir, 'README.md'), '# repo\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-m', 'init');
    return dir;
  }

  const exitCommand = (code: number): VerificationCommand =>
    verificationCommandSchema.parse({
      id: `cmd-exit-${code}`,
      command: process.execPath,
      args: ['-e', `process.exit(${code})`],
      timeoutSeconds: 30,
    });

  describe('command verifier end-to-end (issue #135)', () => {
    let server: TestServer;
    let repoDir: string;
    let workspaceId: number;

    beforeAll(async () => {
      repoDir = makeRepo();
      server = await startServer(stubHarness());
      const ws = (await server.app.ctx.workspaces.list())[0]!;
      workspaceId = ws.id;
      await server.app.ctx.workspaces.update(workspaceId, { workingDir: repoDir });
      await server.app.ctx.settingsStore.updateGlobal({ maxAttempts: 2 });
    });
    afterAll(async () => {
      await server.close();
      rmSync(repoDir, { recursive: true, force: true });
    });

    let implSeq = 0;
    async function createAndRun(
      scenario: Record<string, unknown> = { writeFiles: { [`impl-${++implSeq}.txt`]: 'implementation\n' } },
    ): Promise<{ taskId: number; attemptId: number }> {
      const created = await server.api('POST', '/api/tasks', {
        prompt: JSON.stringify(scenario),
      });
      expect(created.status).toBe(201);
      const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
      expect(started.status).toBe(201);
      return { taskId: created.body.id, attemptId: started.body.id };
    }

    it('a direct Run works in place: its verified commit is the base branch tip, with no private ref and no run branch', async () => {
      await server.legacy.setWorkspace(workspaceId, { taskPreMergeCommands: localCommands(exitCommand(0)) });
      await server.app.ctx.workspaces.update(workspaceId, {
        isolationMode: 'direct',
      });
      const baseBefore = git(repoDir, 'rev-parse', 'main');
      const { taskId } = await createAndRun();

      const task = await waitFor(async () => {
        const { body } = await server.api('GET', `/api/tasks/${taskId}`);
        return body.state === 'done' ? body : undefined;
      });
      expect(task.state).toBe('done');

      const run = (await server.api('GET', `/api/tasks/${taskId}/attempts/current`)).body;
      expect(run.verifiedHeadOid).toMatch(/^[0-9a-f]{40}$/);
      expect(git(repoDir, 'rev-parse', 'main')).toBe(run.verifiedHeadOid);
      expect(run.verifiedHeadOid).not.toBe(baseBefore);
      expect(git(repoDir, 'for-each-ref', 'refs/harmonic/')).toBe('');
      expect(run.branch).toBeNull();
      expect(run.verifiedRef).toBeNull();
    });

    it('a pre-existing dirty tree does not fail a direct Run; its candidate is the agent\'s own commit', async () => {
      await server.legacy.setWorkspace(workspaceId, { taskPreMergeCommands: localCommands(exitCommand(0)) });
      await server.app.ctx.workspaces.update(workspaceId, {
        isolationMode: 'direct',
      });
      writeFileSync(join(repoDir, 'operator-scratch.txt'), 'not the agent\n');

      const { taskId } = await createAndRun();
      const task = await waitFor(async () => {
        const { body } = await server.api('GET', `/api/tasks/${taskId}`);
        return body.state === 'done' ? body : undefined;
      });
      expect(task.state).toBe('done');
      const run = (await server.api('GET', `/api/tasks/${taskId}/attempts/current`)).body;
      expect(run.verifiedHeadOid).toMatch(/^[0-9a-f]{40}$/);

      rmSync(join(repoDir, 'operator-scratch.txt'), { force: true });
    });

    it('a worktree left dirty at implementation end is not committed while verification blocks', async () => {
      await server.legacy.setWorkspace(workspaceId, { taskPreMergeCommands: localCommands(exitCommand(1)) });
      await server.app.ctx.workspaces.update(workspaceId, {
        isolationMode: 'worktree',
      });
      const { taskId } = await createAndRun({ writeFiles: { 'blocked-dirty.txt': 'left uncommitted\n' }, commit: false });

      const task = await waitFor(async () => {
        const { body } = await server.api('GET', `/api/tasks/${taskId}`);
        return body.state === 'escalated' ? body : undefined;
      });
      expect(task.state).toBe('escalated');

      const branch = `harmonic/task-${taskId}`;
      const worktreePath = join(server.dataDir, 'worktrees', `task-${taskId}`);
      expect(git(repoDir, 'rev-parse', branch)).toBe(git(repoDir, 'rev-parse', 'main'));
      expect(git(worktreePath, 'status', '--porcelain')).not.toBe('');
      expect(readFileSync(join(worktreePath, 'blocked-dirty.txt'), 'utf8')).toBe('left uncommitted\n');
    });

  });

  describe('native merging (issue #138, ADR-0021)', () => {
    let server: TestServer;
    let repoDir: string;
    let workspaceId: number;

    beforeAll(async () => {
      repoDir = makeRepo();
      server = await startServer(stubHarness());
      const ws = (await server.app.ctx.workspaces.list())[0]!;
      workspaceId = ws.id;
      await server.app.ctx.workspaces.update(workspaceId, { workingDir: repoDir });
    });
    afterAll(async () => {
      await server.close();
      rmSync(repoDir, { recursive: true, force: true });
    });

    let implSeq = 0;
    async function createAndRun(): Promise<{ taskId: number; attemptId: number }> {
      const created = await server.api('POST', '/api/tasks', {
        prompt: JSON.stringify({ writeFiles: { [`auto-accept-impl-${++implSeq}.txt`]: 'implementation\n' } }),
      });
      expect(created.status).toBe(201);
      const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
      expect(started.status).toBe(201);
      return { taskId: created.body.id, attemptId: started.body.id };
    }

    it('a passing verification merges directly — there is no review gate to park at', async () => {
      await server.legacy.setWorkspace(workspaceId, { taskPreMergeCommands: localCommands(exitCommand(0)) });
      const { taskId } = await createAndRun();

      const task = await waitFor(async () => {
        const { body } = await server.api('GET', `/api/tasks/${taskId}`);
        return body.state === 'done' ? body : undefined;
      });
      expect(task.state).toBe('done');

      const run = (await server.api('GET', `/api/tasks/${taskId}/attempts/current`)).body;
      expect(run.state).toBe('completed');
    });

    it('a worktree run merges the merge into the base branch (no human gate)', async () => {
      await server.legacy.setWorkspace(workspaceId, { taskPreMergeCommands: localCommands(exitCommand(0)) });
      const baseOidBefore = git(repoDir, 'rev-parse', 'main');

      const created = await server.api('POST', '/api/tasks', {
        prompt: JSON.stringify({ writeFiles: { 'auto-accept-feature.txt': 'made by agent\n' } }),
        workingDir: repoDir,
        isolationMode: 'worktree',
      });
      expect(created.status).toBe(201);
      const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
      expect(started.status).toBe(201);

      const task = await waitFor(async () => {
        const { body } = await server.api('GET', `/api/tasks/${created.body.id}`);
        return body.state === 'done' ? body : undefined;
      });
      expect(task.state).toBe('done');

      const run = (await server.api('GET', `/api/attempts/${started.body.id}`)).body;
      expect(run.state).toBe('completed');

      const baseOidAfter = git(repoDir, 'rev-parse', 'main');
      expect(baseOidAfter).not.toBe(baseOidBefore);
      const mergedFiles = git(repoDir, 'show', `${baseOidAfter}:auto-accept-feature.txt`);
      expect(mergedFiles).toBe('made by agent');
    });
  });
});
