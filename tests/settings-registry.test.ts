import { describe, it, expect } from 'vitest';
import { settingsRegistry, isOverridable, settingSpec, type SettingKey } from '../src/domain/settings-registry.js';
import { resolveScoped } from '../src/domain/setting-override.js';

describe('Settings registry (issue #336) — single authority for scope', () => {
  // Every per-Workspace override column in `db/schema.ts` must be declared in the
  // registry as `overridable`. This is the regression guard the critic asked for:
  // a new override column that is not registered (or is resolved without a
  // registry key) fails here, so the registry stays the single authority.
  const OVERRIDABLE_COLUMNS: SettingKey[] = [
    'harness',
    'model',
    'chatHarness',
    'chatModel',
    'isolationMode',
    'priority',
    'maxConcurrentRuns',
    'autoRunnerEnabled',
    'maxAttempts',
    'contextReuseTokenLimit',
    'verificationCommand',
    'verificationCritic',
    'guardrailBudget',
    'guardrailProgress',
  ];

  it('declares every Workspace override column as overridable', () => {
    for (const key of OVERRIDABLE_COLUMNS) {
      expect(settingsRegistry[key], `missing registry entry for '${key}'`).toBeDefined();
      expect(isOverridable(key), `'${key}' should be overridable`).toBe(true);
    }
  });

  it('declares toolTimeoutMinutes global-only (a Workspace can never override it)', () => {
    expect(settingSpec('toolTimeoutMinutes').scope).toBe('global-only');
    expect(isOverridable('toolTimeoutMinutes')).toBe(false);
  });

  it('gives every setting a control, label, and help — the seam a later UI consumes', () => {
    for (const key of Object.keys(settingsRegistry) as SettingKey[]) {
      const spec = settingSpec(key);
      expect(spec.control).toBeTruthy();
      expect(spec.label).toBeTruthy();
      expect(spec.help).toBeTruthy();
    }
  });
});

describe('resolveScoped — the scoped resolver reads scope from the registry', () => {
  it('resolves an overridable setting like resolve: Workspace value wins over global', () => {
    expect(resolveScoped('harness', 'codex', 'claude')).toBe('codex');
  });

  it('inherits the global default for an overridable setting when the Workspace value is null/undefined', () => {
    expect(resolveScoped('harness', null, 'claude')).toBe('claude');
    expect(resolveScoped('model', undefined, 'claude-opus-5')).toBe('claude-opus-5');
  });

  it('treats a falsy-but-set overridable value as an override, not inherit', () => {
    expect(resolveScoped('maxAttempts', 0, 5)).toBe(0);
    expect(resolveScoped('autoRunnerEnabled', false, true)).toBe(false);
  });

  it('ignores any Workspace value for a global-only setting and always returns the global default', () => {
    // Even a set value cannot override a global-only setting.
    expect(resolveScoped('toolTimeoutMinutes', 99, 20)).toBe(20);
    expect(resolveScoped('toolTimeoutMinutes', null, 20)).toBe(20);
  });
});
