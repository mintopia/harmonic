import { Git } from './git.js';
import { parseUnifiedDiff, type DiffFile } from '../domain/unified-diff.js';

/**
 * For an Attempt whose work is still live in a worktree (running, before the settle
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

type AttemptDiffSource = {
  branch: string | null;
  baseBranch: string | null;
  stat: string | null;
  diffBaseOid: string | null;
  diffHeadOid: string | null;
};

/** Resolves the stat from a running worktree when possible, then its branch. */
export async function attemptDiffStat(
  workingDir: string,
  attempt: Pick<AttemptDiffSource, 'branch' | 'baseBranch' | 'stat'>,
): Promise<string | null> {
  if (!attempt.branch || !attempt.baseBranch) return null;
  if (attempt.stat !== null) return attempt.stat;
  const live = await liveWorktreeDiff(workingDir, attempt.branch, attempt.baseBranch);
  return live
    ? Git.worktreeDiffStat(live.worktree, live.baseOid)
    : Git.diffStat(workingDir, attempt.baseBranch, attempt.branch);
}

/** Resolves a frozen verified revision first, then a live worktree, then a branch. */
export async function attemptDiffFiles(
  workingDir: string,
  attempt: Pick<AttemptDiffSource, 'branch' | 'baseBranch' | 'diffBaseOid' | 'diffHeadOid'>,
): Promise<DiffFile[]> {
  let raw: string;
  if (attempt.diffBaseOid && attempt.diffHeadOid) {
    raw = await Git.diffRange(workingDir, attempt.diffBaseOid, attempt.diffHeadOid);
  } else {
    const live = await liveWorktreeDiff(workingDir, attempt.branch, attempt.baseBranch);
    raw = live
      ? await Git.worktreeDiffUnified(live.worktree, live.baseOid)
      : attempt.branch && attempt.baseBranch
        ? await Git.diffUnified(workingDir, attempt.baseBranch, attempt.branch)
        : '';
  }
  return parseUnifiedDiff(raw);
}
