import { redactPatternsSchema, type AppConfig, type ExportState } from '../config.js';
import type { WorkspaceRow } from '../db/schema.js';
import { BASELINE_REDACT_PATTERNS, type RedactionPattern } from './redact.js';

export interface ResolvedExportSettings {
  enabled: boolean;
  includeStates: readonly ExportState[];
  directoryPath: string | null;
  redactPatterns: readonly RedactionPattern[];
}

export function resolveExportSettings(
  global: AppConfig,
  workspace: Pick<WorkspaceRow, 'exportEnabled' | 'exportDirectoryPath' | 'exportRedactPatterns'> | undefined,
): ResolvedExportSettings {
  const workspacePatterns = workspace?.exportRedactPatterns ? redactPatternsSchema.parse(JSON.parse(workspace.exportRedactPatterns)) : [];
  return {
    enabled: workspace?.exportEnabled ?? global.export.enabled,
    includeStates: global.export.includeStates,
    directoryPath: workspace?.exportDirectoryPath ?? global.export.directory.path,
    redactPatterns: [...BASELINE_REDACT_PATTERNS, ...global.export.redact.patterns, ...workspacePatterns],
  };
}
