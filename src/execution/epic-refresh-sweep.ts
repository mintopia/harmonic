import { basename, dirname, join, resolve } from 'node:path';
import { bestEffort } from '../error-handling.js';
import { forEachYielding } from '../reliability/yield.js';
import type { TrackerRef } from '../tracker/adapter.js';
import { Git } from './git.js';

const EPIC_REFRESH_WORKTREE_PREFIX = 'epic-refresh-';

export function epicRefreshWorktreePath(worktreesDir: string, epicRef: TrackerRef): string {
  return join(worktreesDir, `${EPIC_REFRESH_WORKTREE_PREFIX}${epicRef}`);
}

export interface SweepEpicRefreshWorktreesDeps {
  listWorktrees: typeof Git.listWorktrees;
  removeWorktree: typeof Git.removeWorktree;
  pruneWorktrees: typeof Git.pruneWorktrees;
}

/** Remove `epic-refresh-*` worktrees registered to `repoDir`; run only at boot, when no corrective turn can still be driving one. */
export async function sweepOrphanedEpicRefreshWorktrees(
  repoDir: string,
  worktreesDir: string,
  deps: SweepEpicRefreshWorktreesDeps = Git,
): Promise<string[]> {
  const root = resolve(worktreesDir);
  const removed: string[] = [];
  const registered = await deps.listWorktrees(repoDir);
  await forEachYielding(registered, async (worktree) => {
    const path = resolve(worktree.path);
    if (dirname(path) !== root || !basename(path).startsWith(EPIC_REFRESH_WORKTREE_PREFIX)) return;
    const ok = await bestEffort(() => deps.removeWorktree(repoDir, path), {
      op: 'epicRefresh.sweepOrphanedWorktree',
      level: 'warn',
      context: { repoDir, worktreePath: path },
    });
    if (ok) removed.push(path);
  });
  if (registered.length > 0) {
    await bestEffort(() => deps.pruneWorktrees(repoDir), {
      op: 'epicRefresh.sweepOrphanedWorktree.prune',
      level: 'warn',
      context: { repoDir },
    });
  }
  return removed;
}
