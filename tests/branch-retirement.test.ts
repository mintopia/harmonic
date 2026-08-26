import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BranchRetirementCoordinator, type BranchRetirementGit } from '../src/execution/branch-retirement.js';
import type { RunRow, TaskRow } from '../src/db/schema.js';
import { Git } from '../src/execution/git.js';

type RetirableRun = Pick<RunRow, 'id' | 'taskId' | 'state' | 'branch' | 'baseBranch'>;

const run = (over: Partial<RetirableRun> = {}): RetirableRun => ({
  id: 1,
  taskId: 2,
  state: 'completed',
  branch: 'harmonic/task-2-run-1',
  baseBranch: 'develop',
  ...over,
});

const task: Pick<TaskRow, 'workingDir' | 'state' | 'origin' | 'trackerState'> = {
  workingDir: '/repo',
  state: 'done',
  origin: 'native',
  trackerState: null,
};

const raw = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harmonic-branch-retirement-'));
  execFileSync('git', ['init', '-b', 'main', dir], { encoding: 'utf8' });
  raw(dir, 'config', 'user.name', 'Test');
  raw(dir, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(dir, 'README.md'), '# repo\\n');
  raw(dir, 'add', '-A');
  raw(dir, 'commit', '-m', 'init');
  return dir;
}

function git(over: Partial<BranchRetirementGit> = {}): BranchRetirementGit {
  return {
    branchExists: vi.fn(async () => true),
    branchCheckedOutAt: vi.fn(async () => null),
    symbolicBranch: vi.fn(async () => 'develop'),
    isContentContained: vi.fn(async () => true),
    deleteBranch: vi.fn(async () => undefined),
    ...over,
  };
}

describe('BranchRetirementCoordinator', () => {
  it('retires a drifted branch whose content already landed under a different SHA', async () => {
    const branchGit = git();
    const coordinator = new BranchRetirementCoordinator({ listAll: async () => [] }, { get: async () => task }, branchGit);

    await coordinator.onRunSettled(task, run());

    expect(branchGit.isContentContained).toHaveBeenCalledWith('/repo', 'develop', 'harmonic/task-2-run-1');
    expect(branchGit.deleteBranch).toHaveBeenCalledWith('/repo', 'harmonic/task-2-run-1');
  });

  it('never deletes a branch with unmerged content or an active worktree', async () => {
    const unmerged = git({ isContentContained: vi.fn(async () => false) });
    const active = git({ branchCheckedOutAt: vi.fn(async () => '/worktree/run-1') });
    const noopRuns = { listAll: async () => [] };
    const tasks = { get: async () => task };

    await new BranchRetirementCoordinator(noopRuns, tasks, unmerged).onRunSettled(task, run());
    await new BranchRetirementCoordinator(noopRuns, tasks, active).onRunSettled(task, run());

    expect(unmerged.deleteBranch).not.toHaveBeenCalled();
    expect(active.deleteBranch).not.toHaveBeenCalled();
  });

  it('retires an Epic member against develop after its integration branch is gone', async () => {
    const branchGit = git();
    const coordinator = new BranchRetirementCoordinator({ listAll: async () => [] }, { get: async () => task }, branchGit);

    await coordinator.onRunSettled(task, run({ baseBranch: 'epic/333' }));

    expect(branchGit.isContentContained).toHaveBeenCalledWith('/repo', 'develop', 'harmonic/task-2-run-1');
    expect(branchGit.deleteBranch).toHaveBeenCalledWith('/repo', 'harmonic/task-2-run-1');
  });

  it('retires a drifted branch after equivalent content lands under another SHA', async () => {
    const repo = makeRepo();
    try {
      raw(repo, 'checkout', '-b', 'harmonic/task-2-run-1');
      writeFileSync(join(repo, 'work.txt'), 'landed work\\n');
      raw(repo, 'add', '-A');
      raw(repo, 'commit', '-m', 'candidate work');
      raw(repo, 'checkout', 'main');
      writeFileSync(join(repo, 'work.txt'), 'landed work\\n');
      raw(repo, 'add', '-A');
      raw(repo, 'commit', '-m', 'landed work');
      expect(await Git.isAncestor(repo, 'main', 'harmonic/task-2-run-1')).toBe(false);

      await new BranchRetirementCoordinator({ listAll: async () => [] }, { get: async () => task }).onRunSettled(
        { ...task, workingDir: repo },
        run(),
      );

      expect(await Git.branchExists(repo, 'harmonic/task-2-run-1')).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('retires an Epic member after its deleted integration branch is no longer resolvable', async () => {
    const repo = makeRepo();
    try {
      raw(repo, 'branch', 'epic/333');
      raw(repo, 'checkout', '-b', 'harmonic/task-2-run-1', 'epic/333');
      writeFileSync(join(repo, 'work.txt'), 'landed work\\n');
      raw(repo, 'add', '-A');
      raw(repo, 'commit', '-m', 'candidate work');
      raw(repo, 'checkout', 'main');
      writeFileSync(join(repo, 'work.txt'), 'landed work\\n');
      raw(repo, 'add', '-A');
      raw(repo, 'commit', '-m', 'landed work');
      raw(repo, 'branch', '-D', 'epic/333');
      expect(await Git.branchExists(repo, 'epic/333')).toBe(false);

      await new BranchRetirementCoordinator({ listAll: async () => [] }, { get: async () => task }).onRunSettled(
        { ...task, workingDir: repo },
        run({ baseBranch: 'epic/333' }),
      );

      expect(await Git.branchExists(repo, 'harmonic/task-2-run-1')).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('keeps branch evidence while an adopted Ticket is held for review or its tracker issue is open', async () => {
    const inReview = git();
    const trackerOpen = git();
    const noopRuns = { listAll: async () => [] };
    const tasks = { get: async () => task };

    await new BranchRetirementCoordinator(noopRuns, tasks, inReview).onRunSettled({ ...task, state: 'escalated' }, run());
    await new BranchRetirementCoordinator(noopRuns, tasks, trackerOpen).onRunSettled(
      { ...task, origin: 'mirrored', trackerState: 'open' },
      run(),
    );

    expect(inReview.deleteBranch).not.toHaveBeenCalled();
    expect(trackerOpen.deleteBranch).not.toHaveBeenCalled();
  });

  it('backfills terminal candidates and skips an in-flight Run', async () => {
    const branchGit = git();
    const coordinator = new BranchRetirementCoordinator(
      { listAll: async () => [run(), run({ id: 3, state: 'running', branch: 'harmonic/task-2-run-2' })] },
      { get: async () => task },
      branchGit,
    );

    await coordinator.reconcile({ budgetMs: 0, yieldNow: async () => {} });

    expect(branchGit.deleteBranch).toHaveBeenCalledTimes(1);
  });

  it('retires a contained superseded retry without touching the adopted Run branch', async () => {
    const branchGit = git();
    const coordinator = new BranchRetirementCoordinator(
      {
        listAll: async () => [
          run({ id: 1, branch: 'harmonic/task-2-run-1' }),
          run({ id: 2, state: 'running', branch: 'harmonic/task-2-run-2' }),
        ],
      },
      { get: async () => task },
      branchGit,
    );

    await coordinator.reconcile();

    expect(branchGit.deleteBranch).toHaveBeenCalledWith('/repo', 'harmonic/task-2-run-1');
    expect(branchGit.deleteBranch).not.toHaveBeenCalledWith('/repo', 'harmonic/task-2-run-2');
  });
});
