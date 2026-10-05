import { api } from './api';
import type { TaskExportAgainResult, TaskExportStatus, TrackerRef } from './types';

/** What an Export panel reads and acts on: a Task or an Epic, with its own endpoints. */
export type ExportTarget = {
  /** Stable identity; a change resets the panel's per-target state. */
  key: string;
  noun: 'Task' | 'Epic';
  load: () => Promise<TaskExportStatus>;
  exportAgain: () => Promise<TaskExportAgainResult>;
  downloadUrl: string;
};

export const taskExportTarget = (taskId: number): ExportTarget => ({
  key: `task:${taskId}`,
  noun: 'Task',
  load: () => api.taskExport(taskId),
  exportAgain: () => api.exportTaskAgain(taskId),
  downloadUrl: api.taskExportDownloadUrl(taskId),
});

export const epicExportTarget = (workspaceId: number, epicRef: TrackerRef): ExportTarget => ({
  key: `epic:${workspaceId}:${epicRef}`,
  noun: 'Epic',
  load: () => api.epicExport(workspaceId, epicRef),
  exportAgain: () => api.exportEpicAgain(workspaceId, epicRef),
  downloadUrl: api.epicExportDownloadUrl(workspaceId, epicRef),
});
