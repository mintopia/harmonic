import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { landBranch } from '../src/execution/branch-landing.js';
import { Git } from '../src/execution/git.js';

/**
 * Journaled crash-idempotent branch landing (issue #153, reliability-design
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

/** A throwaway git repo on branch main with one committed README. */
function makeRepo(): string {
  const dir = tmpPath('harmonic-land-repo-');
  execFileSync('git', ['init', '-b', 'main', dir], { encoding: 'utf8' });
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
  const wt = join(tmpPath('harmonic-land-wt-'), 'wt');
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

describe('branch landing (issue #153)', () => {
  it('AC1 (not checked out): lands via CAS ref-update, leaving the base repo pristine and no admin worktree behind', async () => {
    const repo = makeRepo();
    const base = oid(repo, 'main');
    makeBranchAhead(repo, 'feat', 'feat.txt', 'work\n');
    const featTip = oid(repo, 'feat');
    // Detach the base repo's HEAD so `main` is checked out by nobody.
    git(repo, 'checkout', '--detach', 'main');

    const out = await landBranch({ repoDir: repo, baseBranch: 'main', branch: 'feat' });

    expect(out).toMatchObject({ ok: true, mode: 'cas' });
    expect(oid(repo, 'main')).toBe(featTip); // fast-forwarded to feat
    expect(oid(repo, 'main')).not.toBe(base);
    // No live checkout was touched, no admin worktree lingered.
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(worktreeCount(repo)).toBe(1);
  });

  it('AC1 (checked out, clean, leased): lands coherently in place — HEAD stays on the branch, tree advances, status clean', async () => {
    const repo = makeRepo(); // main is checked out here
    makeBranchAhead(repo, 'feat', 'feat.txt', 'work\n');
    const featTip = oid(repo, 'feat');

    const out = await landBranch({ repoDir: repo, baseBranch: 'main', branch: 'feat', leaseHeld: true });

    expect(out).toMatchObject({ ok: true, mode: 'in-place' });
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main'); // still on main, not desynced
    expect(oid(repo, 'main')).toBe(featTip);
    expect(git(repo, 'show', 'HEAD:feat.txt')).toBe('work'); // working tree coherent
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(worktreeCount(repo)).toBe(1);
  });

  it('AC5 (checked out, no lease): falls back to PR/manual rather than a desyncing ref-update', async () => {
    const repo = makeRepo();
    makeBranchAhead(repo, 'feat', 'feat.txt', 'work\n');
    const base = oid(repo, 'main');

    const out = await landBranch({ repoDir: repo, baseBranch: 'main', branch: 'feat' }); // leaseHeld defaults false

    expect(out).toMatchObject({ ok: false, reason: 'fallback-pr-manual' });
    expect(oid(repo, 'main')).toBe(base); // target untouched
    expect(worktreeCount(repo)).toBe(1);
  });

  it('AC5 (checked out, dirty): a lease is held but the checkout has uncommitted work — falls back rather than clobber it', async () => {
    const repo = makeRepo();
    makeBranchAhead(repo, 'feat', 'feat.txt', 'work\n');
    const base = oid(repo, 'main');
    writeFileSync(join(repo, 'operator-wip.txt'), 'uncommitted operator work\n');

    const out = await landBranch({ repoDir: repo, baseBranch: 'main', branch: 'feat', leaseHeld: true });

    expect(out).toMatchObject({ ok: false, reason: 'fallback-pr-manual' });
    expect(oid(repo, 'main')).toBe(base);
    // The operator's uncommitted file is untouched.
    expect(git(repo, 'status', '--porcelain')).toContain('operator-wip.txt');
  });

  it('conflict: aborts in the admin worktree, returns ok:false, and never enters the live checkout', async () => {
    const repo = makeRepo();
    // feat forks from the original README and changes it one way...
    makeBranchAhead(repo, 'feat', 'README.md', '# from feat\n');
    // ...while main moves and changes the same file another way (in place).
    writeFileSync(join(repo, 'README.md'), '# from main\n');
    git(repo, 'commit', '-am', 'main diverges');
    const mainTip = oid(repo, 'main');

    const out = await landBranch({ repoDir: repo, baseBranch: 'main', branch: 'feat', leaseHeld: true });

    expect(out).toMatchObject({ ok: false, reason: 'conflict' });
    expect(oid(repo, 'main')).toBe(mainTip); // untouched
    expect(git(repo, 'status', '--porcelain')).toBe(''); // base repo pristine — abort happened off to the side
    expect(worktreeCount(repo)).toBe(1);
  });

  it('AC3 idempotent (not checked out): re-landing an already-merged branch is a no-op, not a duplicate merge', async () => {
    const repo = makeRepo();
    makeBranchAhead(repo, 'feat', 'feat.txt', 'work\n');
    git(repo, 'checkout', '--detach', 'main');

    const first = await landBranch({ repoDir: repo, baseBranch: 'main', branch: 'feat' });
    expect(first.ok).toBe(true);
    const afterFirst = oid(repo, 'main');
    const countAfterFirst = git(repo, 'rev-list', '--count', 'main');

    const second = await landBranch({ repoDir: repo, baseBranch: 'main', branch: 'feat' });
    expect(second).toMatchObject({ ok: true, mode: 'cas' });
    expect(oid(repo, 'main')).toBe(afterFirst); // did not move
    expect(git(repo, 'rev-list', '--count', 'main')).toBe(countAfterFirst); // no new commit
    expect(await Git.isAncestor(repo, 'main', 'feat')).toBe(true);
  });

  it('AC3 (hand-merge in between): a branch merged by hand while landing was underway is preserved, not overwritten', async () => {
    const repo = makeRepo();
    makeBranchAhead(repo, 'feat', 'feat.txt', 'work\n');
    git(repo, 'checkout', '--detach', 'main');
    // Operator hand-merges feat into main before Harmonic's land applies.
    const handTip = oid(repo, 'feat');
    git(repo, 'update-ref', 'refs/heads/main', handTip);

    const out = await landBranch({ repoDir: repo, baseBranch: 'main', branch: 'feat' });

    expect(out).toMatchObject({ ok: true, mode: 'cas' });
    expect(oid(repo, 'main')).toBe(handTip); // the hand-merge stands
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
    expect(oid(repo, 'main')).toBe(featTip); // NOT overwritten
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
    expect(oid(repo, 'main')).toBe(mainTip); // not moved
    expect(git(repo, 'status', '--porcelain')).toBe(''); // checkout coherent
  });

  it('branchCheckedOutAt distinguishes a checked-out target from a detached / absent one', async () => {
    const repo = makeRepo();
    expect(await Git.branchCheckedOutAt(repo, 'main')).toBe(git(repo, 'rev-parse', '--show-toplevel'));
    git(repo, 'checkout', '--detach', 'main');
    expect(await Git.branchCheckedOutAt(repo, 'main')).toBeNull();
  });
});
