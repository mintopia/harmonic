// Merged worktree suite (core worktree ops, reconciler, inventory). Consolidated so the
// isolated-pool import graph is paid once; each source file's helpers stay block-scoped.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { tasks, workspaces } from '../src/db/schema.js';
import { WorktreeInventory, type WorktreeInventoryRepository } from '../src/domain/worktree-inventory.js';
import { WorktreeReconciler, type WorktreeRepository } from '../src/domain/worktree-reconciler.js';
import { Git } from '../src/execution/git.js';
import { startServer, stubHarness, type TestServer, waitFor } from './helpers.js';
import { eq } from 'drizzle-orm';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ===== worktree.test.ts =====
{
  const git = (dir: string, ...args: string[]) =>
    execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

  function makeRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'harmonic-repo-'));
    execFileSync('git', ['init', '-b', 'main', dir], { encoding: 'utf8' });
    git(dir, 'config', 'user.name', 'Test');
    git(dir, 'config', 'user.email', 'test@example.com');
    writeFileSync(join(dir, 'README.md'), '# repo\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-m', 'init');
    return dir;
  }

  describe('worktree isolation mode', () => {
    let server: TestServer;

    beforeAll(async () => {
      server = await startServer(stubHarness());
    });
    afterAll(async () => {
      await server.close();
    });

    async function runWorktreeTask(
      repo: string,
      files: Record<string, string>,
      opts: { baseBranch?: string } = {},
    ): Promise<{ taskId: number; attemptId: number }> {
      const created = await server.api('POST', '/api/tasks', {
        prompt: JSON.stringify({ writeFiles: files }),
        workingDir: repo,
        isolationMode: 'worktree',
        ...(opts.baseBranch ? { baseBranch: opts.baseBranch } : {}),
      });
      const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
      await waitFor(
        async () => (await server.api('GET', `/api/tasks/${created.body.id}`)).body.state === 'done',
      );
      return { taskId: created.body.id, attemptId: started.body.id };
    }

    it('executes on its own branch in a temp worktree, merges, and the worktree is removed at Session retirement (issue #148)', async () => {
      const repo = makeRepo();
      const { taskId } = await runWorktreeTask(repo, { 'feature.txt': 'made by agent\n' });

      const run = (await server.api('GET', `/api/tasks/${taskId}/attempts/current`)).body;
      expect(run.branch).toBe(`harmonic/task-${taskId}`);
      expect(run.baseBranch).toBe('main');

      expect(git(repo, 'show', `${run.branch}:feature.txt`)).toBe('made by agent');
      expect(git(repo, 'show', 'main:feature.txt')).toBe('made by agent');
      expect(git(repo, 'rev-parse', 'main^2')).toBe(run.verifiedHeadOid);
      expect(git(repo, 'log', '--merges', 'main')).not.toBe('');

      await waitFor(async () => git(repo, 'worktree', 'list').split('\n').length === 1);
      expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1);
    });

    it('a worktree run that leaves its work uncommitted has it captured as the candidate and merged, not orphaned (task 340)', async () => {
      const repo = makeRepo();
      const created = await server.api('POST', '/api/tasks', {
        prompt: JSON.stringify({ writeFiles: { 'feature.txt': 'uncommitted work\n' }, commit: false }),
        workingDir: repo,
        isolationMode: 'worktree',
      });
      const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
      await waitFor(
        async () => (await server.api('GET', `/api/tasks/${created.body.id}`)).body.state === 'done',
      );

      const run = (await server.api('GET', `/api/attempts/${started.body.id}`)).body;
      expect(run.verifiedHeadOid).toBeTruthy();
      expect(git(repo, 'rev-parse', 'main^2')).toBe(run.verifiedHeadOid);
      expect(git(repo, 'show', 'main:feature.txt')).toBe('uncommitted work');
    });

    it('a worktree run whose base branch advances externally mid-turn still verifies and merges normally', async () => {
      const repo = makeRepo();
      const mainBefore = git(repo, 'rev-parse', 'main');

      const created = await server.api('POST', '/api/tasks', {
        prompt: JSON.stringify({
          writeFiles: { 'feature.txt': 'legit worktree work\n' },
          gitExec: [['-C', repo, 'commit', '--allow-empty', '-m', 'base advanced externally']],
        }),
        workingDir: repo,
        isolationMode: 'worktree',
      });
      await server.api('POST', `/api/tasks/${created.body.id}/run`);

      const task = await waitFor(async () => {
        const t = (await server.api('GET', `/api/tasks/${created.body.id}`)).body;
        return t.state === 'done' || t.state === 'escalated' ? t : undefined;
      });

      expect(task.state).toBe('done');
      expect(git(repo, 'show', 'main:feature.txt')).toBe('legit worktree work');
      expect(git(repo, 'log', 'main', '--format=%s').split('\n')).toContain('base advanced externally');
      expect(git(repo, 'rev-parse', 'main')).not.toBe(mainBefore);
    });

    it('merging merges the run branch into the base branch and refreshes its checkout', async () => {
      const repo = makeRepo();
      const { taskId } = await runWorktreeTask(repo, { 'feature.txt': 'merged\n' });

      expect((await server.api('GET', `/api/tasks/${taskId}`)).body.state).toBe('done');
      expect(readFileSync(join(repo, 'feature.txt'), 'utf8')).toBe('merged\n');
      expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    });

    it('a Task with an explicit baseBranch (issue #157) forks from it, not the current branch, and merges back onto it', async () => {
      const repo = makeRepo();
      git(repo, 'branch', 'feature-base');
      git(repo, 'checkout', 'feature-base');
      writeFileSync(join(repo, 'base-marker.txt'), 'from feature-base\n');
      git(repo, 'add', '-A');
      git(repo, 'commit', '-m', 'feature-base marker');
      git(repo, 'checkout', 'main');

      const { taskId } = await runWorktreeTask(
        repo,
        { 'feature.txt': 'made on feature-base\n' },
        { baseBranch: 'feature-base' },
      );

      const run = (await server.api('GET', `/api/tasks/${taskId}/attempts/current`)).body;
      expect(run.branch).toBe(`harmonic/task-${taskId}`);
      expect(run.baseBranch).toBe('feature-base');
      expect(git(repo, 'show', `${run.branch}:base-marker.txt`)).toBe('from feature-base');

      expect((await server.api('GET', `/api/tasks/${taskId}`)).body.state).toBe('done');
      expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
      expect(git(repo, 'show', 'feature-base:feature.txt')).toBe('made on feature-base');
      expect(existsSync(join(repo, 'feature.txt'))).toBe(false);
      expect(git(repo, 'rev-parse', 'feature-base^2')).toBe(run.verifiedHeadOid);
      expect(git(repo, 'log', '--merges', 'feature-base')).not.toBe('');
      expect(() => git(repo, 'show', 'main:feature.txt')).toThrow();
    });

    it('two Runs forking the same main and touching the same file: the first merges, the conflicting second never merges a tree nobody verified', async () => {
      const repo = makeRepo();
      const startBoth = async () => {
        const created = await Promise.all(
          [{ 'conflict.txt': 'version A\n' }, { 'conflict.txt': 'version B\n' }].map((files) =>
            server.api('POST', '/api/tasks', { prompt: JSON.stringify({ writeFiles: files }), workingDir: repo, isolationMode: 'worktree' }),
          ),
        );
        const ids = created.map((c) => c.body.id as number);
        for (const id of ids) expect((await server.api('POST', `/api/tasks/${id}/run`)).status).toBe(201);
        return ids;
      };
      const [a, b] = await startBoth();
      const settled = async (id: number) =>
        waitFor(async () => {
          const t = (await server.api('GET', `/api/tasks/${id}`)).body;
          return t.state === 'done' || t.state === 'escalated' ? t : undefined;
        });
      const [ta, tb] = [await settled(a!), await settled(b!)];

      const states = [ta.state, tb.state].sort();
      expect(states).toEqual(['done', 'escalated']);
      const escalated = ta.state === 'escalated' ? ta : tb;
      expect(escalated.escalationReason).toMatch(
        /hit conflicts that \d+ automated resolve turns? could not settle; a human needs to resolve them/,
      );
      expect(git(repo, 'status', '--porcelain')).toBe('');
      expect(git(repo, 'log', '--merges', 'main')).not.toBe('');
      expect(['version A', 'version B']).toContain(git(repo, 'show', 'main:conflict.txt'));
      expect(git(repo, 'rev-list', '--count', 'main')).toBe('3');
    });

    it('Close on an escalated worktree ticket removes its branch and leaves the base branch unchanged', async () => {
      const repo = makeRepo();
      const mainBefore = git(repo, 'rev-parse', 'main');
      const created = await server.api('POST', '/api/tasks', {
        prompt: JSON.stringify({ writeFiles: { 'feature.txt': 'unwanted\n' }, exit: 'crash-before-response' }),
        workingDir: repo,
        isolationMode: 'worktree',
      });
      const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
      await waitFor(async () => (await server.api('GET', `/api/tasks/${created.body.id}`)).body.state === 'escalated');
      const run = (await server.api('GET', `/api/attempts/${started.body.id}`)).body;
      expect(git(repo, 'branch', '--list', run.branch)).toContain(run.branch);

      const closed = await server.api('POST', `/api/tasks/${created.body.id}/close`);
      expect(closed.status).toBe(200);
      expect(closed.body.state).toBe('cancelled');

      await waitFor(async () => (git(repo, 'branch', '--list', run.branch) === '' ? true : undefined));
      expect(git(repo, 'rev-parse', 'main')).toBe(mainBefore);
      expect(existsSync(join(repo, 'feature.txt'))).toBe(false);
    });

    it('serves diffstat and branch info for the review inbox', async () => {
      const repo = makeRepo();
      const { attemptId } = await runWorktreeTask(repo, { 'feature.txt': 'diff me\n' });

      const diff = await server.api('GET', `/api/attempts/${attemptId}/diff`);
      expect(diff.status).toBe(200);
      expect(diff.body.branch).toBe(`harmonic/task-${(await server.api("GET", `/api/attempts/${attemptId}`)).body.taskId}`);
      expect(diff.body.stat).toContain('feature.txt');
    });

    it('serves a completed Run\'s file diff after its temporary branch is removed (issue #323)', async () => {
      const repo = makeRepo();
      const { taskId } = await runWorktreeTask(repo, { 'feature.txt': 'diff me\n' });
      const run = (await server.api('GET', `/api/tasks/${taskId}/attempts/current`)).body;

      git(repo, 'branch', '-D', run.branch);

      const diff = await server.api('GET', `/api/attempts/${run.id}/diff/files`);
      expect(diff.status).toBe(200);
      expect(diff.body.files).toHaveLength(1);
      expect(diff.body.files[0]).toMatchObject({ path: 'feature.txt', status: 'A' });
      expect(diff.body.files[0].lines).toContainEqual(expect.objectContaining({ kind: 'add', text: 'diff me' }));
    });

    it('serialises concurrent worktree Runs on one base repo without corrupting it (issue #121)', async () => {
      const repo = makeRepo();
      const results = await Promise.all([
        runWorktreeTask(repo, { 'a.txt': 'A\n' }),
        runWorktreeTask(repo, { 'b.txt': 'B\n' }),
        runWorktreeTask(repo, { 'c.txt': 'C\n' }),
      ]);

      for (const { taskId } of results) {
        const run = (await server.api('GET', `/api/tasks/${taskId}/attempts/current`)).body;
        expect(run.branch).toBe(`harmonic/task-${taskId}`);
        expect(git(repo, 'branch', '--list', run.branch)).toContain(run.branch);
      }
      expect(git(repo, 'show', `${(await server.api('GET', `/api/attempts/${results[0].attemptId}`)).body.branch}:a.txt`)).toBe('A');

      for (const file of ['a.txt', 'b.txt', 'c.txt']) expect(git(repo, 'ls-tree', '--name-only', 'main', file)).toBe(file);
      await waitFor(async () => (git(repo, 'worktree', 'list').split('\n').length === 1 ? true : undefined));
      expect(git(repo, 'status', '--porcelain')).toBe('');
      expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    });

    it('two worktree Runs on the same base repo both proceed — distinct {path,branch} keys admit both (issue #119)', async () => {
      const repo = makeRepo();
      const [a, b] = await Promise.all([
        runWorktreeTask(repo, { 'a.txt': 'A\n' }),
        runWorktreeTask(repo, { 'b.txt': 'B\n' }),
      ]);

      const runA = (await server.api('GET', `/api/attempts/${a.attemptId}`)).body;
      const runB = (await server.api('GET', `/api/attempts/${b.attemptId}`)).body;
      expect(runA.state).toBe('completed');
      expect(runB.state).toBe('completed');
      expect(runA.branch).not.toBe(runB.branch);

      const taskA = (await server.api('GET', `/api/tasks/${a.taskId}`)).body;
      const taskB = (await server.api('GET', `/api/tasks/${b.taskId}`)).body;
      expect(taskA.state).toBe('done');
      expect(taskB.state).toBe('done');
    });

    it('escalates instead of forking off "HEAD" when the base repo is detached and no base branch is set (issue #198)', async () => {
      const repo = makeRepo();
      git(repo, 'checkout', '--detach', 'HEAD');
      expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD');
      const worktreesBefore = git(repo, 'worktree', 'list').split('\n').length;

      const created = await server.api('POST', '/api/tasks', {
        prompt: JSON.stringify({ writeFiles: { 'feature.txt': 'nope\n' } }),
        workingDir: repo,
        isolationMode: 'worktree',
      });
      const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);

      await waitFor(async () => (await server.api('GET', `/api/attempts/${started.body.id}`)).body.state === 'failed');
      const run = (await server.api('GET', `/api/attempts/${started.body.id}`)).body;
      expect(run.reason ?? '').toMatch(/^escalated to human: /);
      expect((run.reason ?? '').toLowerCase()).toContain('detached');
      expect(run.baseBranch).not.toBe('HEAD');
      expect(run.baseBranch ?? null).toBeNull();
      expect(run.branch ?? null).toBeNull();

      expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD');
      expect(git(repo, 'status', '--porcelain')).toBe('');
      expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(worktreesBefore);
      expect(git(repo, 'branch', '--list', `harmonic/task-${created.body.id}`)).toBe('');

      const task = (await server.api('GET', `/api/tasks/${created.body.id}`)).body;
      expect(task.state).toBe('escalated');
    });

    it('escalates the run when the working directory is not a git repo (permanent git-prep failure, issue #199)', async () => {
      const notARepo = mkdtempSync(join(tmpdir(), 'harmonic-plain-'));
      const created = await server.api('POST', '/api/tasks', {
        prompt: 'anything',
        workingDir: notARepo,
        isolationMode: 'worktree',
      });
      await server.api('POST', `/api/tasks/${created.body.id}/run`);
      await waitFor(async () => {
        const t = (await server.api('GET', `/api/tasks/${created.body.id}`)).body;
        return t.state === 'escalated' ? t : undefined;
      });
      const runs = (await server.api('GET', `/api/tasks/${created.body.id}/attempts`)).body.attempts;
      expect(runs.length).toBe(1);
      expect(runs[0].state).toBe('failed');
      expect(runs[0].reason).toBeTruthy();
    });

    it('re-queues (does NOT escalate) a worktree Run whose Epic integration base is transiently missing (issue #159)', async () => {
      const repo = makeRepo();
      const worktreesBefore = git(repo, 'worktree', 'list').split('\n').length;
      const created = await server.api('POST', '/api/tasks', {
        prompt: 'anything',
        workingDir: repo,
        isolationMode: 'worktree',
        baseBranch: 'epic/999',
      });
      await server.api('POST', `/api/tasks/${created.body.id}/run`);

      const task = await waitFor(async () => {
        const t = (await server.api('GET', `/api/tasks/${created.body.id}`)).body;
        return t.state === 'ready' ? t : undefined;
      });
      expect(task.state).not.toBe('escalated');

      const runs = (await server.api('GET', `/api/tasks/${created.body.id}/attempts`)).body.attempts;
      expect(runs.length).toBe(1);
      expect(runs[0].state).toBe('failed');
      expect(runs[0].reason).toContain('epic/999');

      expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(worktreesBefore);
      expect(git(repo, 'branch', '--list', `harmonic/task-${created.body.id}`)).toBe('');
    });

    it('an Epic member (mapRef) never forks off the current branch: an unresolved epic base re-queues instead (issue #334)', async () => {
      const repo = makeRepo();
      git(repo, 'branch', 'epic/424');
      const worktreesBefore = git(repo, 'worktree', 'list').split('\n').length;

      const created = await server.api('POST', '/api/tasks', {
        prompt: JSON.stringify({ writeFiles: { 'f.txt': 'nope\n' } }),
        workingDir: repo,
        isolationMode: 'worktree',
      });
      await server.app.ctx.asyncDb.write((d) =>
        d.update(tasks).set({ mapRef: 424 }).where(eq(tasks.id, created.body.id)).run(),
      );
      await server.api('POST', `/api/tasks/${created.body.id}/run`);

      const task = await waitFor(async () => {
        const t = (await server.api('GET', `/api/tasks/${created.body.id}`)).body;
        return t.state === 'ready' ? t : undefined;
      });
      expect(task.state).toBe('ready');
      const runs = (await server.api('GET', `/api/tasks/${created.body.id}/attempts`)).body.attempts;
      expect(runs.length).toBe(1);
      expect(runs[0].state).toBe('failed');
      expect(runs[0].reason).toContain('epic/424');
      expect(runs[0].baseBranch ?? null).toBeNull();
      expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(worktreesBefore);
      expect(git(repo, 'branch', '--list', `harmonic/task-${created.body.id}`)).toBe('');
    });
  });

  describe('worktree isolation — afk no-candidate fail-closed', () => {
    let server: TestServer;
    let ref = 4630;

    beforeAll(async () => {
      server = await startServer({ ...stubHarness(), maxAttempts: 1, drive: { continueAttempts: 0 } });
    });
    afterAll(async () => {
      await server.close();
    });

    it('an afk worktree run that produced no candidate of its own fails closed (Escalates) rather than merging', async () => {
      const repo = makeRepo();
      const mainBefore = git(repo, 'rev-parse', 'main');

      await server.app.ctx.asyncDb.write((d) => d.update(workspaces).set({ workingDir: repo }).run());
      await server.app.ctx.settingsStore.updateGlobal({ drive: { prompt: JSON.stringify({ writeFiles: {}, stopReason: 'end_turn' }) } });

      const task = await server.app.ctx.tasks.upsertMirrored({
        trackerRef: ref++,
        prompt: 'go',
        workflow: 'implement',
        wayfinderType: null,
        mapRef: null,
        closed: false,
      });
      await server.app.ctx.asyncDb.write((d) => d.update(tasks).set({ isolationMode: 'worktree' }).where(eq(tasks.id, task.id)).run());
      await server.app.ctx.tasks.setState(task.id, 'working');
      await server.app.ctx.runner.launchClaimed(task.id);

      const settled = await waitFor(async () => {
        const t = (await server.api('GET', `/api/tasks/${task.id}`)).body;
        return t.state === 'escalated' ? t : undefined;
      });
      expect(settled.state).toBe('escalated');
      expect(settled.escalationReason).toBeTruthy();
      expect(git(repo, 'rev-parse', 'main')).toBe(mainBefore);
    });
  });
}

// ===== worktree-reconciler.test.ts =====
{
  const tempDirs: string[] = [];
  const tempDir = (prefix: string) => {
    // realpath so paths match git's canonical worktree paths (macOS /var → /private/var symlink).
    const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    tempDirs.push(dir);
    return dir;
  };
  const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function fakeGit(overrides: Partial<WorktreeRepository>): WorktreeRepository {
    const unexpected = (name: string) => async () => {
      throw new Error(`unexpected call to ${name}`);
    };
    return {
      listWorktrees: overrides.listWorktrees ?? unexpected('listWorktrees'),
      isDirty: overrides.isDirty ?? unexpected('isDirty'),
      isValidWorktree: overrides.isValidWorktree ?? unexpected('isValidWorktree'),
      addWorktreeCheckout: overrides.addWorktreeCheckout ?? unexpected('addWorktreeCheckout'),
      branchExists: overrides.branchExists ?? unexpected('branchExists'),
      removeWorktreeAndDeleteBranch: overrides.removeWorktreeAndDeleteBranch ?? unexpected('removeWorktreeAndDeleteBranch'),
    };
  }

  describe('worktree reconciler (issue #386, ADR-0010)', () => {
    it('leaves a dirty worktree of a terminal task on disk', async () => {
      const managedRoot = '/harmonic/worktrees';
      const path = join(managedRoot, 'task-5');
      const removeWorktreeAndDeleteBranch = vi.fn();

      const reconciler = new WorktreeReconciler(
        async () => [],
        async () => [{ id: 1, workingDir: '/repo' }],
        fakeGit({
          listWorktrees: async () => [{ path, branch: 'harmonic/task-5' }],
          isValidWorktree: async () => true,
          isDirty: async () => true,
          removeWorktreeAndDeleteBranch,
        }),
        managedRoot,
      );

      await expect(reconciler.reconcile()).resolves.toEqual({ removed: 0, recreated: 0, flagged: 1 });
      expect(removeWorktreeAndDeleteBranch).not.toHaveBeenCalled();
    });

    it('leaves an unreadable worktree of a terminal task on disk', async () => {
      const managedRoot = '/harmonic/worktrees';
      const path = join(managedRoot, 'task-9');
      const removeWorktreeAndDeleteBranch = vi.fn();

      const reconciler = new WorktreeReconciler(
        async () => [],
        async () => [{ id: 1, workingDir: '/repo' }],
        fakeGit({
          listWorktrees: async () => [{ path, branch: 'harmonic/task-9' }],
          isValidWorktree: async () => false,
          removeWorktreeAndDeleteBranch,
        }),
        managedRoot,
      );

      await expect(reconciler.reconcile()).resolves.toEqual({ removed: 0, recreated: 0, flagged: 1 });
      expect(removeWorktreeAndDeleteBranch).not.toHaveBeenCalled();
    });

    it('removes a clean worktree of a terminal task and reaps its index, rechecking under the lock', async () => {
      const managedRoot = '/harmonic/worktrees';
      const path = join(managedRoot, 'task-2');
      const reaped: string[] = [];
      let beforeRemoveResult: boolean | undefined;

      const reconciler = new WorktreeReconciler(
        async () => [],
        async () => [{ id: 1, workingDir: '/repo' }],
        fakeGit({
          listWorktrees: async () => [{ path, branch: 'harmonic/task-2' }],
          isValidWorktree: async () => true,
          isDirty: async () => false,
          removeWorktreeAndDeleteBranch: async (repoDir, worktreePath, branch, beforeRemove) => {
            beforeRemoveResult = await beforeRemove();
            expect(repoDir).toBe('/repo');
            expect(worktreePath).toBe(path);
            expect(branch).toBe('harmonic/task-2');
            return beforeRemoveResult;
          },
        }),
        managedRoot,
        async (absPath) => {
          reaped.push(absPath);
        },
      );

      await expect(reconciler.reconcile()).resolves.toEqual({ removed: 1, recreated: 0, flagged: 0 });
      expect(beforeRemoveResult).toBe(true);
      expect(reaped).toEqual([path]);
    });

    it('recreates a live task worktree via addWorktreeCheckout when its branch still exists', async () => {
      const managedRoot = '/harmonic/worktrees';
      const path = join(managedRoot, 'task-7');
      const addWorktreeCheckout = vi.fn(async () => {});

      const reconciler = new WorktreeReconciler(
        async () => [{ id: 7, workspaceId: 1 }],
        async () => [{ id: 1, workingDir: '/repo' }],
        fakeGit({
          listWorktrees: async () => [],
          isValidWorktree: async () => false,
          branchExists: async () => true,
          addWorktreeCheckout,
        }),
        managedRoot,
      );

      await expect(reconciler.reconcile()).resolves.toEqual({ removed: 0, recreated: 1, flagged: 0 });
      expect(addWorktreeCheckout).toHaveBeenCalledWith('/repo', path, 'harmonic/task-7');
    });

    it('leaves a live task worktree that is present but unreadable, never discarding it', async () => {
      const managedRoot = tempDir('harmonic-reconcile-unreadable-');
      const path = join(managedRoot, 'task-7');
      mkdirSync(path);
      const addWorktreeCheckout = vi.fn(async () => {});

      const reconciler = new WorktreeReconciler(
        async () => [{ id: 7, workspaceId: 1 }],
        async () => [{ id: 1, workingDir: '/repo' }],
        fakeGit({
          listWorktrees: async () => [],
          isValidWorktree: async () => false,
          addWorktreeCheckout,
        }),
        managedRoot,
      );

      await expect(reconciler.reconcile()).resolves.toEqual({ removed: 0, recreated: 0, flagged: 1 });
      expect(addWorktreeCheckout).not.toHaveBeenCalled();
      expect(existsSync(path)).toBe(true);
    });

    it('does NOT recreate a live task worktree when its branch is gone', async () => {
      const managedRoot = '/harmonic/worktrees';
      const addWorktreeCheckout = vi.fn(async () => {});

      const reconciler = new WorktreeReconciler(
        async () => [{ id: 7, workspaceId: 1 }],
        async () => [{ id: 1, workingDir: '/repo' }],
        fakeGit({
          listWorktrees: async () => [],
          isValidWorktree: async () => false,
          branchExists: async () => false,
          addWorktreeCheckout,
        }),
        managedRoot,
      );

      await expect(reconciler.reconcile()).resolves.toEqual({ removed: 0, recreated: 0, flagged: 0 });
      expect(addWorktreeCheckout).not.toHaveBeenCalled();
    });

    it('leaves a managed path that does not parse as task-<id> on disk', async () => {
      const managedRoot = '/harmonic/worktrees';
      const path = join(managedRoot, 'scratch');
      const removeWorktreeAndDeleteBranch = vi.fn();

      const reconciler = new WorktreeReconciler(
        async () => [],
        async () => [{ id: 1, workingDir: '/repo' }],
        fakeGit({
          listWorktrees: async () => [{ path, branch: 'operator/wip' }],
          removeWorktreeAndDeleteBranch,
        }),
        managedRoot,
      );

      await expect(reconciler.reconcile()).resolves.toEqual({ removed: 0, recreated: 0, flagged: 1 });
      expect(removeWorktreeAndDeleteBranch).not.toHaveBeenCalled();
    });

    it('(real git) removes a clean orphaned task-<id> worktree and its dangling branch', async () => {
      const repo = tempDir('harmonic-reconcile-repo-');
      execFileSync('git', ['init', '-b', 'main', repo], { encoding: 'utf8' });
      git(repo, 'config', 'user.name', 'Test');
      git(repo, 'config', 'user.email', 'test@example.com');
      writeFileSync(join(repo, 'README.md'), '# repo\n');
      git(repo, 'add', 'README.md');
      git(repo, 'commit', '-m', 'init');
      const managedRoot = tempDir('harmonic-reconcile-worktrees-');
      const orphan = join(managedRoot, 'task-1');
      git(repo, 'worktree', 'add', '-b', 'harmonic/task-1', orphan);

      const reconciler = new WorktreeReconciler(
        async () => [],
        async () => [{ id: 1, workingDir: repo }],
        Git,
        managedRoot,
      );

      await expect(reconciler.reconcile()).resolves.toEqual({ removed: 1, recreated: 0, flagged: 0 });
      expect(existsSync(orphan)).toBe(false);
      expect(git(repo, 'branch', '--list', 'harmonic/task-1')).toBe('');
    });

    it('(real git) leaves a dirty task-<id> worktree of a terminal task on disk and surfaces it', async () => {
      const repo = tempDir('harmonic-reconcile-repo-');
      execFileSync('git', ['init', '-b', 'main', repo], { encoding: 'utf8' });
      git(repo, 'config', 'user.name', 'Test');
      git(repo, 'config', 'user.email', 'test@example.com');
      writeFileSync(join(repo, 'README.md'), '# repo\n');
      git(repo, 'add', 'README.md');
      git(repo, 'commit', '-m', 'init');
      const managedRoot = tempDir('harmonic-reconcile-worktrees-');
      const dirty = join(managedRoot, 'task-2');
      git(repo, 'worktree', 'add', '-b', 'harmonic/task-2', dirty);
      writeFileSync(join(dirty, 'WIP.md'), 'not yet committed\n');

      const reconciler = new WorktreeReconciler(
        async () => [],
        async () => [{ id: 1, workingDir: repo }],
        Git,
        managedRoot,
      );

      await expect(reconciler.reconcile()).resolves.toEqual({ removed: 0, recreated: 0, flagged: 1 });
      expect(existsSync(dirty)).toBe(true);
      expect(git(repo, 'branch', '--list', 'harmonic/task-2')).not.toBe('');
    });
  });
}

// ===== worktree-inventory.test.ts =====
{
  function repository(overrides: Partial<WorktreeInventoryRepository>): WorktreeInventoryRepository {
    const unexpected = (name: string) => async () => {
      throw new Error(`unexpected call to ${name}`);
    };
    return {
      listWorktrees: overrides.listWorktrees ?? unexpected('listWorktrees'),
      changeCount: overrides.changeCount ?? unexpected('changeCount'),
      isValidWorktree: overrides.isValidWorktree ?? unexpected('isValidWorktree'),
      pathExists: overrides.pathExists ?? unexpected('pathExists'),
      worktreeSize: overrides.worktreeSize ?? unexpected('worktreeSize'),
    };
  }

  describe('worktree inventory (issue #482)', () => {
    it('derives every inventory state from the filesystem snapshot and mirrored task rows', async () => {
      const inventory = new WorktreeInventory(
        async () => [{ id: 1, workingDir: '/repo' }],
        async () => [
          { id: 1, workspaceId: 1, origin: 'mirrored', state: 'working', trackerTitle: 'Active issue', trackerParent: null },
          { id: 2, workspaceId: 1, origin: 'mirrored', state: 'done', trackerTitle: 'Completed issue', trackerParent: null },
          { id: 3, workspaceId: 1, origin: 'mirrored', state: 'working', trackerTitle: 'Missing issue', trackerParent: null },
          { id: 4, workspaceId: 1, origin: 'mirrored', state: 'ready', trackerTitle: 'Unreadable issue', trackerParent: null },
        ],
        repository({
          listWorktrees: async () => [
            { path: '/trees/task-1', branch: 'harmonic/task-1' },
            { path: '/trees/task-2', branch: 'harmonic/task-2' },
            { path: '/trees/task-4', branch: 'harmonic/task-4' },
            { path: '/trees/task-99', branch: 'harmonic/task-99' },
            { path: '/trees/scratch', branch: 'operator/wip' },
          ],
          isValidWorktree: async (_repoDir, path) => path !== '/trees/task-4',
          pathExists: async () => true,
          changeCount: async (path) => (path === '/trees/task-1' ? 3 : 0),
          worktreeSize: async () => 42,
        }),
        '/trees',
      );

      await expect(inventory.snapshot()).resolves.toEqual([
        { workspaceId: 1, path: '/trees/task-1', branch: 'harmonic/task-1', subject: { kind: 'task', taskId: 1, title: 'Active issue' }, sizeBytes: 42, dirty: true, changeCount: 3, state: 'Dirty' },
        { workspaceId: 1, path: '/trees/task-2', branch: 'harmonic/task-2', subject: { kind: 'task', taskId: 2, title: 'Completed issue' }, sizeBytes: 42, dirty: false, changeCount: 0, state: 'Stale' },
        { workspaceId: 1, path: '/trees/task-4', branch: 'harmonic/task-4', subject: { kind: 'task', taskId: 4, title: 'Unreadable issue' }, sizeBytes: null, dirty: null, changeCount: null, state: 'Unreadable' },
        { workspaceId: 1, path: '/trees/task-99', branch: 'harmonic/task-99', subject: null, sizeBytes: 42, dirty: false, changeCount: 0, state: 'Orphan' },
        { workspaceId: 1, path: '/trees/scratch', branch: 'operator/wip', subject: null, sizeBytes: 42, dirty: false, changeCount: 0, state: 'Orphan' },
        { workspaceId: 1, path: '/trees/task-3', branch: 'harmonic/task-3', subject: { kind: 'task', taskId: 3, title: 'Missing issue' }, sizeBytes: null, dirty: null, changeCount: null, state: 'Missing' },
      ]);
    });

    it('never reports the base checkout as an orphan even though git lists it first', async () => {
      const inventory = new WorktreeInventory(
        async () => [{ id: 1, workingDir: '/repo' }],
        async () => [],
        repository({
          listWorktrees: async () => [
            { path: '/repo', branch: 'develop' },
            { path: '/trees/task-7', branch: 'harmonic/task-7' },
          ],
          isValidWorktree: async () => true,
          changeCount: async () => 0,
          worktreeSize: async () => 42,
        }),
        '/trees',
      );

      await expect(inventory.snapshot()).resolves.toEqual([
        { workspaceId: 1, path: '/trees/task-7', branch: 'harmonic/task-7', subject: null, sizeBytes: 42, dirty: false, changeCount: 0, state: 'Orphan' },
      ]);
    });
  });
}
