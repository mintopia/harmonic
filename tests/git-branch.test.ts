import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Git } from '../src/execution/git.js';

const raw = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

/** A throwaway git repo on branch main with one committed README. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harmonic-gitbranch-'));
  execFileSync('git', ['init', '-b', 'main', dir], { encoding: 'utf8' });
  raw(dir, 'config', 'user.name', 'Test');
  raw(dir, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(dir, 'README.md'), '# repo\n');
  raw(dir, 'add', '-A');
  raw(dir, 'commit', '-m', 'init');
  return dir;
}

describe('Git branch primitives (issue #159)', () => {
  it('branchExists is true for a real branch, false for an absent one — never throws', async () => {
    const dir = makeRepo();
    try {
      expect(await Git.branchExists(dir, 'main')).toBe(true);
      expect(await Git.branchExists(dir, 'epic/42')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('createBranch cuts a bare ref from a start point without checking it out', async () => {
    const dir = makeRepo();
    try {
      await Git.createBranch(dir, 'epic/42', 'main');
      expect(await Git.branchExists(dir, 'epic/42')).toBe(true);
      // Cut from main's tip.
      expect(raw(dir, 'rev-parse', 'epic/42')).toBe(raw(dir, 'rev-parse', 'main'));
      // HEAD was never switched — the working tree is still on main.
      expect(await Git.currentBranch(dir)).toBe('main');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('createBranch fails when the branch already exists (guard with branchExists)', async () => {
    const dir = makeRepo();
    try {
      await Git.createBranch(dir, 'epic/42', 'main');
      await expect(Git.createBranch(dir, 'epic/42', 'main')).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('deleteBranch removes a branch', async () => {
    const dir = makeRepo();
    try {
      await Git.createBranch(dir, 'epic/42', 'main');
      await Git.deleteBranch(dir, 'epic/42');
      expect(await Git.branchExists(dir, 'epic/42')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Git.isContentContained (issue #218)', () => {
  it('is true when the branch is an ancestor (merge-merged)', async () => {
    const dir = makeRepo();
    try {
      raw(dir, 'checkout', '-b', 'feature');
      writeFileSync(join(dir, 'f.txt'), 'a\n');
      raw(dir, 'add', '-A');
      raw(dir, 'commit', '-m', 'feat');
      raw(dir, 'checkout', 'main');
      raw(dir, 'merge', '--ff-only', 'feature');
      expect(await Git.isAncestor(dir, 'main', 'feature')).toBe(true);
      expect(await Git.isContentContained(dir, 'main', 'feature')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is true when the content is squash-merged but the tip is NOT an ancestor', async () => {
    const dir = makeRepo();
    try {
      raw(dir, 'checkout', '-b', 'feature');
      writeFileSync(join(dir, 'f.txt'), 'a\n');
      raw(dir, 'add', '-A');
      raw(dir, 'commit', '-m', 'feat 1');
      writeFileSync(join(dir, 'f.txt'), 'a\nb\n');
      raw(dir, 'add', '-A');
      raw(dir, 'commit', '-m', 'feat 2');
      raw(dir, 'checkout', 'main');
      // Squash-merge: the same net content as a single unrelated commit.
      writeFileSync(join(dir, 'f.txt'), 'a\nb\n');
      raw(dir, 'add', '-A');
      raw(dir, 'commit', '-m', 'squash of feature');
      expect(await Git.isAncestor(dir, 'main', 'feature')).toBe(false); // tier 1 misses it
      expect(await Git.isContentContained(dir, 'main', 'feature')).toBe(true); // tier 2 catches it
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is false when the branch adds net-new content not in the default branch', async () => {
    const dir = makeRepo();
    try {
      raw(dir, 'checkout', '-b', 'feature');
      writeFileSync(join(dir, 'g.txt'), 'new\n');
      raw(dir, 'add', '-A');
      raw(dir, 'commit', '-m', 'feat');
      raw(dir, 'checkout', 'main');
      expect(await Git.isContentContained(dir, 'main', 'feature')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is false on a merge conflict (divergent edits) — never throws', async () => {
    const dir = makeRepo();
    try {
      raw(dir, 'checkout', '-b', 'feature');
      writeFileSync(join(dir, 'README.md'), '# feat\n');
      raw(dir, 'add', '-A');
      raw(dir, 'commit', '-m', 'feat edit');
      raw(dir, 'checkout', 'main');
      writeFileSync(join(dir, 'README.md'), '# main\n');
      raw(dir, 'add', '-A');
      raw(dir, 'commit', '-m', 'main edit');
      expect(await Git.isContentContained(dir, 'main', 'feature')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
