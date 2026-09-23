import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Git } from './git.js';
import { forEachYielding } from '../reliability/yield.js';
import { logger } from '../logger.js';
import { errorMessage } from '../error-handling.js';

const MERGE_WORKTREE_PREFIX = 'harmonic-merge-';

export interface EphemeralMergeWorktreeArgs {
  repoDir: string;
  baseTipOid: string;
  parentDir?: string;
  onRemoveError?: (args: { error: unknown; worktreeDir: string }) => void;
}

export async function withEphemeralMergeWorktree<T>(
  { repoDir, baseTipOid, parentDir, onRemoveError }: EphemeralMergeWorktreeArgs,
  run: (worktreeDir: string) => Promise<T>,
): Promise<T> {
  const tempDir = mkdtempSync(join(parentDir ?? tmpdir(), MERGE_WORKTREE_PREFIX));
  const worktreeDir = join(tempDir, 'admin');
  try {
    await Git.addDetachedWorktree(repoDir, worktreeDir, baseTipOid);
    return await run(worktreeDir);
  } finally {
    try {
      await Git.removeWorktree(repoDir, worktreeDir);
    } catch (error) {
      try {
        onRemoveError?.({ error, worktreeDir });
      } catch {
        // Diagnostics must not mask the operation result or stop cleanup.
      }
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export interface SweepStaleMergeWorktreesDeps {
  listWorktrees: typeof Git.listWorktrees;
  removeWorktree: typeof Git.removeWorktree;
  pruneWorktrees: typeof Git.pruneWorktrees;
}

const DEFAULT_STALE_AFTER_MS = 60 * 60 * 1000;

export interface SweepStaleMergeWorktreesOptions {
  /** Only sweep a worktree whose temp dir is at least this old. Default 1h: merges/retirements finish in seconds, but several Harmonic processes on one host can share a repo, so a dir this fresh may still be a live merge in another process. */
  olderThanMs?: number;
  now?: () => number;
}

/** Remove `harmonic-merge-*` admin worktrees left by a process that died before {@link withEphemeralMergeWorktree}'s `finally` ran. */
export async function sweepStaleMergeWorktrees(
  repoDir: string,
  deps: SweepStaleMergeWorktreesDeps = Git,
  options: SweepStaleMergeWorktreesOptions = {},
): Promise<string[]> {
  const olderThanMs = options.olderThanMs ?? DEFAULT_STALE_AFTER_MS;
  const now = options.now ?? Date.now;
  const worktrees = await deps.listWorktrees(repoDir);
  const removed: string[] = [];
  await forEachYielding(worktrees, async (worktree) => {
    const path = resolve(worktree.path);
    const tempDir = dirname(path);
    if (basename(path) !== 'admin' || !basename(tempDir).startsWith(MERGE_WORKTREE_PREFIX)) return;
    // tempDir's mtime, not admin's, is stable (set once at mkdtempSync; admin's own mtime moves on some writes).
    const stat = statSync(tempDir, { throwIfNoEntry: false });
    if (stat !== undefined && now() - stat.mtimeMs < olderThanMs) return;
    await deps.removeWorktree(repoDir, path).catch((error) => {
      logger.warn('merge-worktree sweep: git worktree remove failed, deleting the directory and pruning instead', {
        path,
        error: errorMessage(error),
      });
    });
    rmSync(tempDir, { recursive: true, force: true });
    removed.push(path);
  });
  if (removed.length > 0) await deps.pruneWorktrees(repoDir);
  return removed;
}
