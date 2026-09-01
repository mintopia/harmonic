export type FlaggedWorktreeReason = 'dirty' | 'unreadable' | 'unrecognized';

/**
 * A managed worktree the reconciler will not delete until an operator
 * disposes of it by hand (ADR-0010): `dirty` holds uncommitted work,
 * `unreadable` is a directory git can't resolve as a live worktree, and
 * `unrecognized` doesn't even parse as a Task worktree's `task-<id>` name.
 */
export interface FlaggedWorktree {
  path: string;
  repoDir: string;
  workspaceId: number;
  taskId: number | null;
  branch: string | null;
  reason: FlaggedWorktreeReason;
}

export interface FlaggedWorktreeEmitter {
  emit(event: 'flagged_worktrees', flags: readonly FlaggedWorktree[]): void;
}

/**
 * In-memory operator-disposition registry (issue #386). A flagged worktree
 * persists on disk and is re-derived from scratch on every reconcile pass —
 * the filesystem is the source of truth — so `replace` is always a full
 * rebuild, never a merge, and no migration backs this: it holds no state a
 * restart needs to recover.
 */
export class FlaggedWorktreeRegistry {
  private current: readonly FlaggedWorktree[] = [];

  constructor(private readonly bus: FlaggedWorktreeEmitter) {}

  replace(flags: readonly FlaggedWorktree[]): void {
    this.current = flags;
    this.bus.emit('flagged_worktrees', this.current);
  }

  snapshot(): readonly FlaggedWorktree[] {
    return this.current;
  }
}
