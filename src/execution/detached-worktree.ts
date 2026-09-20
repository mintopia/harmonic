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
