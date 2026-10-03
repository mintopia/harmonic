import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { baselineConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import { WorkspaceService } from '../src/domain/workspaces.js';
import { AttemptStore } from '../src/domain/attempts.js';
import { AttemptSettleCoordinator } from '../src/domain/attempt-settle.js';
import { CrashRecoveryCoordinator } from '../src/execution/crash-recovery.js';
import { Git } from '../src/execution/git.js';
import { isEphemeralMergeWorktree } from '../src/execution/ephemeral-merge-worktree.js';
import type { TaskRow, AttemptRow } from '../src/db/schema.js';
import type { SettingsStore } from '../src/server/settings-store.js';
import { allWorkspaces, makeSettingsStore, seedWorkspace } from './helpers.js';
import { yieldToEventLoop } from '../src/reliability/yield.js';
import { trackerRef } from '../src/tracker/adapter.js';

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harmonic-crash-recovery-repo-'));
  execFileSync('git', ['init', '-b', 'main', dir], { encoding: 'utf8' });
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(dir, 'README.md'), '# repo\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'init');
  return dir;
}

function commit(dir: string, path: string, content: string, message: string): void {
  writeFileSync(join(dir, path), content);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', message);
}

describe('CrashRecoveryCoordinator (ADR-0001)', () => {
  let dir: string;
  let repo: string;
  let asyncDb: AsyncDbHandle;
  let settingsStore: SettingsStore;
  let tasks: TaskService;
  let attempts: AttemptStore;
  let settle: AttemptSettleCoordinator;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-crash-recovery-'));
    repo = makeRepo();
    asyncDb = await openAsyncDb(dir);
    await seedWorkspace(asyncDb);
    settingsStore = await makeSettingsStore(dir);
    tasks = new TaskService(asyncDb, () => baselineConfig(), allWorkspaces(asyncDb, settingsStore));
    attempts = new AttemptStore(asyncDb);
    settle = new AttemptSettleCoordinator(tasks, attempts);
  });

  afterEach(async () => {
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function seedAlreadyMergedOrphan(): Promise<{ task: TaskRow; run: AttemptRow; baseBranch: string; branch: string }> {
    const baseBranch = 'main';
    const branch = 'run-branch';
    git(repo, 'checkout', '-b', branch);
    commit(repo, 'feature.txt', 'work\n', 'feature work');
    git(repo, 'checkout', baseBranch);
    git(repo, 'merge', '--no-ff', '-m', 'merge run-branch', branch);

    const created = await tasks.create({ prompt: 'merge me', state: 'ready', workingDir: repo, isolationMode: 'worktree' });
    await tasks.setState(created.id, 'working');
    const run = await attempts.update((await attempts.create(created.id)).id, { branch, baseBranch });
    return { task: await tasks.get(created.id), run, baseBranch, branch };
  }

  async function seedUnmergedOrphan(): Promise<{ task: TaskRow; run: AttemptRow }> {
    const baseBranch = 'main';
    const branch = 'never-merged-branch';
    git(repo, 'checkout', '-b', branch);
    commit(repo, 'feature.txt', 'work\n', 'feature work');
    git(repo, 'checkout', baseBranch);

    const created = await tasks.create({ prompt: 'never merged', state: 'ready', workingDir: repo, isolationMode: 'worktree' });
    await tasks.setState(created.id, 'working');
    const run = await attempts.update((await attempts.create(created.id)).id, { branch, baseBranch });
    return { task: await tasks.get(created.id), run };
  }

  it('completes a crashed worktree Run whose branch already landed in its base: re-runs the post-merge check and settles it green, idempotently on a second reconcile', async () => {
    const { task, run, baseBranch } = await seedAlreadyMergedOrphan();
    const baseTip = await Git.revParse(repo, baseBranch);
    const runPostMergeCheck = vi.fn(async (_args: { baseDir: string }) => ({ pass: true, output: '' }));
    const coord = new CrashRecoveryCoordinator(attempts, tasks, settle, { runPostMergeCheck });

    await coord.reconcile();

    expect(runPostMergeCheck).toHaveBeenCalledTimes(1);
    expect(runPostMergeCheck).toHaveBeenCalledWith({ task: expect.objectContaining({ id: task.id }), run: expect.objectContaining({ id: run.id }), mergeOid: baseTip, baseDir: expect.not.stringMatching(new RegExp(`^${repo}$`)) });
    expect(isEphemeralMergeWorktree(runPostMergeCheck.mock.calls[0]![0].baseDir)).toBe(true);
    const settled = await attempts.get(run.id);
    expect(settled.state).toBe('passed');
    expect((await tasks.get(task.id)).state).toBe('done');
    expect(await Git.revParse(repo, baseBranch)).toBe(baseTip);

    await coord.reconcile();
    expect(runPostMergeCheck).toHaveBeenCalledTimes(1);
    expect((await attempts.get(run.id)).state).toBe('passed');
  });

  it('reverts a crashed merge whose post-merge check now fails, and escalates the task — idempotently on a second reconcile', async () => {
    const { task, run, baseBranch } = await seedAlreadyMergedOrphan();
    const preRevertTip = await Git.revParse(repo, baseBranch);
    let checkedIn = '';
    const runPostMergeCheck = vi.fn(async ({ baseDir }: { baseDir: string }) => {
      checkedIn = baseDir;
      expect(existsSync(join(baseDir, 'feature.txt'))).toBe(true);
      return { pass: false, output: 'lint failed: feature.txt' };
    });
    const coord = new CrashRecoveryCoordinator(attempts, tasks, settle, { runPostMergeCheck });

    await coord.reconcile();

    expect(runPostMergeCheck).toHaveBeenCalledTimes(1);
    const settled = await attempts.get(run.id);
    expect(settled.state).toBe('escalated');
    expect((await tasks.get(task.id))).toMatchObject({
      state: 'escalated',
      escalationReason: expect.stringContaining('post-merge check failed after restart'),
    });
    expect((await tasks.get(task.id)).escalationReason).toContain('lint failed: feature.txt');
    const revertedTip = await Git.revParse(repo, baseBranch);
    expect(revertedTip).not.toBe(preRevertTip);
    expect(existsSync(join(repo, 'feature.txt'))).toBe(false);
    expect(isEphemeralMergeWorktree(checkedIn)).toBe(true);
    expect(existsSync(checkedIn)).toBe(false);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(baseBranch);

    await coord.reconcile();
    expect(runPostMergeCheck).toHaveBeenCalledTimes(1);
    expect(await Git.revParse(repo, baseBranch)).toBe(revertedTip);
  });

  it('escalates without touching the base when the red merge cannot be reverted', async () => {
    const { task, run, baseBranch } = await seedAlreadyMergedOrphan();
    const tip = await Git.revParse(repo, baseBranch);
    const runPostMergeCheck = vi.fn(async ({ baseDir }: { baseDir: string }) => {
      writeFileSync(join(baseDir, 'feature.txt'), 'dirtied by the check\n');
      return { pass: false, output: 'lint failed' };
    });
    const coord = new CrashRecoveryCoordinator(attempts, tasks, settle, { runPostMergeCheck });

    await coord.reconcile();

    expect((await attempts.get(run.id)).state).toBe('escalated');
    expect((await tasks.get(task.id)).escalationReason).toContain('could not be reverted');
    expect(await Git.revParse(repo, baseBranch)).toBe(tip);
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it.each(['commit', 'merge'] as const)('does not check or revert a later base %s when recovering an already merged task', async (advance) => {
    const { task, run, baseBranch } = await seedAlreadyMergedOrphan();
    if (advance === 'merge') git(repo, 'checkout', '-b', 'other-branch');
    commit(repo, 'later.txt', 'later work\n', 'later work');
    if (advance === 'merge') {
      git(repo, 'checkout', baseBranch);
      git(repo, 'merge', '--no-ff', '-m', 'merge other-branch', 'other-branch');
    }
    const laterTip = await Git.revParse(repo, baseBranch);
    const runPostMergeCheck = vi.fn(async () => ({ pass: false, output: 'later commit fails' }));
    const coord = new CrashRecoveryCoordinator(attempts, tasks, settle, { runPostMergeCheck });

    await coord.reconcile();

    expect(runPostMergeCheck).not.toHaveBeenCalled();
    expect(await Git.revParse(repo, baseBranch)).toBe(laterTip);
    expect(existsSync(join(repo, 'later.txt'))).toBe(true);
    expect((await attempts.get(run.id)).state).toBe('passed');
    expect((await tasks.get(task.id)).state).toBe('done');
  });

  it('leaves a crashed worktree Run whose branch never landed as an ordinary interrupted orphan, never consulting the post-merge check', async () => {
    const { run } = await seedUnmergedOrphan();
    const runPostMergeCheck = vi.fn(async () => ({ pass: true, output: '' }));
    const coord = new CrashRecoveryCoordinator(attempts, tasks, settle, { runPostMergeCheck });

    await coord.reconcile();

    expect(runPostMergeCheck).not.toHaveBeenCalled();
    const interrupted = await attempts.get(run.id);
    expect(interrupted.state).toBe('failed');
    expect(interrupted.reason).toBe('process-death');
  });

  it('does not mistake a fast-forwarded branch for a published task merge', async () => {
    const { run } = await seedUnmergedOrphan();
    git(repo, 'merge', '--ff-only', run.branch!);
    const runPostMergeCheck = vi.fn(async () => ({ pass: true, output: '' }));
    const coord = new CrashRecoveryCoordinator(attempts, tasks, settle, { runPostMergeCheck });

    await coord.reconcile();

    expect(runPostMergeCheck).not.toHaveBeenCalled();
    expect((await attempts.get(run.id)).state).toBe('failed');
    expect((await attempts.get(run.id)).reason).toBe('process-death');
  });

  it('marks a generic (non-worktree) interrupted Run interrupted, never consulting the post-merge check or git', async () => {
    const created = await tasks.create({ prompt: 'direct mode', state: 'ready', workingDir: repo, isolationMode: 'direct' });
    await tasks.setState(created.id, 'working');
    const run = await attempts.create(created.id);
    const runPostMergeCheck = vi.fn(async () => ({ pass: true, output: '' }));
    const coord = new CrashRecoveryCoordinator(attempts, tasks, settle, { runPostMergeCheck });

    await coord.reconcile();

    expect(runPostMergeCheck).not.toHaveBeenCalled();
    expect(await attempts.get(run.id)).toMatchObject({ state: 'failed', reason: 'process-death' });
  });

  it('settles an interrupted Epic Attempt and notifies the Epic reconciler so its next poll can retry verification', async () => {
    const workspaces = new WorkspaceService(asyncDb, settingsStore);
    const workspace = await workspaces.create({ name: 'Epic recovery', workingDir: repo });
    await tasks.syncEpics(workspace.id, [{ ref: trackerRef(42), kind: 'epic' }]);
    const attempt = await attempts.createForEpic({ workspaceId: workspace.id, epicRef: trackerRef(42) });
    const onEpicAttemptInterrupted = vi.fn();
    const coord = new CrashRecoveryCoordinator(attempts, tasks, settle, {
      runPostMergeCheck: async () => ({ pass: true, output: '' }),
      onEpicAttemptInterrupted,
    });

    await coord.reconcile();

    expect(await attempts.get(attempt.id)).toMatchObject({ state: 'failed', reason: 'process-death' });
    expect(onEpicAttemptInterrupted).toHaveBeenCalledWith(expect.objectContaining({ id: attempt.id, workspaceId: workspace.id, epicRef: '42' }));
  });

  it('leaves a paused Task paused while marking its interrupted Run failed', async () => {
    const created = await tasks.create({ prompt: 'pause me', state: 'ready', workingDir: repo, isolationMode: 'direct' });
    await tasks.setState(created.id, 'working');
    await tasks.setState(created.id, 'paused');
    const run = await attempts.create(created.id);
    const runPostMergeCheck = vi.fn(async () => ({ pass: true, output: '' }));
    const coord = new CrashRecoveryCoordinator(attempts, tasks, settle, { runPostMergeCheck });

    await coord.reconcile();

    expect(runPostMergeCheck).not.toHaveBeenCalled();
    expect(await attempts.get(run.id)).toMatchObject({ state: 'failed', reason: 'process-death' });
    expect((await tasks.get(created.id)).state).toBe('paused');
  });

  it('uses the injected isMerged seam to reject recovery when supplied', async () => {
    const { run } = await seedAlreadyMergedOrphan();
    const isMerged = vi.fn(async () => false);
    const runPostMergeCheck = vi.fn(async () => ({ pass: true, output: '' }));
    const coord = new CrashRecoveryCoordinator(attempts, tasks, settle, { runPostMergeCheck, isMerged });

    await coord.reconcile();

    expect(isMerged).toHaveBeenCalledWith(repo, 'main', 'run-branch');
    expect(runPostMergeCheck).not.toHaveBeenCalled();
    expect((await attempts.get(run.id)).state).toBe('failed');
  });

  it('yields while reconciling a large backlog of running orphans', async () => {
    for (let i = 0; i < 25; i++) {
      const created = await tasks.create({ prompt: `orphan ${i}`, state: 'ready', workingDir: repo, isolationMode: 'worktree' });
      await tasks.setState(created.id, 'working');
      await attempts.update((await attempts.create(created.id)).id, { branch: 'main', baseBranch: 'main' });
    }
    let tick = 0;
    let yields = 0;
    const order: string[] = [];
    const coord = new CrashRecoveryCoordinator(attempts, tasks, settle, {
      runPostMergeCheck: async () => ({ pass: true, output: '' }),
      yieldOptions: {
        budgetMs: 0,
        now: () => tick++,
        yieldNow: async () => {
          yields++;
          await yieldToEventLoop();
        },
      },
    });

    const done = coord.reconcile().then(() => order.push('done'));
    setImmediate(() => order.push('immediate'));
    await done;
    await yieldToEventLoop();

    expect(yields).toBeGreaterThan(0);
    expect(order.indexOf('immediate')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('immediate')).toBeLessThan(order.indexOf('done'));
    expect((await attempts.listAllRunning())).toHaveLength(0);
  });
});
