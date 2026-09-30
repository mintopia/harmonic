import { redactPatternsSchema, type AppConfig, type ExportState } from '../config.js';
import type { WorkspaceRow } from '../db/schema.js';
import { BASELINE_REDACT_PATTERNS, type RedactionPattern } from './redact.js';

export interface ResolvedS3Settings {
  endpoint: string | null;
  region: string | null;
  bucket: string;
  prefix: string;
  forcePathStyle: boolean;
  credentials: { accessKeyId: string; secretAccessKey: string } | null;
}

export interface ResolvedExportSettings {
  enabled: boolean;
  includeStates: readonly ExportState[];
  directoryPath: string | null;
  s3: ResolvedS3Settings | null;
  redactPatterns: readonly RedactionPattern[];
}

export type ExportWorkspaceOverrides = Pick<
  WorkspaceRow,
  | 'exportEnabled'
  | 'exportDirectoryPath'
  | 'exportRedactPatterns'
  | 'exportS3Endpoint'
  | 'exportS3Region'
  | 'exportS3Bucket'
  | 'exportS3Prefix'
  | 'exportS3ForcePathStyle'
  | 'exportS3AccessKeyId'
  | 'exportS3SecretAccessKey'
>;

function resolveS3(global: AppConfig['export']['s3'], workspace: Partial<ExportWorkspaceOverrides> | undefined): ResolvedS3Settings | null {
  const bucket = workspace?.exportS3Bucket ?? global.bucket;
  if (bucket === null) return null;
  const workspaceKeys = (workspace?.exportS3AccessKeyId ?? null) !== null || (workspace?.exportS3SecretAccessKey ?? null) !== null;
  const accessKeyId = workspaceKeys ? (workspace?.exportS3AccessKeyId ?? null) : global.accessKeyId;
  const secretAccessKey = workspaceKeys ? (workspace?.exportS3SecretAccessKey ?? null) : global.secretAccessKey;
  return {
    endpoint: workspace?.exportS3Endpoint ?? global.endpoint,
    region: workspace?.exportS3Region ?? global.region,
    bucket,
    prefix: workspace?.exportS3Prefix ?? global.prefix,
    forcePathStyle: workspace?.exportS3ForcePathStyle ?? global.forcePathStyle,
    credentials: accessKeyId !== null && secretAccessKey !== null ? { accessKeyId, secretAccessKey } : null,
  };
}

export function resolveExportSettings(global: AppConfig, workspace: Partial<ExportWorkspaceOverrides> | undefined): ResolvedExportSettings {
  const workspacePatterns = workspace?.exportRedactPatterns ? redactPatternsSchema.parse(JSON.parse(workspace.exportRedactPatterns)) : [];
  return {
    enabled: workspace?.exportEnabled ?? global.export.enabled,
    includeStates: global.export.includeStates,
    directoryPath: workspace?.exportDirectoryPath ?? global.export.directory.path,
    s3: resolveS3(global.export.s3, workspace),
    redactPatterns: [...BASELINE_REDACT_PATTERNS, ...global.export.redact.patterns, ...workspacePatterns],
  };
}

export function hasExportDestination(settings: ResolvedExportSettings): boolean {
  return settings.directoryPath !== null || settings.s3 !== null;
}
