import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { defaultConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import { AttemptStore } from '../src/domain/attempts.js';
import { RunSettleCoordinator } from '../src/domain/run-settle.js';
import { CrashRecoveryCoordinator } from '../src/domain/crash-recovery.js';
import { Git } from '../src/execution/git.js';
import type { TaskRow, AttemptRow } from '../src/db/schema.js';
import type { SettingsStore } from '../src/server/settings-store.js';
import { allWorkspaces, makeSettingsStore } from './helpers.js';
import { yieldToEventLoop } from '../src/reliability/yield.js';

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

/** A throwaway git repo on branch main with one committed README. */
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

/** Commit `content` to `path` on the currently checked-out branch. */
function commit(dir: string, path: string, content: string, message: string): void {
  writeFileSync(join(dir, path), content);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', message);
}

/**
 * Direct unit coverage for `CrashRecoveryCoordinator` under the ADR-0001
 * model: no `merge_journal`, no `turn_queue` — crash recovery relies on git's
 * own idempotence (a task branch either already landed in its base, checked
 * via `git merge-base --is-ancestor`, or it didn't) and on the generic
 * `running` orphan sweep for everything else.
 */
describe('CrashRecoveryCoordinator (ADR-0001)', () => {
  let dir: string;
  let repo: string;
  let asyncDb: AsyncDbHandle;
  let settingsStore: SettingsStore;
  let tasks: TaskService;
  let attempts: AttemptStore;
  let settle: RunSettleCoordinator;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-crash-recovery-'));
    repo = makeRepo();
    asyncDb = await openAsyncDb(dir);
    settingsStore = await makeSettingsStore(dir);
    tasks = new TaskService(asyncDb, () => defaultConfig(), allWorkspaces(asyncDb, settingsStore));
    attempts = new AttemptStore(asyncDb);
    settle = new RunSettleCoordinator(tasks, attempts);
  });

  afterEach(async () => {
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  /** A worktree-mode Task + Run parked `running` exactly as a crash mid-merge
   * would leave them, with `branch` already merged into `baseBranch` in the
   * real repo (so `Git.isAncestor` says true without any injected seam). */
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

  /** A worktree-mode Task + Run parked `running` whose branch was never
   * merged into its base. */
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
    const runPostMergeCheck = vi.fn(async () => ({ pass: true, output: '' }));
    const coord = new CrashRecoveryCoordinator(attempts, tasks, settle, { runPostMergeCheck });

    await coord.reconcile();

    expect(runPostMergeCheck).toHaveBeenCalledTimes(1);
    expect(runPostMergeCheck).toHaveBeenCalledWith({ task: expect.objectContaining({ id: task.id }), run: expect.objectContaining({ id: run.id }), mergeOid: baseTip, baseDir: repo });
    const settled = await attempts.get(run.id);
    expect(settled.state).toBe('passed');
    expect((await tasks.get(task.id)).state).toBe('done');
    // The base tip is untouched (no revert): still the merge commit.
    expect(await Git.revParse(repo, baseBranch)).toBe(baseTip);

    // Idempotent: a second reconcile finds nothing `running` for this Run.
    await coord.reconcile();
    expect(runPostMergeCheck).toHaveBeenCalledTimes(1);
    expect((await attempts.get(run.id)).state).toBe('passed');
  });

  it('reverts a crashed merge whose post-merge check now fails, and escalates the task — idempotently on a second reconcile', async () => {
    const { task, run, baseBranch } = await seedAlreadyMergedOrphan();
    const preRevertTip = await Git.revParse(repo, baseBranch);
    const runPostMergeCheck = vi.fn(async () => ({ pass: false, output: 'lint failed: feature.txt' }));
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
    // The merge commit was reverted (`git revert -m 1`): the base moved past
    // the merge tip to a new revert commit, and the file the merge introduced
    // is gone from the working tree.
    const revertedTip = await Git.revParse(repo, baseBranch);
    expect(revertedTip).not.toBe(preRevertTip);
    expect(existsSync(join(repo, 'feature.txt'))).toBe(false);

    // Idempotent: the Run already left `running`, so a second reconcile never
    // re-checks or re-reverts.
    await coord.reconcile();
    expect(runPostMergeCheck).toHaveBeenCalledTimes(1);
    expect(await Git.revParse(repo, baseBranch)).toBe(revertedTip);
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

  it('uses the injected isMerged seam instead of spawning git when supplied', async () => {
    const { run } = await seedUnmergedOrphan(); // really unmerged in git
    const isMerged = vi.fn(async () => true); // but the seam claims merged
    const runPostMergeCheck = vi.fn(async () => ({ pass: true, output: '' }));
    const coord = new CrashRecoveryCoordinator(attempts, tasks, settle, { runPostMergeCheck, isMerged });

    await coord.reconcile();

    expect(isMerged).toHaveBeenCalledWith(repo, 'main', 'never-merged-branch');
    expect(runPostMergeCheck).toHaveBeenCalledTimes(1); // the seam, not git, decided
    expect((await attempts.get(run.id)).state).toBe('passed');
  });

  it('yields while reconciling a large backlog of running orphans', async () => {
    // Worktree-mode with branch/baseBranch set, so each Run is a candidate
    // pass A actually iterates (an unmerged branch, so each falls through
    // fast to pass B without spawning a real merge).
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
