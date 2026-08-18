import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Git } from '../src/execution/git.js';

/**
 * `Git.rebaseOnto` (issue #160): linear replay of a checked-out branch onto an
 * arbitrary OID, with the same "abort-to-clean, return the conflict signal
 * rather than throw" contract as `mergeNoEdit`. Every case runs against a
 * throwaway git repo — no server, no DB.
 */

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

const tmpDirs: string[] = [];
const tmpPath = (prefix: string) => {
  const p = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(p);
  return p;
};

/** A throwaway git repo on branch main with one committed file. */
function makeRepo(): string {
  const dir = tmpPath('harmonic-rebase-repo-');
  execFileSync('git', ['init', '-b', 'main', dir], { encoding: 'utf8' });
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(dir, 'base.txt'), 'base\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'A: init base.txt');
  return dir;
}

/** Add a disposable worktree checking out `branch` (created off `from`). */
function addBranchWorktree(repo: string, branch: string, from = 'main'): string {
  const wt = join(tmpPath('harmonic-rebase-wt-'), 'wt');
  git(repo, 'worktree', 'add', '-b', branch, wt, from);
  return wt;
}

const oid = (dir: string, rev: string) => git(dir, 'rev-parse', rev);

afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe('Git.rebaseOnto (issue #160)', () => {
  it('clean rebase: replays the feature commit onto the moved base tip', async () => {
    const repo = makeRepo();
    // feature forks from A and adds commit B.
    const featureWt = addBranchWorktree(repo, 'feature');
    writeFileSync(join(featureWt, 'feature.txt'), 'feature work\n');
    git(featureWt, 'add', '-A');
    git(featureWt, 'commit', '-m', 'B: add feature.txt');

    // main advances independently with commit C (does not touch feature.txt).
    writeFileSync(join(repo, 'other.txt'), 'other\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'C: add other.txt on main');
    const baseTip = oid(repo, 'main');

    const out = await Git.rebaseOnto(featureWt, baseTip);

    expect(out).toMatchObject({ ok: true });
    if (!out.ok) throw new Error('expected ok:true');
    expect(out.rebasedTip).toBe(oid(featureWt, 'HEAD'));
    // HEAD is now a descendant of the base tip it was rebased onto.
    expect(await Git.isAncestor(featureWt, out.rebasedTip, baseTip)).toBe(true);
    // Both the base commit's and the feature commit's content are present.
    expect(git(featureWt, 'show', 'HEAD:other.txt')).toBe('other');
    expect(git(featureWt, 'show', 'HEAD:feature.txt')).toBe('feature work');
    // Worktree is clean, no rebase left in progress.
    expect(git(featureWt, 'status', '--porcelain')).toBe('');
    expect(await Git.isDirty(featureWt)).toBe(false);
  });

  it('conflict rebase: aborts and leaves the worktree clean, returning the conflict signal', async () => {
    const repo = makeRepo();
    // feature forks from A and changes base.txt one way.
    const featureWt = addBranchWorktree(repo, 'feature');
    writeFileSync(join(featureWt, 'base.txt'), 'feature version\n');
    git(featureWt, 'add', '-A');
    git(featureWt, 'commit', '-m', 'B: change base.txt on feature');
    const featureTipBefore = oid(featureWt, 'HEAD');

    // main changes the very same line a different way.
    writeFileSync(join(repo, 'base.txt'), 'main version\n');
    git(repo, 'commit', '-am', 'C: change base.txt on main');
    const baseTip = oid(repo, 'main');

    const out = await Git.rebaseOnto(featureWt, baseTip);

    expect(out).toMatchObject({ ok: false, conflict: true });
    expect('detail' in out && typeof out.detail).toBe('string');
    // The feature branch's own tip is untouched by the aborted rebase.
    expect(oid(featureWt, 'HEAD')).toBe(featureTipBefore);
    // Crucially: the abort ran, so the worktree is left clean.
    expect(git(featureWt, 'status', '--porcelain')).toBe('');
    expect(await Git.isDirty(featureWt)).toBe(false);
    // No rebase left in progress.
    expect(() => git(featureWt, 'rev-parse', '--verify', 'REBASE_HEAD')).toThrow();
  });
});
