import { Git } from './git.js';

/**
 * For a Run whose work is still live in a worktree (running, before the settle
 * snapshot), the worktree path and the fork-point OID to diff its current state
 * against — so the review pane reflects committed AND uncommitted work rather
 * than the empty `base...branch` range a not-yet-committed attempt produces.
 * Null when the branch is not checked out in a worktree (settled / cleaned up)
 * or the base can't be resolved, so the caller falls back to the committed range.
 */
export async function liveWorktreeDiff(
  workingDir: string,
  branch: string | null,
  baseBranch: string | null,
): Promise<{ worktree: string; baseOid: string } | null> {
  if (!branch || !baseBranch) return null;
  const worktree = await Git.branchCheckedOutAt(workingDir, branch).catch(() => null);
  if (!worktree) return null;
  const baseOid = await Git.mergeBase(workingDir, baseBranch, branch).catch(() => null);
  if (!baseOid) return null;
  return { worktree, baseOid };
}
