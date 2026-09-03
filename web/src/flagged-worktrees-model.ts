export type WorktreeState = 'Active' | 'Stale' | 'Dirty' | 'Unreadable' | 'Orphan' | 'Missing';

export interface WorktreeInventoryEntry {
  workspaceId: number;
  path: string;
  branch: string | null;
  subject: { kind: 'task'; taskId: number; title: string } | { kind: 'epic'; epicRef: number; title: string } | null;
  sizeBytes: number | null;
  dirty: boolean | null;
  state: WorktreeState;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isWorktree(value: unknown): value is WorktreeInventoryEntry {
  if (!isRecord(value) || typeof value.workspaceId !== 'number' || typeof value.path !== 'string') return false;
  if (value.branch !== null && typeof value.branch !== 'string') return false;
  if (value.sizeBytes !== null && typeof value.sizeBytes !== 'number') return false;
  if (value.dirty !== null && typeof value.dirty !== 'boolean') return false;
  const subject = value.subject;
  if (subject !== null && (!isRecord(subject) || typeof subject.title !== 'string' ||
    (subject.kind !== 'task' && subject.kind !== 'epic') ||
    (subject.kind === 'task' && typeof subject.taskId !== 'number') ||
    (subject.kind === 'epic' && typeof subject.epicRef !== 'number'))) return false;
  return value.state === 'Active' || value.state === 'Stale' || value.state === 'Dirty' || value.state === 'Unreadable' || value.state === 'Orphan' || value.state === 'Missing';
}

export function isWorktreesSnapshot(value: unknown): value is { worktrees: WorktreeInventoryEntry[] } {
  return isRecord(value) && Array.isArray(value.worktrees) && value.worktrees.every(isWorktree);
}

export function mergeWorktrees(_previous: readonly WorktreeInventoryEntry[], next: readonly WorktreeInventoryEntry[]): WorktreeInventoryEntry[] {
  return [...next];
}
