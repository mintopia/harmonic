export type ExportOwnerRef = { kind: 'task'; taskId: number } | { kind: 'epic'; workspaceId: number; epicRef: number };

export function exportOwnerKey(owner: ExportOwnerRef): string {
  return owner.kind === 'task' ? `task:${owner.taskId}` : `epic:${owner.workspaceId}:${owner.epicRef}`;
}
