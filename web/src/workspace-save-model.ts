import { settingsRegistry, isOverridable, type SettingKey } from '../../src/domain/settings-registry.js';
import type { Workspace } from './types';
import type { api } from './api';

type WorkspacePatch = Parameters<typeof api.updateWorkspace>[1];

const OVERRIDABLE_KEYS = (Object.keys(settingsRegistry) as SettingKey[]).filter(isOverridable);

/** The PATCH body for a Workspace Settings save: identity fields plus every registry-overridable key, so a new setting cannot be dropped. */
export function workspaceSavePatch(w: Workspace): WorkspacePatch {
  return {
    name: w.name,
    color: w.color,
    trackerEnabled: w.trackerEnabled,
    trackerPollIntervalSeconds: w.trackerPollIntervalSeconds,
    excludedDirectories: w.excludedDirectories,
    ...(Object.fromEntries(OVERRIDABLE_KEYS.map((key) => [key, (w as unknown as Record<string, unknown>)[key]])) as WorkspacePatch),
  };
}
