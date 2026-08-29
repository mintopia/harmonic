/** A managed worktree the reconciler (ADR-0010) will not delete until an
 * operator disposes of it by hand. */
export interface FlaggedWorktree {
  path: string;
  repoDir: string;
  workspaceId: number;
  taskId: number | null;
  branch: string | null;
  reason: 'dirty' | 'unreadable' | 'unrecognized';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || typeof value === 'number';
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isFlaggedWorktree(value: unknown): value is FlaggedWorktree {
  if (!isRecord(value)) return false;
  return typeof value.path === 'string'
    && typeof value.repoDir === 'string'
    && typeof value.workspaceId === 'number'
    && isNullableNumber(value.taskId)
    && isNullableString(value.branch)
    && (value.reason === 'dirty' || value.reason === 'unreadable' || value.reason === 'unrecognized');
}

/** Validates the API/firehose registry at the browser boundary. */
export function isFlaggedWorktreesSnapshot(value: unknown): value is { worktrees: FlaggedWorktree[] } {
  return isRecord(value) && Array.isArray(value.worktrees) && value.worktrees.every(isFlaggedWorktree);
}

/**
 * A flagged-worktrees event is a complete registry snapshot, not a delta —
 * the reconciler rebuilds it in full every pass, so replacing the prior list
 * drops a worktree that was disposed of (or reconciled clean) since.
 */
export function mergeFlaggedWorktrees(_previous: readonly FlaggedWorktree[], next: readonly FlaggedWorktree[]): FlaggedWorktree[] {
  return [...next];
}

export function flaggedWorktreeReasonLabel(reason: FlaggedWorktree['reason']): string {
  switch (reason) {
    case 'dirty':
      return 'Dirty';
    case 'unreadable':
      return 'Unreadable';
    case 'unrecognized':
      return 'Unrecognized';
  }
}
