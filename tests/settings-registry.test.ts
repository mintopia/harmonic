import { describe, it, expect } from 'vitest';
import {
  settingsRegistry,
  isOverridable,
  hasWorkspaceOverride,
  settingSpec,
  SETTING_TABS,
  settingsForTab,
  type SettingKey,
  type SettingScope,
  type SettingTab,
} from '../src/domain/settings-registry.js';
import { resolveScoped, resolveCap, resolveVerifiers, resolveGuardrails } from '../src/domain/setting-override.js';

/**
 * Temporarily override a setting's scope in the live registry, run `fn`, then
 * restore. This exercises the *real* resolvers against a changed registry, so a
 * test can prove the registry — not hard-coded call-site logic — controls
 * resolution. `settingsRegistry` is `as const` only at the type level, so the
 * object is mutable at runtime and the resolvers read it live on every call.
 */
function withScope(key: SettingKey, scope: SettingScope, fn: () => void): void {
  const mutable = settingsRegistry as unknown as Record<SettingKey, { scope: SettingScope }>;
  const original = mutable[key].scope;
  mutable[key].scope = scope;
  try {
    fn();
  } finally {
    mutable[key].scope = original;
  }
}

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

describe('tab taxonomy (ADR-0044) — settings group into Settings UI tabs', () => {
  const VALID_TAB_IDS: Set<SettingTab> = new Set(SETTING_TABS.map((t) => t.id));

  it('gives every setting a tab that is one of the declared SETTING_TABS', () => {
    for (const key of Object.keys(settingsRegistry) as SettingKey[]) {
      const spec = settingSpec(key);
      expect(VALID_TAB_IDS.has(spec.tab), `'${key}' has unknown tab '${spec.tab}'`).toBe(true);
    }
  });

  it('declares exactly 6 tabs, unique ids, in the expected order', () => {
    expect(SETTING_TABS).toHaveLength(6);
    const ids = SETTING_TABS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(['general', 'execution', 'verification', 'prompts', 'integrations', 'security']);
  });

  it('settingsForTab("verification") returns exactly the verification settings', () => {
    expect(settingsForTab('verification')).toEqual(['verificationCommand', 'verificationCritic']);
  });

  it('settingsForTab("general") returns exactly the general settings', () => {
    expect(settingsForTab('general')).toEqual(['chatHarness', 'chatModel']);
  });

  it('settingsForTab("execution") includes execution settings and excludes other tabs', () => {
    const execution = settingsForTab('execution');
    expect(execution).toEqual(
      expect.arrayContaining(['harness', 'maxAttempts', 'guardrailBudget', 'toolTimeoutMinutes']),
    );
    expect(execution).not.toContain('verificationCommand');
    expect(execution).not.toContain('chatHarness');
  });

  it('settingsForTab returns [] for tabs with no registry-declared fields', () => {
    expect(settingsForTab('prompts')).toEqual([]);
    expect(settingsForTab('integrations')).toEqual([]);
    expect(settingsForTab('security')).toEqual([]);
  });

  it('every key returned by settingsForTab round-trips: settingSpec(key).tab === tab', () => {
    for (const { id: tab } of SETTING_TABS) {
      for (const key of settingsForTab(tab)) {
        expect(settingSpec(key).tab).toBe(tab);
      }
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

// The proof the critic asked for: changing a setting's scope in the registry
// changes what the LIVE resolvers return, for the same inputs. If any resolver
// resolved a value without consulting the registry, its output would not move
// when the scope flips — these tests would fail. This is what makes the registry
// the single authority in practice, not just by declaration.
describe('scope changes control live resolution (registry is the single authority)', () => {
  it('resolveScoped: flipping harness to global-only stops the Workspace value winning', () => {
    expect(resolveScoped('harness', 'codex', 'claude')).toBe('codex'); // overridable
    withScope('harness', 'global-only', () => {
      expect(resolveScoped('harness', 'codex', 'claude')).toBe('claude'); // now ignored
    });
    expect(resolveScoped('harness', 'codex', 'claude')).toBe('codex'); // restored
  });

  it('resolveCap: flipping maxConcurrentRuns to global-only ignores the Workspace cap', () => {
    expect(resolveCap(2, 3)).toBe(2); // overridable → Workspace cap wins (≤ ceiling)
    withScope('maxConcurrentRuns', 'global-only', () => {
      expect(resolveCap(2, 3)).toBe(3); // now the ceiling, Workspace cap ignored
    });
  });

  it('resolveGuardrails: flipping guardrailBudget/guardrailProgress to global-only ignores the Workspace columns', () => {
    const config = { guardrails: { budget: { wallClockMinutes: 60, tokens: null, costUsd: null }, progress: true } } as never;
    const wsOverride = { wallClockMinutes: 30, tokens: 500000, costUsd: 5 };
    const ws = { guardrailBudget: JSON.stringify(wsOverride), guardrailProgress: false };

    const before = resolveGuardrails(ws, config);
    expect(before.budget).toEqual(wsOverride); // overridable → Workspace budget wins
    expect(before.progress).toBe(false); // overridable → explicit-off wins

    withScope('guardrailBudget', 'global-only', () => {
      withScope('guardrailProgress', 'global-only', () => {
        const after = resolveGuardrails(ws, config);
        expect(after.budget).toEqual({ wallClockMinutes: 60, tokens: null, costUsd: null }); // global
        expect(after.progress).toBe(true); // global
      });
    });
  });

  it('resolveVerifiers: flipping verificationCommand to global-only ignores the Workspace verifier', () => {
    const globalCommand = { command: 'npm', args: ['test'], env: {}, timeoutSeconds: 600 };
    const wsCommand = { command: 'pnpm', args: ['lint'], env: {}, timeoutSeconds: 300 };
    const config = { verify: { commands: [globalCommand], review: { enabled: false } } } as never;
    const ws = { verificationCommand: JSON.stringify([wsCommand]), verificationCritic: null };

    expect(resolveVerifiers(ws, config).commands).toEqual([wsCommand]); // overridable
    withScope('verificationCommand', 'global-only', () => {
      expect(resolveVerifiers(ws, config).commands).toEqual([globalCommand]); // ignored → global
    });
  });

  it('hasWorkspaceOverride: flipping to global-only makes a set column stop counting as an override', () => {
    expect(hasWorkspaceOverride('guardrailBudget', '{"wallClockMinutes":30}')).toBe(true); // overridable + set
    withScope('guardrailBudget', 'global-only', () => {
      expect(hasWorkspaceOverride('guardrailBudget', '{"wallClockMinutes":30}')).toBe(false); // never an override
    });
    expect(hasWorkspaceOverride('guardrailBudget', null)).toBe(false); // set-ness still required
  });
});
