import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Git } from '../src/execution/git.js';
import { runMergePolicy, type MergePolicyDeps } from '../src/execution/merge-policy.js';

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harmonic-merge-policy-'));
  tmpDirs.push(dir);
  execFileSync('git', ['init', '-b', 'main', dir], { encoding: 'utf8' });
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(dir, 'base.txt'), 'base\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'initial');
  return dir;
}

/** Cut `branchName` off `main` in a scratch worktree, mutate + commit there.
 * The base repo (`repoDir`) is left untouched — its HEAD stays on `main`. */
async function makeTaskBranch(repoDir: string, branchName: string, mutate: (worktreeDir: string) => void): Promise<void> {
  const wtRoot = mkdtempSync(join(tmpdir(), 'harmonic-merge-policy-wt-'));
  tmpDirs.push(wtRoot);
  const wt = join(wtRoot, branchName);
  await Git.addWorktree(repoDir, wt, branchName, 'main');
  mutate(wt);
  git(wt, 'add', '-A');
  git(wt, 'commit', '-m', `${branchName} work`);
}

function neverCalled(name: string) {
  return vi.fn(async () => {
    throw new Error(`${name} must not be called`);
  });
}

describe('runMergePolicy (ADR-0001, "One merge policy, everywhere")', () => {
  it('merges a non-conflicting task branch with a real merge commit and does not escalate', async () => {
    const repo = makeRepo();
    await makeTaskBranch(repo, 'task-clean', (wt) => {
      writeFileSync(join(wt, 'feature.txt'), 'feature\n');
    });

    const deps: MergePolicyDeps = {
      resolveConflictTurn: neverCalled('resolveConflictTurn'),
      runPostMergeCheck: vi.fn(async () => ({ pass: true, output: '' })),
      escalate: vi.fn(async () => {}),
    };

    const outcome = await runMergePolicy(
      { baseDir: repo, baseBranch: 'main', taskBranch: 'task-clean', conflictResolveTurns: 2, postMergeCheck: true },
      deps,
    );

    expect(outcome.kind).toBe('merged');
    expect(deps.escalate).not.toHaveBeenCalled();
    // A real merge commit: HEAD has a second parent, and history now contains a merge.
    expect(git(repo, 'rev-parse', 'HEAD^2')).toBeTruthy();
    expect(Number(git(repo, 'rev-list', '--count', '--merges', 'HEAD'))).toBeGreaterThanOrEqual(1);
  });

  it('checks the base branch out before merging when the base repo is on a different branch', async () => {
    // The shared base repo is parked on an unrelated branch (as it is in the
    // runner: worktree tasks never sit it on their base branch). The policy must
    // still land the merge on `main`, not on whatever HEAD happened to be.
    const repo = makeRepo();
    const mainTip = git(repo, 'rev-parse', 'main');
    git(repo, 'checkout', '-b', 'parked');
    writeFileSync(join(repo, 'parked.txt'), 'parked work\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'parked commit');
    await makeTaskBranch(repo, 'task-elsewhere', (wt) => {
      writeFileSync(join(wt, 'feature.txt'), 'feature\n');
    });

    const deps: MergePolicyDeps = {
      resolveConflictTurn: neverCalled('resolveConflictTurn'),
      runPostMergeCheck: vi.fn(async () => ({ pass: true, output: '' })),
      escalate: vi.fn(async () => {}),
    };

    const outcome = await runMergePolicy(
      { baseDir: repo, baseBranch: 'main', taskBranch: 'task-elsewhere', conflictResolveTurns: 2, postMergeCheck: true },
      deps,
    );

    expect(outcome.kind).toBe('merged');
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    // `main` advanced past its old tip with a merge commit; `parked` is untouched.
    expect(git(repo, 'rev-parse', 'main')).not.toBe(mainTip);
    expect(git(repo, 'rev-parse', 'HEAD^2')).toBeTruthy();
    expect(() => git(repo, 'show', 'main:feature.txt')).not.toThrow();
  });

  it('runs a post-merge check that adds a worktree on the same repo without deadlocking', async () => {
    // The runner's real post-merge check runs the command verifier, which adds
    // a detached worktree (a repo-locked op) on the base repo — while the policy
    // still holds that repo's merge lock. This guards that the lock is reentrant
    // so the ADR-0001 "check under the mutex" wiring cannot self-deadlock.
    const repo = makeRepo();
    await makeTaskBranch(repo, 'task-postmerge', (wt) => {
      writeFileSync(join(wt, 'feature.txt'), 'feature\n');
    });

    const deps: MergePolicyDeps = {
      resolveConflictTurn: neverCalled('resolveConflictTurn'),
      runPostMergeCheck: vi.fn(async (mergeOid: string, baseDir: string) => {
        const wt = mkdtempSync(join(tmpdir(), 'harmonic-postmerge-wt-'));
        tmpDirs.push(wt);
        const checkout = join(wt, 'check');
        await Git.addDetachedWorktree(baseDir, checkout, mergeOid);
        await Git.removeWorktree(baseDir, checkout);
        return { pass: true, output: '' };
      }),
      escalate: vi.fn(async () => {}),
    };

    const outcome = await runMergePolicy(
      { baseDir: repo, baseBranch: 'main', taskBranch: 'task-postmerge', conflictResolveTurns: 2, postMergeCheck: true },
      deps,
    );

    expect(outcome.kind).toBe('merged');
    expect(deps.runPostMergeCheck).toHaveBeenCalledOnce();
    expect(deps.escalate).not.toHaveBeenCalled();
  });

  it('resolves a same-line conflict via one agentic turn and still merges cleanly', async () => {
    const repo = makeRepo();
    await makeTaskBranch(repo, 'task-resolvable', (wt) => {
      writeFileSync(join(wt, 'base.txt'), 'task version\n');
    });
    // Base moves on the same line after the task branch forked, so merging conflicts.
    writeFileSync(join(repo, 'base.txt'), 'main version\n');
    git(repo, 'commit', '-am', 'main edits base.txt');

    const resolveConflictTurn = vi.fn(async (ctx) => {
      expect(ctx.unmergedPaths).toEqual(['base.txt']);
      expect(ctx.turn).toBe(1);
      writeFileSync(join(ctx.baseDir, 'base.txt'), 'resolved version\n');
      git(ctx.baseDir, 'add', 'base.txt');
    });
    const deps: MergePolicyDeps = {
      resolveConflictTurn,
      runPostMergeCheck: vi.fn(async () => ({ pass: true, output: '' })),
      escalate: vi.fn(async () => {}),
    };

    const outcome = await runMergePolicy(
      { baseDir: repo, baseBranch: 'main', taskBranch: 'task-resolvable', conflictResolveTurns: 2, postMergeCheck: true },
      deps,
    );

    expect(outcome.kind).toBe('merged');
    expect(deps.escalate).not.toHaveBeenCalled();
    expect(resolveConflictTurn).toHaveBeenCalledTimes(1);
    expect(git(repo, 'rev-parse', 'HEAD^2')).toBeTruthy();
  });

  it('escalates a conflict that outlasts the bounded resolve turns, with no merge left in progress', async () => {
    const repo = makeRepo();
    await makeTaskBranch(repo, 'task-unresolvable', (wt) => {
      writeFileSync(join(wt, 'base.txt'), 'task version\n');
    });
    writeFileSync(join(repo, 'base.txt'), 'main version\n');
    git(repo, 'commit', '-am', 'main edits base.txt');
    const originalHead = git(repo, 'rev-parse', 'HEAD');

    const resolveConflictTurn = vi.fn(async () => {
      // Never resolves the conflict — files are left untouched.
    });
    const deps: MergePolicyDeps = {
      resolveConflictTurn,
      runPostMergeCheck: neverCalled('runPostMergeCheck'),
      escalate: vi.fn(async () => {}),
    };

    const outcome = await runMergePolicy(
      { baseDir: repo, baseBranch: 'main', taskBranch: 'task-unresolvable', conflictResolveTurns: 2, postMergeCheck: true },
      deps,
    );

    expect(outcome.kind).toBe('escalated');
    if (outcome.kind !== 'escalated') throw new Error('unreachable');
    expect(outcome.reason).toBe('conflict');
    expect(outcome.message).not.toContain('<<<<<<<');
    expect(resolveConflictTurn).toHaveBeenCalledTimes(2);
    expect(deps.escalate).toHaveBeenCalledTimes(1);
    expect(deps.escalate).toHaveBeenCalledWith(outcome.message);

    // No merge left in progress, and the base tip never moved.
    await expect(Git.revParse(repo, 'MERGE_HEAD')).rejects.toThrow();
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(originalHead);
  });

  it('reverts the merge and escalates with the failing output when the post-merge check goes red', async () => {
    const repo = makeRepo();
    await makeTaskBranch(repo, 'task-red', (wt) => {
      writeFileSync(join(wt, 'feature.txt'), 'feature\n');
    });

    const deps: MergePolicyDeps = {
      resolveConflictTurn: neverCalled('resolveConflictTurn'),
      runPostMergeCheck: vi.fn(async () => ({ pass: false, output: 'BOOM tests failed' })),
      escalate: vi.fn(async () => {}),
    };

    const outcome = await runMergePolicy(
      { baseDir: repo, baseBranch: 'main', taskBranch: 'task-red', conflictResolveTurns: 2, postMergeCheck: true },
      deps,
    );

    expect(outcome.kind).toBe('escalated');
    if (outcome.kind !== 'escalated') throw new Error('unreachable');
    expect(outcome.reason).toBe('post-merge-red');
    expect(outcome.revertOid).toBeTruthy();
    expect(deps.escalate).toHaveBeenCalledTimes(1);
    expect(deps.escalate).toHaveBeenCalledWith(expect.stringContaining('BOOM tests failed'));

    // The revert undid the merge: the task's file is gone from the base tip.
    expect(() => git(repo, 'show', 'HEAD:feature.txt')).toThrow();
  });

  it('skips the post-merge check when postMergeCheck is false', async () => {
    const repo = makeRepo();
    await makeTaskBranch(repo, 'task-no-check', (wt) => {
      writeFileSync(join(wt, 'feature.txt'), 'feature\n');
    });

    const deps: MergePolicyDeps = {
      resolveConflictTurn: neverCalled('resolveConflictTurn'),
      runPostMergeCheck: neverCalled('runPostMergeCheck'),
      escalate: vi.fn(async () => {}),
    };

    const outcome = await runMergePolicy(
      { baseDir: repo, baseBranch: 'main', taskBranch: 'task-no-check', conflictResolveTurns: 2, postMergeCheck: false },
      deps,
    );

    expect(outcome.kind).toBe('merged');
    expect(deps.runPostMergeCheck).not.toHaveBeenCalled();
    expect(deps.escalate).not.toHaveBeenCalled();
    expect(git(repo, 'rev-parse', 'HEAD^2')).toBeTruthy();
  });

  it('resolves a multi-file conflict across two turns, re-reading the remaining conflicts each turn', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'a.txt'), 'shared a\n');
    writeFileSync(join(repo, 'c.txt'), 'shared c\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'add shared files');

    await makeTaskBranch(repo, 'task-multi-conflict', (wt) => {
      writeFileSync(join(wt, 'a.txt'), 'task a\n');
      writeFileSync(join(wt, 'c.txt'), 'task c\n');
    });
    writeFileSync(join(repo, 'a.txt'), 'main a\n');
    writeFileSync(join(repo, 'c.txt'), 'main c\n');
    git(repo, 'commit', '-am', 'main edits a.txt and c.txt');

    const resolveConflictTurn = vi.fn(async (ctx) => {
      if (ctx.turn === 1) {
        writeFileSync(join(ctx.baseDir, 'a.txt'), 'resolved a\n');
        git(ctx.baseDir, 'add', 'a.txt');
      } else {
        expect(ctx.unmergedPaths).toEqual(['c.txt']);
        writeFileSync(join(ctx.baseDir, 'c.txt'), 'resolved c\n');
        git(ctx.baseDir, 'add', 'c.txt');
      }
    });
    const deps: MergePolicyDeps = {
      resolveConflictTurn,
      runPostMergeCheck: vi.fn(async () => ({ pass: true, output: '' })),
      escalate: vi.fn(async () => {}),
    };

    const outcome = await runMergePolicy(
      { baseDir: repo, baseBranch: 'main', taskBranch: 'task-multi-conflict', conflictResolveTurns: 2, postMergeCheck: true },
      deps,
    );

    expect(outcome.kind).toBe('merged');
    expect(resolveConflictTurn).toHaveBeenCalledTimes(2);
    expect(deps.escalate).not.toHaveBeenCalled();
    expect(git(repo, 'rev-parse', 'HEAD^2')).toBeTruthy();
  });

  it('throws on a non-conflict merge fault without escalating', async () => {
    const repo = makeRepo();
    await makeTaskBranch(repo, 'task-dirty-base', (wt) => {
      writeFileSync(join(wt, 'base.txt'), 'task version\n');
    });
    // Dirty, uncommitted local change to base.txt: `git merge --no-ff` refuses
    // before starting a merge ("local changes would be overwritten") — a
    // non-conflict fault, no MERGE_HEAD is ever created.
    writeFileSync(join(repo, 'base.txt'), 'dirty uncommitted\n');

    const deps: MergePolicyDeps = {
      resolveConflictTurn: neverCalled('resolveConflictTurn'),
      runPostMergeCheck: neverCalled('runPostMergeCheck'),
      escalate: vi.fn(async () => {}),
    };

    await expect(
      runMergePolicy(
        { baseDir: repo, baseBranch: 'main', taskBranch: 'task-dirty-base', conflictResolveTurns: 2, postMergeCheck: true },
        deps,
      ),
    ).rejects.toThrow();

    expect(deps.escalate).not.toHaveBeenCalled();
    await expect(Git.revParse(repo, 'MERGE_HEAD')).rejects.toThrow();
  });

  it('serialises two concurrent merges into the same base repo under one mutex', async () => {
    const repo = makeRepo();
    await makeTaskBranch(repo, 'task-1', (wt) => {
      writeFileSync(join(wt, 'a.txt'), 'a\n');
    });
    await makeTaskBranch(repo, 'task-2', (wt) => {
      writeFileSync(join(wt, 'b.txt'), 'b\n');
    });

    let active = 0;
    let maxActive = 0;
    const runPostMergeCheck = vi.fn(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(active).toBeLessThanOrEqual(1);
      active--;
      return { pass: true, output: '' };
    });
    const deps: MergePolicyDeps = {
      resolveConflictTurn: neverCalled('resolveConflictTurn'),
      runPostMergeCheck,
      escalate: vi.fn(async () => {}),
    };

    const [outcome1, outcome2] = await Promise.all([
      runMergePolicy(
        { baseDir: repo, baseBranch: 'main', taskBranch: 'task-1', conflictResolveTurns: 0, postMergeCheck: true },
        deps,
      ),
      runMergePolicy(
        { baseDir: repo, baseBranch: 'main', taskBranch: 'task-2', conflictResolveTurns: 0, postMergeCheck: true },
        deps,
      ),
    ]);

    expect(outcome1.kind).toBe('merged');
    expect(outcome2.kind).toBe('merged');
    expect(maxActive).toBe(1);
    expect(runPostMergeCheck).toHaveBeenCalledTimes(2);
  });
});
