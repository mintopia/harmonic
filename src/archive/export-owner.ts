import type { TaskRow } from '../db/schema.js';

export type ExportOwner<Task extends { id: number } = TaskRow> = { kind: 'task'; task: Task } | { kind: 'epic'; workspaceId: number; epicRef: number };

export function exportOwnerKey(owner: ExportOwner<{ id: number }>): string {
  return owner.kind === 'task' ? `task:${owner.task.id}` : `epic:${owner.workspaceId}:${owner.epicRef}`;
}
