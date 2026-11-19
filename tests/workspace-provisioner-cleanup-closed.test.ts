import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { WorkspaceProvisioner, type WorkspaceProvisionerDeps } from '../src/execution/workspace-provisioner.js';
import { Git } from '../src/execution/git.js';
import type { AttemptRow, TaskRow } from '../src/db/schema.js';

vi.mock('../src/execution/code-index.js', () => ({ dropIndexForPath: vi.fn(async () => {}) }));

const task = { id: 5, workingDir: '/repo' } as unknown as TaskRow;

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'harmonic-cleanup-closed-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tmp, { recursive: true, force: true });
});

function setup(over: Partial<WorkspaceProvisionerDeps> = {}, session: { worktreePath: string | null; worktreeRepoDir: string | null } | null = null) {
  vi.restoreAllMocks();
  const calls: string[] = [];
  const attemptEvents: Record<string, unknown>[] = [];
  const taskEvents: Record<string, unknown>[] = [];
  const get = vi.fn(async () => session);
  const deps = {
    attempts: {
      appendEvent: vi.fn(async (_id: number, e: { payload: Record<string, unknown> }) => {
        attemptEvents.push(e.payload);
        return e;
      }),
      get: vi.fn(async (id: number) => ({ id })),
    },
    sessionStore: { get },
    autoDrive: undefined,
    sessionRetirement: undefined,
    events: { onAttemptFinished: vi.fn(() => calls.push('finished')) },
    worktreesDir: tmp,
    taskEvents: { appendEvent: vi.fn(async (_id: number, p: Record<string, unknown>) => void taskEvents.push(p)) },
    ...over,
  } as unknown as WorkspaceProvisionerDeps;
  const removeWorktree = vi.spyOn(Git, 'removeWorktree').mockImplementation(async () => {
    calls.push('removeWorktree');
  });
  const deleteBranch = vi.spyOn(Git, 'deleteBranch').mockImplementation(async () => {
    calls.push('deleteBranch');
  });
  const checkedOutAt = vi.spyOn(Git, 'branchCheckedOutAt').mockResolvedValue(null);
  const branchExists = vi.spyOn(Git, 'branchExists').mockResolvedValue(true);
  return { p: new WorkspaceProvisioner(deps), deps, calls, attemptEvents, taskEvents, get, removeWorktree, deleteBranch, checkedOutAt, branchExists };
}

const attemptRun = (over: Record<string, unknown> = {}) => ({ id: 9, sessionRowId: 4, branch: 'harmonic/task-5', ...over }) as unknown as AttemptRow;

describe('WorkspaceProvisioner.cleanupClosed with an Attempt', () => {
  const live = () => ({ worktreePath: tmp, worktreeRepoDir: '/repo' });

  it('retires the session, removes the worktree, deletes the branch, then reports the Attempt finished', async () => {
    const onAttemptSettled = vi.fn(async () => {});
    const t = setup({ sessionRetirement: { onAttemptSettled } as never }, live());
    await t.p.cleanupClosed(task, attemptRun());
    expect(onAttemptSettled).toHaveBeenCalledWith(expect.objectContaining({ id: 9 }), 'operator-cancel');
    expect(t.removeWorktree).toHaveBeenCalledWith('/repo', tmp);
    expect(t.deleteBranch).toHaveBeenCalledWith('/repo', 'harmonic/task-5');
    expect(t.calls).toEqual(['removeWorktree', 'deleteBranch', 'finished']);
    expect(t.attemptEvents).toEqual([
      { event: 'worktree-removed', worktree: basename(tmp) },
      { event: 'branch-deleted', branch: 'harmonic/task-5' },
    ]);
  });

  it('carries on when session retirement throws', async () => {
    const t = setup({ sessionRetirement: { onAttemptSettled: async () => { throw new Error('boom'); } } as never }, live());
    await t.p.cleanupClosed(task, attemptRun());
    expect(t.calls).toEqual(['removeWorktree', 'deleteBranch', 'finished']);
  });

  it('skips worktree removal without a session row or when the session lookup fails', async () => {
    const none = setup({}, live());
    await none.p.cleanupClosed(task, attemptRun({ sessionRowId: null }));
    expect(none.get).not.toHaveBeenCalled();
    expect(none.removeWorktree).not.toHaveBeenCalled();
    expect(none.deleteBranch).toHaveBeenCalled();

    const failing = setup({}, live());
    failing.get.mockRejectedValue(new Error('gone'));
    await failing.p.cleanupClosed(task, attemptRun());
    expect(failing.removeWorktree).not.toHaveBeenCalled();
    expect(failing.deleteBranch).toHaveBeenCalled();
  });

  it('skips worktree removal when the recorded path is missing or absent on disk', async () => {
    for (const session of [{ worktreePath: null, worktreeRepoDir: '/repo' }, { worktreePath: tmp, worktreeRepoDir: null }, { worktreePath: join(tmp, 'nope'), worktreeRepoDir: '/repo' }]) {
      const t = setup({}, session);
      await t.p.cleanupClosed(task, attemptRun());
      expect(t.removeWorktree).not.toHaveBeenCalled();
    }
  });

  it('records a worktree removal failure and still deletes the branch', async () => {
    const t = setup({}, live());
    t.removeWorktree.mockRejectedValue(new Error('locked'));
    await t.p.cleanupClosed(task, attemptRun());
    expect(t.attemptEvents[0]).toEqual({ event: 'worktree-remove-failed', worktree: basename(tmp), error: 'locked' });
    expect(t.deleteBranch).toHaveBeenCalled();
  });

  it('leaves a branch that is checked out elsewhere, and a run without a branch', async () => {
    const elsewhere = setup({}, live());
    elsewhere.checkedOutAt.mockResolvedValue('/other');
    await elsewhere.p.cleanupClosed(task, attemptRun());
    expect(elsewhere.deleteBranch).not.toHaveBeenCalled();

    const lookupFails = setup({}, live());
    lookupFails.checkedOutAt.mockRejectedValue(new Error('x'));
    await lookupFails.p.cleanupClosed(task, attemptRun());
    expect(lookupFails.deleteBranch).toHaveBeenCalled();

    const branchless = setup({}, live());
    await branchless.p.cleanupClosed(task, attemptRun({ branch: null }));
    expect(branchless.deleteBranch).not.toHaveBeenCalled();
    expect(branchless.calls).toContain('finished');
  });

  it('records a branch deletion failure', async () => {
    const t = setup({}, live());
    t.deleteBranch.mockRejectedValue(new Error('unmerged'));
    await t.p.cleanupClosed(task, attemptRun());
    expect(t.attemptEvents.at(-1)).toEqual({ event: 'branch-delete-failed', branch: 'harmonic/task-5', error: 'unmerged' });
    expect(t.calls).toContain('finished');
  });
});

describe('WorkspaceProvisioner.cleanupClosed without an Attempt', () => {
  const taskWithDir = () => ({ id: 5, workingDir: '/repo' }) as unknown as TaskRow;
  const worktree = () => join(tmp, 'task-5');
  const withWorktree = async () => {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(worktree());
  };

  it('removes the Task worktree and branch and records both on the Task', async () => {
    await withWorktree();
    const t = setup();
    await t.p.cleanupClosed(taskWithDir(), undefined);
    expect(t.removeWorktree).toHaveBeenCalledWith('/repo', worktree());
    expect(t.deleteBranch).toHaveBeenCalledWith('/repo', 'harmonic/task-5');
    expect(t.taskEvents).toEqual([
      { event: 'worktree-removed', worktree: 'task-5' },
      { event: 'branch-deleted', branch: 'harmonic/task-5' },
    ]);
    expect(t.calls).not.toContain('finished');
  });

  it('does nothing when there is no worktree and no branch', async () => {
    const t = setup();
    t.branchExists.mockResolvedValue(false);
    await t.p.cleanupClosed(taskWithDir(), undefined);
    expect(t.removeWorktree).not.toHaveBeenCalled();
    expect(t.deleteBranch).not.toHaveBeenCalled();
    expect(t.taskEvents).toEqual([]);
  });

  it('treats a failed branch lookup as absent, and a branch checked out elsewhere as off limits', async () => {
    const lookupFails = setup();
    lookupFails.branchExists.mockRejectedValue(new Error('x'));
    await lookupFails.p.cleanupClosed(taskWithDir(), undefined);
    expect(lookupFails.deleteBranch).not.toHaveBeenCalled();

    const elsewhere = setup();
    elsewhere.checkedOutAt.mockResolvedValue('/other');
    await elsewhere.p.cleanupClosed(taskWithDir(), undefined);
    expect(elsewhere.deleteBranch).not.toHaveBeenCalled();
  });

  it('records worktree and branch failures on the Task', async () => {
    await withWorktree();
    const t = setup();
    t.removeWorktree.mockRejectedValue(new Error('locked'));
    t.deleteBranch.mockRejectedValue(new Error('unmerged'));
    await t.p.cleanupClosed(taskWithDir(), undefined);
    expect(t.taskEvents).toEqual([
      { event: 'worktree-remove-failed', worktree: 'task-5', error: 'locked' },
      { event: 'branch-delete-failed', branch: 'harmonic/task-5', error: 'unmerged' },
    ]);
  });
});

describe('WorkspaceProvisioner.cleanupClosed closing the tracker issue', () => {
  it('closes the ticket after the cleanup, with the operator-close comment, for both variants', async () => {
    const closeTicket = vi.fn(async () => true);
    const t = setup({ autoDrive: { closeTicket } as never });
    t.branchExists.mockResolvedValue(false);
    await t.p.cleanupClosed(task, undefined);
    await t.p.cleanupClosed(task, attemptRun({ sessionRowId: null, branch: null }));
    expect(closeTicket).toHaveBeenCalledTimes(2);
    expect(closeTicket).toHaveBeenCalledWith(task, 'Closed by a Harmonic operator without merging (task 5).');
  });

  it('survives a ticket that could not be closed', async () => {
    const closeTicket = vi.fn(async () => false);
    const t = setup({ autoDrive: { closeTicket } as never });
    t.branchExists.mockResolvedValue(false);
    await expect(t.p.cleanupClosed(task, undefined)).resolves.toBeUndefined();
    expect(closeTicket).toHaveBeenCalledTimes(1);
  });
});
