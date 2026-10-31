import type { AppConfig, DeepPartial } from '../../src/config.js';
import { LEGACY_WORKSPACE_KEYS, type LegacyGlobalPatch, type LegacyWorkspacePatch } from '../../src/domain/legacy-execution-settings.js';
import type { WorkspaceOverrides } from '../../src/domain/workspaces.js';

export type LegacyConfigOverrides = DeepPartial<AppConfig> & LegacyGlobalPatch;

export type LegacyWorkspaceOverrides = WorkspaceOverrides & LegacyWorkspacePatch;

export function splitLegacyConfig(overrides: LegacyConfigOverrides | undefined): { config: DeepPartial<AppConfig> | undefined; legacy: LegacyGlobalPatch } {
  if (!overrides) return { config: undefined, legacy: {} };
  const { drive, verify, ...rest } = overrides;
  const { mergeFate, continueAttempts, ...driveRest } = drive ?? {};
  const { task, ...verifyRest } = verify ?? {};
  const legacy: LegacyGlobalPatch = {
    ...(mergeFate !== undefined || continueAttempts !== undefined ? { drive: { ...(mergeFate !== undefined ? { mergeFate } : {}), ...(continueAttempts !== undefined ? { continueAttempts } : {}) } } : {}),
    ...(task !== undefined ? { verify: { task } } : {}),
  };
  const config: DeepPartial<AppConfig> = {
    ...rest,
    ...(drive !== undefined ? { drive: driveRest } : {}),
    ...(verify !== undefined ? { verify: verifyRest } : {}),
  };
  return { config, legacy };
}

export function splitLegacyWorkspace(overrides: LegacyWorkspaceOverrides): { overrides: WorkspaceOverrides; legacy: LegacyWorkspacePatch } {
  const legacy: Record<string, unknown> = {};
  const rest: Record<string, unknown> = { ...overrides };
  for (const key of LEGACY_WORKSPACE_KEYS) {
    if (key in rest) {
      legacy[key] = rest[key];
      delete rest[key];
    }
  }
  return { overrides: rest as WorkspaceOverrides, legacy: legacy as LegacyWorkspacePatch };
}
