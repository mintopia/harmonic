import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sweepStaleMergeWorktrees } from '../src/execution/ephemeral-merge-worktree.js';
import { Git } from '../src/execution/git.js';

const tmpDirs: string[] = [];
const HOUR_MS = 60 * 60 * 1000;

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

// `ageMs` backdates the temp dir's mtime (see ephemeral-merge-worktree.ts for why staleness is judged on it).
function leaveMergeWorktree(repo: string, ageMs = 0): { tempDir: string; adminPath: string } {
  const tempDir = mkdtempSync(join(tmpdir(), 'harmonic-merge-'));
  tmpDirs.push(tempDir);
  const adminPath = join(tempDir, 'admin');
  git(repo, 'worktree', 'add', '--detach', adminPath, 'HEAD');
  if (ageMs > 0) {
    const past = new Date(Date.now() - ageMs);
    utimesSync(tempDir, past, past);
  }
  return { tempDir, adminPath };
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('sweepStaleMergeWorktrees', () => {
  it('removes an admin worktree left by a killed process, older than the default 1h threshold', async () => {
    const repo = makeRepo();
    const { tempDir, adminPath } = leaveMergeWorktree(repo, 2 * HOUR_MS);
    expect(git(repo, 'worktree', 'list', '--porcelain')).toContain(adminPath);

    const removed = await sweepStaleMergeWorktrees(repo);

    expect(removed).toEqual([adminPath]);
    expect(existsSync(adminPath)).toBe(false);
    expect(existsSync(tempDir)).toBe(false);
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain(adminPath);
  });

  it('leaves a fresh admin worktree alone: it may be a live merge from another Harmonic process on the host', async () => {
    const repo = makeRepo();
    const { adminPath } = leaveMergeWorktree(repo);

    const removed = await sweepStaleMergeWorktrees(repo);

    expect(removed).toEqual([]);
    expect(existsSync(adminPath)).toBe(true);
    expect(git(repo, 'worktree', 'list', '--porcelain')).toContain(adminPath);
  });

  it('honours an injected threshold without needing to sleep', async () => {
    const repo = makeRepo();
    const { adminPath } = leaveMergeWorktree(repo);

    const removed = await sweepStaleMergeWorktrees(repo, Git, { olderThanMs: 0 });

    expect(removed).toEqual([adminPath]);
    expect(existsSync(adminPath)).toBe(false);
  });

  it('leaves unrelated worktrees alone', async () => {
    const repo = makeRepo();
    const managed = mkdtempSync(join(tmpdir(), 'harmonic-managed-'));
    tmpDirs.push(managed);
    const managedPath = join(managed, 'task-1');
    mkdirSync(managed, { recursive: true });
    git(repo, 'worktree', 'add', '--detach', managedPath, 'HEAD');

    const removed = await sweepStaleMergeWorktrees(repo, Git, { olderThanMs: 0 });

    expect(removed).toEqual([]);
    expect(existsSync(managedPath)).toBe(true);
    expect(git(repo, 'worktree', 'list', '--porcelain')).toContain(managedPath);
  });

  it('reports no removals when nothing is stale', async () => {
    const repo = makeRepo();
    await expect(sweepStaleMergeWorktrees(repo)).resolves.toEqual([]);
  });

  it('prunes the dangling git registration when removeWorktree itself fails', async () => {
    const repo = makeRepo();
    const { tempDir, adminPath } = leaveMergeWorktree(repo, 2 * HOUR_MS);

    const removed = await sweepStaleMergeWorktrees(repo, {
      listWorktrees: Git.listWorktrees,
      removeWorktree: async () => {
        throw new Error('simulated: git worktree remove failed');
      },
      pruneWorktrees: Git.pruneWorktrees,
    });

    expect(removed).toEqual([adminPath]);
    expect(existsSync(tempDir)).toBe(false);
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain(adminPath);
  });

  it('prunes a registration whose temp dir is already gone from disk', async () => {
    const repo = makeRepo();
    const { tempDir, adminPath } = leaveMergeWorktree(repo);
    rmSync(tempDir, { recursive: true, force: true });

    const removed = await sweepStaleMergeWorktrees(repo);

    expect(removed).toEqual([adminPath]);
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain(adminPath);
  });
});
