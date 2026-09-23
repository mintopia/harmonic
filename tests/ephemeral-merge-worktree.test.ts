import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sweepStaleMergeWorktrees } from '../src/execution/ephemeral-merge-worktree.js';

const tmpDirs: string[] = [];

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harmonic-sweep-repo-'));
  tmpDirs.push(dir);
  execFileSync('git', ['init', '-b', 'main', dir], { encoding: 'utf8' });
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(dir, 'README.md'), '# repo\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'init');
  return dir;
}

/** Simulate a process killed mid-merge: a `harmonic-merge-*` admin worktree
 * registered in git and present on disk, with no cleanup ever having run. */
function leaveStaleMergeWorktree(repo: string): { tempDir: string; adminPath: string } {
  const tempDir = mkdtempSync(join(tmpdir(), 'harmonic-merge-'));
  tmpDirs.push(tempDir);
  const adminPath = join(tempDir, 'admin');
  git(repo, 'worktree', 'add', '--detach', adminPath, 'HEAD');
  return { tempDir, adminPath };
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('sweepStaleMergeWorktrees', () => {
  it('removes a harmonic-merge-* admin worktree left by a killed process', async () => {
    const repo = makeRepo();
    const { tempDir, adminPath } = leaveStaleMergeWorktree(repo);
    expect(git(repo, 'worktree', 'list', '--porcelain')).toContain(adminPath);

    const removed = await sweepStaleMergeWorktrees(repo);

    expect(removed).toEqual([adminPath]);
    expect(existsSync(adminPath)).toBe(false);
    expect(existsSync(tempDir)).toBe(false);
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain(adminPath);
  });

  it('leaves unrelated worktrees alone', async () => {
    const repo = makeRepo();
    const managed = mkdtempSync(join(tmpdir(), 'harmonic-managed-'));
    tmpDirs.push(managed);
    const managedPath = join(managed, 'task-1');
    mkdirSync(managed, { recursive: true });
    git(repo, 'worktree', 'add', '--detach', managedPath, 'HEAD');

    const removed = await sweepStaleMergeWorktrees(repo);

    expect(removed).toEqual([]);
    expect(existsSync(managedPath)).toBe(true);
    expect(git(repo, 'worktree', 'list', '--porcelain')).toContain(managedPath);
  });

  it('reports no removals when nothing is stale', async () => {
    const repo = makeRepo();
    await expect(sweepStaleMergeWorktrees(repo)).resolves.toEqual([]);
  });
});
