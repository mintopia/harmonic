import { describe, it, expect, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultBranchPostMerge, mergeIntoBase, mergeIntoBaseAndRunPostMerge, resolveRepositoryDefaultBranch } from '../src/execution/branch-merge.js';
import { Git } from '../src/execution/git.js';

/**
 * Journaled crash-idempotent branch merging (issue #153, reliability-design
 * Unit D). Every case runs against a throwaway git repo, exercising the
 * admin-worktree + CAS operation directly — no server, no DB.
 */

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

const tmpDirs: string[] = [];
const tmpPath = (prefix: string) => {
  const p = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(p);
  return p;
};

/** A throwaway git repo on `branch` (default main) with one committed README. */
function makeRepo(branch = 'main'): string {
  const dir = tmpPath('harmonic-merge-repo-');
  execFileSync('git', ['init', '-b', branch, dir], { encoding: 'utf8' });
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(dir, 'README.md'), '# repo\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'init');
  return dir;
}

/** Create `branch` off `from`, add a commit touching `file`, without disturbing
 * the base repo's own checkout (built in a disposable worktree, then removed). */
function makeBranchAhead(repo: string, branch: string, file: string, content: string, from = 'main'): void {
  const wt = join(tmpPath('harmonic-merge-wt-'), 'wt');
  git(repo, 'worktree', 'add', '-b', branch, wt, from);
  writeFileSync(join(wt, file), content);
  git(wt, 'add', '-A');
  git(wt, 'commit', '-m', `add ${file} on ${branch}`);
  git(repo, 'worktree', 'remove', '--force', wt);
}

const oid = (dir: string, rev: string) => git(dir, 'rev-parse', rev);
const worktreeCount = (dir: string) => git(dir, 'worktree', 'list').split('\n').filter(Boolean).length;

afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe('branch merging (issue #153)', () => {
  it('runs the shared post-merge hook after a successful merge', async () => {
    const repo = makeRepo();
    makeBranchAhead(repo, 'feat', 'feat.txt', 'work\n');
    const refreshAfterDefaultBranchAdvance = vi.fn<(repoDir: string, defaultBranch: string) => Promise<void>>(async () => {});

    await expect(mergeIntoBaseAndRunPostMerge(
      { repoDir: repo, baseBranch: 'main', branch: 'feat', expectedOid: oid(repo, 'feat'), mutexHeld: true },
      async ({ repoDir, baseBranch }) => refreshAfterDefaultBranchAdvance(repoDir, baseBranch),
    )).resolves.toMatchObject({ ok: true });

    expect(refreshAfterDefaultBranchAdvance).toHaveBeenCalledWith(repo, 'main');
  });

  it('does not refresh Epics when a merge targets a non-default base branch (real resolver)', async () => {
    const repo = makeRepo('develop'); // the base repo's live symbolic HEAD is develop
    makeBranchAhead(repo, 'feature-base', 'base.txt', 'base\n', 'develop');
    makeBranchAhead(repo, 'feat', 'feat.txt', 'work\n', 'feature-base');
    const refreshAfterDefaultBranchAdvance = vi.fn<(repoDir: string, defaultBranch: string) => Promise<void>>(async () => {});
    const postMerge = defaultBranchPostMerge(refreshAfterDefaultBranchAdvance);

    await expect(mergeIntoBaseAndRunPostMerge(
      { repoDir: repo, baseBranch: 'feature-base', branch: 'feat', expectedOid: oid(repo, 'feat') },
      postMerge,
    )).resolves.toMatchObject({ ok: true });

    expect(refreshAfterDefaultBranchAdvance).not.toHaveBeenCalled();
  });

  it('refreshes on a default-branch merge even when invoked from a task checkout parked on another branch (real resolver)', async () => {
    const repo = makeRepo('develop');
    makeBranchAhead(repo, 'feat', 'feat.txt', 'work\n', 'develop');
    // A direct-mode merge runs from the task's own checkout, parked on the task
    // branch — resolving the default there would compare task-branch to
    // task-branch and fire on every merge. The threaded `baseRepoDir` makes the
    // hook resolve against the base repo's symbolic HEAD instead.
    const taskCheckout = join(tmpPath('harmonic-merge-task-'), 'checkout');
    git(repo, 'worktree', 'add', '-b', 'task-branch', taskCheckout, 'develop');
    const refreshAfterDefaultBranchAdvance = vi.fn<(repoDir: string, defaultBranch: string) => Promise<void>>(async () => {});
    const postMerge = defaultBranchPostMerge(refreshAfterDefaultBranchAdvance);

    await expect(mergeIntoBaseAndRunPostMerge(
      { repoDir: taskCheckout, baseRepoDir: repo, baseBranch: 'develop', branch: 'feat', expectedOid: oid(repo, 'feat'), mutexHeld: true },
      postMerge,
    )).resolves.toMatchObject({ ok: true });

    expect(refreshAfterDefaultBranchAdvance).toHaveBeenCalledTimes(1);
    expect(refreshAfterDefaultBranchAdvance).toHaveBeenCalledWith(repo, 'develop');
  });

  it('resolveRepositoryDefaultBranch reads the base repo symbolic HEAD, falling back to origin/HEAD when detached', async () => {
    const repo = makeRepo('develop');
    await expect(resolveRepositoryDefaultBranch(repo)).resolves.toBe('develop');

    git(repo, 'checkout', '--detach');
    await expect(resolveRepositoryDefaultBranch(repo)).resolves.toBeNull();

    git(repo, 'update-ref', 'refs/remotes/origin/develop', 'develop');
    git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop');
    await expect(resolveRepositoryDefaultBranch(repo)).resolves.toBe('develop');
  });

  it('AC1 (not checked out): merges via CAS ref-update, leaving the base repo pristine and no admin worktree behind', async () => {
    const repo = makeRepo();
    const base = oid(repo, 'main');
    makeBranchAhead(repo, 'feat', 'feat.txt', 'work\n');
    const featTip = oid(repo, 'feat');
    // Detach the base repo's HEAD so `main` is checked out by nobody.
    git(repo, 'checkout', '--detach', 'main');

    const out = await mergeIntoBase({ repoDir: repo, baseBranch: 'main', branch: 'feat', expectedOid: oid(repo, 'feat') });

    expect(out).toMatchObject({ ok: true, mode: 'cas' });
    expect(oid(repo, 'main')).toBe(featTip);
    expect(oid(repo, 'main')).not.toBe(base);
    // No live checkout was touched, no admin worktree lingered.
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(worktreeCount(repo)).toBe(1);
  });

  it('AC1 (checked out, clean, mutex held): merges coherently in place — HEAD stays on the branch, tree advances, status clean', async () => {
    const repo = makeRepo();
    makeBranchAhead(repo, 'feat', 'feat.txt', 'work\n');
    const featTip = oid(repo, 'feat');

    const out = await mergeIntoBase({ repoDir: repo, baseBranch: 'main', branch: 'feat', expectedOid: oid(repo, 'feat'), mutexHeld: true });

    expect(out).toMatchObject({ ok: true, mode: 'in-place' });
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(oid(repo, 'main')).toBe(featTip);
    expect(git(repo, 'show', 'HEAD:feat.txt')).toBe('work');
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(worktreeCount(repo)).toBe(1);
  });

  it('AC5 (checked out, no mutex): falls back to PR/manual rather than a desyncing ref-update', async () => {
    const repo = makeRepo();
    makeBranchAhead(repo, 'feat', 'feat.txt', 'work\n');
    const base = oid(repo, 'main');

    const out = await mergeIntoBase({ repoDir: repo, baseBranch: 'main', branch: 'feat', expectedOid: oid(repo, 'feat') }); // mutexHeld defaults false

    expect(out).toMatchObject({ ok: false, reason: 'fallback-pr-manual' });
    expect(oid(repo, 'main')).toBe(base);
    expect(worktreeCount(repo)).toBe(1);
  });

  it('AC5 (checked out, dirty): the mutex is held but the checkout has uncommitted work — falls back rather than clobber it', async () => {
    const repo = makeRepo();
    makeBranchAhead(repo, 'feat', 'feat.txt', 'work\n');
    const base = oid(repo, 'main');
    writeFileSync(join(repo, 'operator-wip.txt'), 'uncommitted operator work\n');

    const out = await mergeIntoBase({ repoDir: repo, baseBranch: 'main', branch: 'feat', expectedOid: oid(repo, 'feat'), mutexHeld: true });

    expect(out).toMatchObject({ ok: false, reason: 'fallback-pr-manual' });
    expect(oid(repo, 'main')).toBe(base);
    // The operator's uncommitted file is untouched.
    expect(git(repo, 'status', '--porcelain')).toContain('operator-wip.txt');
  });

  it('stale-base (default fast-forward mode): a base that advanced after verification is refused, nothing merged, nothing touched', async () => {
    const repo = makeRepo();
    makeBranchAhead(repo, 'feat', 'feat.txt', 'verified work\n');
    // main moves after verification — even a non-conflicting advance is a tree
    // nobody verified, so the merge refuses instead of merging.
    writeFileSync(join(repo, 'README.md'), '# main advanced\n');
    git(repo, 'commit', '-am', 'main advances');
    const mainTip = oid(repo, 'main');

    const out = await mergeIntoBase({ repoDir: repo, baseBranch: 'main', branch: 'feat', expectedOid: oid(repo, 'feat'), mutexHeld: true });

    expect(out).toMatchObject({ ok: false, reason: 'stale-base' });
    expect(oid(repo, 'main')).toBe(mainTip);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(worktreeCount(repo)).toBe(1);
  });

  it('merge mode: a diverged, non-conflicting base is folded in with a merge commit (integration refresh)', async () => {
    const repo = makeRepo();
    makeBranchAhead(repo, 'feat', 'feat.txt', 'work\n');
    writeFileSync(join(repo, 'README.md'), '# main advanced\n');
    git(repo, 'commit', '-am', 'main advances');
    const featTip = oid(repo, 'feat');

    const out = await mergeIntoBase({ repoDir: repo, baseBranch: 'main', branch: 'feat', expectedOid: featTip, mode: 'merge', mutexHeld: true });

    expect(out).toMatchObject({ ok: true, mode: 'in-place' });
    expect(git(repo, 'rev-parse', 'main^2')).toBe(featTip); // a real merge commit whose second parent is the verified tip
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(worktreeCount(repo)).toBe(1);
  });

  it('merge mode conflict: aborts in the admin worktree, returns ok:false, and never enters the live checkout', async () => {
    const repo = makeRepo();
    // feat forks from the original README and changes it one way...
    makeBranchAhead(repo, 'feat', 'README.md', '# from feat\n');
    // ...while main moves and changes the same file another way (in place).
    writeFileSync(join(repo, 'README.md'), '# from main\n');
    git(repo, 'commit', '-am', 'main diverges');
    const mainTip = oid(repo, 'main');

    const out = await mergeIntoBase({ repoDir: repo, baseBranch: 'main', branch: 'feat', expectedOid: oid(repo, 'feat'), mode: 'merge', mutexHeld: true });

    expect(out).toMatchObject({ ok: false, reason: 'conflict' });
    expect(oid(repo, 'main')).toBe(mainTip);
    expect(git(repo, 'status', '--porcelain')).toBe(''); // base repo pristine — abort happened off to the side
    expect(worktreeCount(repo)).toBe(1);
  });

  it('refuses a branch that moved after verification and never attempts the merge', async () => {
    const repo = makeRepo();
    makeBranchAhead(repo, 'feat', 'feat.txt', 'verified work\n');
    const verifiedOid = oid(repo, 'feat');
    makeBranchAhead(repo, 'later', 'later.txt', 'later work\n', 'feat');
    git(repo, 'update-ref', 'refs/heads/feat', 'later');
    const mainBefore = oid(repo, 'main');

    await expect(mergeIntoBase({
      repoDir: repo,
      baseBranch: 'main',
      branch: 'feat',
      expectedOid: verifiedOid,
      mutexHeld: true,
    })).resolves.toMatchObject({ ok: false, reason: 'stale-head' });
    expect(oid(repo, 'main')).toBe(mainBefore);
  });

  it('AC3 idempotent (not checked out): re-merging an already-merged branch is a no-op, not a duplicate merge', async () => {
    const repo = makeRepo();
    makeBranchAhead(repo, 'feat', 'feat.txt', 'work\n');
    git(repo, 'checkout', '--detach', 'main');

    const first = await mergeIntoBase({ repoDir: repo, baseBranch: 'main', branch: 'feat', expectedOid: oid(repo, 'feat') });
    expect(first.ok).toBe(true);
    const afterFirst = oid(repo, 'main');
    const countAfterFirst = git(repo, 'rev-list', '--count', 'main');

    const second = await mergeIntoBase({ repoDir: repo, baseBranch: 'main', branch: 'feat', expectedOid: oid(repo, 'feat') });
    expect(second).toMatchObject({ ok: true, mode: 'cas' });
    expect(oid(repo, 'main')).toBe(afterFirst);
    expect(git(repo, 'rev-list', '--count', 'main')).toBe(countAfterFirst);
    expect(await Git.isAncestor(repo, 'main', 'feat')).toBe(true);
  });

  it('AC3 (hand-merge in between): a branch merged by hand while merging was underway is preserved, not overwritten', async () => {
    const repo = makeRepo();
    makeBranchAhead(repo, 'feat', 'feat.txt', 'work\n');
    git(repo, 'checkout', '--detach', 'main');
    // Operator hand-merges feat into main before Harmonic's merge applies.
    const handTip = oid(repo, 'feat');
    git(repo, 'update-ref', 'refs/heads/main', handTip);

    const out = await mergeIntoBase({ repoDir: repo, baseBranch: 'main', branch: 'feat', expectedOid: oid(repo, 'feat') });

    expect(out).toMatchObject({ ok: true, mode: 'cas' });
    expect(oid(repo, 'main')).toBe(handTip);
  });

  it('AC2 CAS primitive: an expected-old mismatch is rejected, the ref is not overwritten', async () => {
    const repo = makeRepo();
    const a = oid(repo, 'main');
    makeBranchAhead(repo, 'feat', 'feat.txt', 'work\n');
    const featTip = oid(repo, 'feat');

    // Correct expected-old advances the ref.
    const good = await Git.casUpdateRef(repo, 'main', featTip, a);
    expect(good.ok).toBe(true);
    expect(oid(repo, 'main')).toBe(featTip);

    // A stale expected-old (still `a`, but main is now featTip) is refused.
    makeBranchAhead(repo, 'other', 'other.txt', 'other\n', a);
    const otherTip = oid(repo, 'other');
    const stale = await Git.casUpdateRef(repo, 'main', otherTip, a);
    expect(stale.ok).toBe(false);
    expect(oid(repo, 'main')).toBe(featTip);
  });

  it('AC2 in-place CAS-via-ff: a target that diverged off the computed base is refused, not force-reset', async () => {
    const repo = makeRepo();
    const a = oid(repo, 'main');
    // A commit that is NOT a descendant of main's current tip.
    makeBranchAhead(repo, 'sidecar', 'side.txt', 'side\n', a);
    const sidecar = oid(repo, 'sidecar');
    // main diverges to its own new commit.
    writeFileSync(join(repo, 'README.md'), '# main advanced\n');
    git(repo, 'commit', '-am', 'main advances');
    const mainTip = oid(repo, 'main');

    const ff = await Git.ffOnly(repo, sidecar);
    expect(ff.ok).toBe(false);
    expect(oid(repo, 'main')).toBe(mainTip);
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('branchCheckedOutAt distinguishes a checked-out target from a detached / absent one', async () => {
    const repo = makeRepo();
    expect(await Git.branchCheckedOutAt(repo, 'main')).toBe(git(repo, 'rev-parse', '--show-toplevel'));
    git(repo, 'checkout', '--detach', 'main');
    expect(await Git.branchCheckedOutAt(repo, 'main')).toBeNull();
  });
});
