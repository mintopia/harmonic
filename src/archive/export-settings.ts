import type { AppConfig, ExportState } from '../config.js';
import type { WorkspaceRow } from '../db/schema.js';

export interface ResolvedExportSettings {
  enabled: boolean;
  includeStates: readonly ExportState[];
  directoryPath: string | null;
}

export function resolveExportSettings(
  global: AppConfig,
  workspace: Pick<WorkspaceRow, 'exportEnabled' | 'exportDirectoryPath'> | undefined,
): ResolvedExportSettings {
  return {
    enabled: workspace?.exportEnabled ?? global.export.enabled,
    includeStates: global.export.includeStates,
    directoryPath: workspace?.exportDirectoryPath ?? global.export.directory.path,
  };
}
