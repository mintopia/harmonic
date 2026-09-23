import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Git } from './git.js';
import { forEachYielding } from '../reliability/yield.js';

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
}

/**
 * Remove `harmonic-merge-*` admin worktrees left behind by a process that
 * died between {@link withEphemeralMergeWorktree} creating one and its
 * `finally` removing it. Intended to run once at boot, before any Attempt can
 * start a merge of its own: only a prior process could have left one of
 * these, since the normal exit paths (success, conflict, thrown error) always
 * clean up within the same call.
 */
export async function sweepStaleMergeWorktrees(
  repoDir: string,
  deps: SweepStaleMergeWorktreesDeps = Git,
): Promise<string[]> {
  const worktrees = await deps.listWorktrees(repoDir);
  const removed: string[] = [];
  await forEachYielding(worktrees, async (worktree) => {
    const path = resolve(worktree.path);
    const tempDir = dirname(path);
    if (basename(path) !== 'admin' || !basename(tempDir).startsWith(MERGE_WORKTREE_PREFIX)) return;
    await deps.removeWorktree(repoDir, path).catch(() => {});
    rmSync(tempDir, { recursive: true, force: true });
    removed.push(path);
  });
  return removed;
}
