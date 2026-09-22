import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Git } from './git.js';

/** Check out a fixed commit into a disposable detached worktree, run `fn`
 * against it, then remove the checkout. The worktree exists only for the
 * duration of `fn`. */
export async function withDetachedWorktree<T>(
  repoDir: string,
  oid: string,
  worktreePath: string,
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  await Git.addDetachedWorktree(repoDir, worktreePath, oid);
  try {
    return await fn(worktreePath);
  } finally {
    // Best-effort cleanup: `fn`'s own result/error already propagates above; a stray worktree left behind is a disk-space nit, not a caller-visible failure.
    await Git.removeWorktree(repoDir, worktreePath).catch(() => {});
  }
}

export async function withEphemeralMergeWorktree<T>(
  repoDir: string,
  baseTipOid: string,
  fn: (dir: string) => Promise<T>,
  parentDir = tmpdir(),
): Promise<T> {
  const parent = mkdtempSync(join(parentDir, 'harmonic-merge-'));
  const worktreePath = join(parent, 'admin');
  try {
    return await withDetachedWorktree(repoDir, baseTipOid, worktreePath, fn);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}
