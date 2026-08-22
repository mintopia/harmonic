import { describe, expect, it, vi } from 'vitest';
import { BranchRetirementCoordinator, type BranchRetirementGit } from '../src/execution/branch-retirement.js';
import type { RunRow, TaskRow } from '../src/db/schema.js';

type RetirableRun = Pick<RunRow, 'id' | 'taskId' | 'state' | 'branch' | 'baseBranch'>;

const run = (over: Partial<RetirableRun> = {}): RetirableRun => ({
  id: 1,
  taskId: 2,
  state: 'completed',
  branch: 'harmonic/task-2-run-1',
  baseBranch: 'develop',
  ...over,
});

const task: Pick<TaskRow, 'workingDir'> = { workingDir: '/repo' };

function git(over: Partial<BranchRetirementGit> = {}): BranchRetirementGit {
  return {
    branchExists: vi.fn(async () => true),
    branchCheckedOutAt: vi.fn(async () => null),
    isAncestor: vi.fn(async () => true),
    deleteBranch: vi.fn(async () => undefined),
    ...over,
  };
}

describe('BranchRetirementCoordinator', () => {
  it('deletes a landed candidate branch only after proving it is contained and inactive', async () => {
    const branchGit = git();
    const coordinator = new BranchRetirementCoordinator({ listAll: async () => [] }, { get: async () => task }, branchGit);

    await coordinator.onRunSettled(task, run());

    expect(branchGit.isAncestor).toHaveBeenCalledWith('/repo', 'develop', 'harmonic/task-2-run-1');
    expect(branchGit.deleteBranch).toHaveBeenCalledWith('/repo', 'harmonic/task-2-run-1');
  });

  it('never deletes a branch with unmerged commits or an active worktree', async () => {
    const unmerged = git({ isAncestor: vi.fn(async () => false) });
    const active = git({ branchCheckedOutAt: vi.fn(async () => '/worktree/run-1') });
    const noopRuns = { listAll: async () => [] };
    const tasks = { get: async () => task };

    await new BranchRetirementCoordinator(noopRuns, tasks, unmerged).onRunSettled(task, run());
    await new BranchRetirementCoordinator(noopRuns, tasks, active).onRunSettled(task, run());

    expect(unmerged.deleteBranch).not.toHaveBeenCalled();
    expect(active.deleteBranch).not.toHaveBeenCalled();
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
