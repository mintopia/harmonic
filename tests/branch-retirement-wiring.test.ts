import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { baselineConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import { AttemptStore } from '../src/domain/attempts.js';
import { AttemptSettleCoordinator } from '../src/domain/attempt-settle.js';
import { BranchRetirementCoordinator } from '../src/execution/branch-retirement.js';
import { Git } from '../src/execution/git.js';
import type { SettingsStore } from '../src/server/settings-store.js';
import { allWorkspaces, makeSettingsStore, seedWorkspace } from './helpers.js';

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harmonic-branch-wiring-repo-'));
  execFileSync('git', ['init', '-b', 'develop', dir], { encoding: 'utf8' });
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(dir, 'README.md'), '# repo\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'init');
  return dir;
}

/** Cuts `harmonic/task-<id>` at develop's tip, so it starts life already
 * content-contained in develop — exactly what a merged-and-done Task's branch
 * looks like once its work has landed. */
function cutContainedBranch(repo: string, branch: string): void {
  git(repo, 'branch', branch, 'develop');
}

describe('Branch retirement wiring (owner decision: re-enable, visibly, with backfill)', () => {
  let dir: string;
  let repo: string;
  let asyncDb: AsyncDbHandle;
  let settingsStore: SettingsStore;
  let tasks: TaskService;
  let attempts: AttemptStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-branch-wiring-'));
    repo = makeRepo();
    asyncDb = await openAsyncDb(dir);
    await seedWorkspace(asyncDb, repo);
    settingsStore = await makeSettingsStore(dir);
    tasks = new TaskService(asyncDb, () => baselineConfig(), allWorkspaces(asyncDb, settingsStore));
    attempts = new AttemptStore(asyncDb);
  });

  afterEach(async () => {
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  it('wires BranchRetirementCoordinator into AttemptSettleCoordinator.settle: a settled, contained branch is deleted and the deletion is recorded on the Attempt', async () => {
    const task = await tasks.create({ prompt: 'p', state: 'ready', workingDir: repo, isolationMode: 'worktree' });
    await tasks.setState(task.id, 'working');
    const branch = `harmonic/task-${task.id}`;
    cutContainedBranch(repo, branch);
    const run = await attempts.update((await attempts.create(task.id)).id, { branch, baseBranch: 'develop' });

    const recorded: [number, Record<string, unknown>][] = [];
    const branchRetirement = new BranchRetirementCoordinator(attempts, tasks, Git, () => {}, (attemptId, payload) => recorded.push([attemptId, payload]));
    const coordinator = new AttemptSettleCoordinator(tasks, attempts, undefined, undefined, branchRetirement);

    await coordinator.settle({ ...task, state: 'done' }, run, 'agent-finish/unresolved', { runState: 'completed', taskAction: 'none', reason: null });

    expect(await Git.branchExists(repo, branch)).toBe(false);
    expect(recorded).toEqual([[run.id, { event: 'branch-deleted', branch, containedIn: 'develop' }]]);
  });

  it('boot backfill (reconcile) clears branches that piled up while retirement was unwired, recording a row on each backfilled Attempt', async () => {
    const task = await tasks.create({ prompt: 'p', state: 'ready', workingDir: repo, isolationMode: 'worktree' });
    const branch = `harmonic/task-${task.id}`;
    cutContainedBranch(repo, branch);
    const run = await attempts.update((await attempts.create(task.id)).id, { branch, baseBranch: 'develop', state: 'passed' });
    await tasks.setState(task.id, 'done');

    const recorded: [number, Record<string, unknown>][] = [];
    const branchRetirement = new BranchRetirementCoordinator(attempts, tasks, Git, () => {}, (attemptId, payload) => recorded.push([attemptId, payload]));

    await branchRetirement.reconcile();

    expect(await Git.branchExists(repo, branch)).toBe(false);
    expect(recorded).toEqual([[run.id, { event: 'branch-deleted', branch, containedIn: 'develop' }]]);
  });

  it('never deletes a branch that a warm Session still has checked out in a worktree', async () => {
    const task = await tasks.create({ prompt: 'p', state: 'ready', workingDir: repo, isolationMode: 'worktree' });
    const branch = `harmonic/task-${task.id}`;
    const worktreePath = join(mkdtempSync(join(tmpdir(), 'harmonic-branch-wiring-wt-')), `task-${task.id}`);
    git(repo, 'worktree', 'add', '-b', branch, worktreePath, 'develop');
    await attempts.update((await attempts.create(task.id)).id, { branch, baseBranch: 'develop', state: 'passed' });
    await tasks.setState(task.id, 'done');

    const recorded: unknown[] = [];
    const branchRetirement = new BranchRetirementCoordinator(attempts, tasks, Git, () => {}, (attemptId, payload) => recorded.push([attemptId, payload]));

    await branchRetirement.reconcile();

    expect(await Git.branchExists(repo, branch)).toBe(true);
    expect(recorded).toEqual([]);
  });

  it('retires a worktree-mode Epic member\'s branch once its Epic integrates, without a restart (owner decision: recheck on integration)', async () => {
    const task = await tasks.create({ prompt: 'p', state: 'ready', workingDir: repo, isolationMode: 'worktree' });
    const branch = `harmonic/task-${task.id}`;
    git(repo, 'branch', 'epic/5', 'develop');
    git(repo, 'checkout', 'epic/5');
    git(repo, 'checkout', '-b', branch);
    writeFileSync(join(repo, 'member.txt'), 'member work\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'member work');
    git(repo, 'checkout', 'epic/5');
    git(repo, 'merge', '--no-ff', '-m', 'fold member', branch);
    git(repo, 'checkout', 'develop');
    await attempts.update((await attempts.create(task.id)).id, { branch, baseBranch: 'epic/5', state: 'passed' });
    await tasks.setState(task.id, 'done');

    const recorded: [number, Record<string, unknown>][] = [];
    const branchRetirement = new BranchRetirementCoordinator(attempts, tasks, Git, () => {}, (attemptId, payload) => recorded.push([attemptId, payload]));

    await branchRetirement.reconcile();
    expect(await Git.branchExists(repo, branch)).toBe(true);
    expect(recorded).toEqual([]);

    git(repo, 'merge', '--no-ff', '-m', 'integrate epic 5', 'epic/5');

    await branchRetirement.reconcile();

    expect(await Git.branchExists(repo, branch)).toBe(false);
    expect(recorded).toEqual([[expect.any(Number), { event: 'branch-deleted', branch, containedIn: 'develop' }]]);
  });
});
