import { describe, expect, it } from 'vitest';
import { settingsRegistry, isOverridable, type SettingKey } from '../src/domain/settings-registry.js';
import { OVERRIDE_KEYS } from '../src/domain/workspaces.js';

describe('Workspace override keys', () => {
  it('registry overridable keys plus excludedDirectories are exactly the server override keys', () => {
    const overridable = (Object.keys(settingsRegistry) as SettingKey[]).filter(isOverridable);
    expect([...overridable, 'excludedDirectories'].sort()).toEqual([...OVERRIDE_KEYS].sort());
  });
});
