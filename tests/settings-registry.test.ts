import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  settingsRegistry,
  isOverridable,
  hasWorkspaceOverride,
  settingSpec,
  SETTING_TABS,
  settingsForTab,
  workspaceTabs,
  type SettingKey,
  type SettingScope,
  type SettingTab,
} from '../src/domain/settings-registry.js';
import { PROMPT_TEMPLATES } from '../src/domain/prompt-templates.js';
import { resolveScoped, resolveCap, resolveGuardrails } from '../src/domain/setting-override.js';

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
  const OVERRIDABLE_COLUMNS: SettingKey[] = [
    'harness',
    'model',
    'chatHarness',
    'chatModel',
    'isolationMode',
    'priority',
    'maxConcurrentAttempts',
    'autoRunnerEnabled',
    'agentMessagesEnabled',
    'agentMessagesSendCap',
    'maxAttempts',
    'contextReuseTokenLimit',
    'guardrailBudget',
    'guardrailProgress',
    'toolTimeoutMinutes',
    'drivePrompt',
    'driveUnattendedReminder',
    'driveContinuePrompt',
    'taskPrompt',
    'exportEnabled',
    'exportDirectoryPath',
    'exportS3Endpoint',
    'exportS3Region',
    'exportS3Bucket',
    'exportS3Prefix',
    'exportS3ForcePathStyle',
    'exportS3AccessKeyId',
    'exportS3SecretAccessKey',
    'exportRedactPatterns',
  ];

  it('declares every Workspace override column as overridable', () => {
    for (const key of OVERRIDABLE_COLUMNS) {
      expect(settingsRegistry[key], `missing registry entry for '${key}'`).toBeDefined();
      expect(isOverridable(key), `'${key}' should be overridable`).toBe(true);
    }
  });

  it('declares toolTimeoutMinutes overridable (reclassified from global-only, #339)', () => {
    expect(settingSpec('toolTimeoutMinutes').scope).toBe('overridable');
    expect(isOverridable('toolTimeoutMinutes')).toBe(true);
  });

  it('declares every reclassified drive/task-prompt field overridable (#339)', () => {
    for (const key of [
      'drivePrompt',
      'driveUnattendedReminder',
      'driveContinuePrompt',
      'taskPrompt',
    ] as const) {
      expect(isOverridable(key), `'${key}' should be overridable`).toBe(true);
    }
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

describe('tab taxonomy — settings group into Settings UI tabs', () => {
  const VALID_TAB_IDS: Set<SettingTab> = new Set(SETTING_TABS.map((t) => t.id));

  it('gives every setting a tab that is one of the declared SETTING_TABS', () => {
    for (const key of Object.keys(settingsRegistry) as SettingKey[]) {
      const spec = settingSpec(key);
      expect(VALID_TAB_IDS.has(spec.tab), `'${key}' has unknown tab '${spec.tab}'`).toBe(true);
    }
  });

  it('declares exactly 5 tabs, unique ids, in the expected order', () => {
    expect(SETTING_TABS).toHaveLength(5);
    const ids = SETTING_TABS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(['general', 'execution', 'prompts', 'integrations', 'archive']);
  });

  it('settingsForTab("general") returns exactly the general settings', () => {
    expect(settingsForTab('general')).toEqual(['chatHarness', 'chatModel']);
  });

  it('settingsForTab("execution") includes execution settings and excludes other tabs', () => {
    const execution = settingsForTab('execution');
    expect(execution).toEqual(
      expect.arrayContaining(['harness', 'maxAttempts', 'guardrailBudget', 'toolTimeoutMinutes']),
    );
    expect(execution).not.toContain('chatHarness');
  });

  it('settingsForTab("prompts") returns the drive + task prompt fields (#339)', () => {
    expect(settingsForTab('prompts')).toEqual([
      'drivePrompt',
      'driveUnattendedReminder',
      'driveContinuePrompt',
      'taskPrompt',
      'pauseMessage',
      'driveCommitNudge',
      'mergeConflictPrompt',
      'mergeEpicConflictPrompt',
      'mergeEpicRefreshPrompt',
      'verifyEpicResolveSuffix',
    ]);
  });

  it('settingsForTab returns only registry-declared fields per tab', () => {
    expect(settingsForTab('integrations')).toEqual(['configuredTracker', 'codeRepository', 'triageLabels']);
  });

  it('every key returned by settingsForTab round-trips: settingSpec(key).tab === tab', () => {
    for (const { id: tab } of SETTING_TABS) {
      for (const key of settingsForTab(tab)) {
        expect(settingSpec(key).tab).toBe(tab);
      }
    }
  });

  it('workspaceTabs drops the tabs with no overridable field', () => {
    expect(workspaceTabs().map((t) => t.id)).toEqual(['general', 'execution', 'prompts', 'integrations', 'archive']);
  });

  it('a tab whose only field turns global-only drops off the Workspace surface', () => {
    const promptKeys = settingsForTab('prompts');
    const mutable = settingsRegistry as unknown as Record<SettingKey, { scope: SettingScope }>;
    const originals = promptKeys.map((key) => [key, mutable[key].scope] as const);
    for (const key of promptKeys) mutable[key].scope = 'global-only';
    try {
      expect(workspaceTabs().map((t) => t.id)).not.toContain('prompts');
    } finally {
      for (const [key, scope] of originals) mutable[key].scope = scope;
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

  it('resolves Agent Messages Baseline → Global → Workspace: Global off + Workspace on is on, null inherits Global', () => {
    expect(resolveScoped('agentMessagesEnabled', true, false)).toBe(true);
    expect(resolveScoped('agentMessagesEnabled', false, true)).toBe(false);
    expect(resolveScoped('agentMessagesEnabled', null, false)).toBe(false);
    expect(resolveScoped('agentMessagesSendCap', 3, 10)).toBe(3);
    expect(resolveScoped('agentMessagesSendCap', null, 10)).toBe(10);
  });

  it('a now-overridable setting lets the Workspace value win (toolTimeoutMinutes, #339)', () => {
    expect(resolveScoped('toolTimeoutMinutes', 99, 20)).toBe(99);
    expect(resolveScoped('toolTimeoutMinutes', null, 20)).toBe(20);
  });

  it('ignores any Workspace value for a global-only setting and always returns the global default', () => {
    withScope('harness', 'global-only', () => {
      expect(resolveScoped('harness', 'codex', 'claude')).toBe('claude');
      expect(resolveScoped('harness', null, 'claude')).toBe('claude');
    });
  });
});

describe('scope changes control live resolution (registry is the single authority)', () => {
  it('resolveScoped: flipping harness to global-only stops the Workspace value winning', () => {
    expect(resolveScoped('harness', 'codex', 'claude')).toBe('codex');
    withScope('harness', 'global-only', () => {
      expect(resolveScoped('harness', 'codex', 'claude')).toBe('claude');
    });
    expect(resolveScoped('harness', 'codex', 'claude')).toBe('codex');
  });

  it('resolveCap: flipping maxConcurrentAttempts to global-only ignores the Workspace cap', () => {
    expect(resolveCap(2, 3)).toBe(2);
    withScope('maxConcurrentAttempts', 'global-only', () => {
      expect(resolveCap(2, 3)).toBe(3);
    });
  });

  it('resolveGuardrails: flipping guardrailBudget/guardrailProgress to global-only ignores the Workspace columns', () => {
    const config = { guardrails: { budget: { wallClockMinutes: 60, tokens: null, costUsd: null }, progress: true } } as never;
    const wsOverride = { wallClockMinutes: 30, tokens: 500000, costUsd: 5 };
    const ws = { guardrailBudget: JSON.stringify(wsOverride), guardrailProgress: false, toolTimeoutMinutes: null };

    const before = resolveGuardrails(ws, config);
    expect(before.budget).toEqual(wsOverride);
    expect(before.progress).toBe(false);

    withScope('guardrailBudget', 'global-only', () => {
      withScope('guardrailProgress', 'global-only', () => {
        const after = resolveGuardrails(ws, config);
        expect(after.budget).toEqual({ wallClockMinutes: 60, tokens: null, costUsd: null });
        expect(after.progress).toBe(true);
      });
    });
  });

  it('hasWorkspaceOverride: flipping to global-only makes a set column stop counting as an override', () => {
    expect(hasWorkspaceOverride('guardrailBudget', '{"wallClockMinutes":30}')).toBe(true);
    withScope('guardrailBudget', 'global-only', () => {
      expect(hasWorkspaceOverride('guardrailBudget', '{"wallClockMinutes":30}')).toBe(false);
    });
    expect(hasWorkspaceOverride('guardrailBudget', null)).toBe(false);
  });

  it('hasWorkspaceOverride: an explicit boolean false counts as an override (not truthiness)', () => {
    expect(hasWorkspaceOverride('guardrailBudget', '[]')).toBe(true);
    expect(hasWorkspaceOverride('guardrailProgress', false)).toBe(true);
  });
});

describe('every registry key has a UI surface', () => {
  const webSrc = join(__dirname, '..', 'web', 'src');
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
  const uiSources = walk(webSrc)
    .filter((path) => /\.tsx?$/.test(path) && !/[\\/](api|types)\.ts$/.test(path) && !/[\\/]story[\\/]/.test(path))
    .map((path) => readFileSync(path, 'utf8'));
  const keys = Object.keys(settingsRegistry) as SettingKey[];
  const promptKeys = new Set(Object.values(PROMPT_TEMPLATES).flatMap((spec) => (spec.workspace ? [spec.workspace] : [])));
  const renderedControls = ['select', 'toggle', 'number', 'text', 'json', 'routing-labels', 'workflow-labels'];

  it('declares only controls the Settings UI can render', () => {
    for (const key of keys) expect(renderedControls, key).toContain(settingsRegistry[key].control);
  });

  it('serves every Prompt tab key from the Prompt library, and no other key', () => {
    const promptTabKeys = settingsForTab('prompts');
    expect(promptTabKeys.filter((key) => !promptKeys.has(key)), 'prompts-tab keys missing from PROMPT_TEMPLATES').toEqual([]);
    expect([...promptKeys].filter((key) => settingSpec(key).tab !== 'prompts'), 'Prompt library keys outside the prompts tab').toEqual([]);
  });

  it('references every non-prompt key from a Settings UI source', () => {
    const unreferenced = keys.filter((key) => !promptKeys.has(key) && !uiSources.some((text) => new RegExp(`['"]${key}['"]|\\b${key}\\s*[:,}]|\\.${key}\\b`).test(text)));
    expect(unreferenced).toEqual([]);
  });
});
