/**
 * Settings registry (issue #336, part of #335). One declaration, per setting, of
 * its **scope** — `global-only` (a single instance-wide value) or `overridable`
 * (a Workspace may store its own value that wins over the global default,
 * ADR-0012) — plus the UI control, label, help text, and tab.
 *
 * This registry is the single authority for which settings are overridable. The
 * resolver (`setting-override.ts`) reads scope from here rather than each call
 * site deciding independently, so a global-only setting can never be resolved
 * from a per-Workspace value. It is also the seam a later phase's Settings UI
 * consumes for control/label/help — no UI change ships with this ticket.
 *
 * Keys match the `workspaces` override columns (`db/schema.ts`) so every
 * resolution path names its setting by the same key.
 */

/** Whether a setting can be overridden per Workspace, or is instance-wide only. */
export type SettingScope = 'global-only' | 'overridable';

/** The UI control a setting renders as (consumed by the Phase-2 Settings UI). */
export type SettingControl = 'select' | 'toggle' | 'number' | 'json' | 'verifier';

/** The tab a setting groups under in the Settings UI (ADR-0044 Decision G). */
export type SettingTab = 'general' | 'execution' | 'verification' | 'prompts' | 'integrations' | 'security';

export interface SettingSpec {
  readonly scope: SettingScope;
  readonly control: SettingControl;
  readonly tab: SettingTab;
  readonly label: string;
  readonly help: string;
}

export const settingsRegistry = {
  harness: {
    scope: 'overridable',
    control: 'select',
    tab: 'execution',
    label: 'Harness',
    help: 'Which agent harness runs Tasks in this Workspace.',
  },
  model: {
    scope: 'overridable',
    control: 'select',
    tab: 'execution',
    label: 'Model',
    help: 'Default model for Task Runs; inherits the harness default when unset.',
  },
  chatHarness: {
    scope: 'overridable',
    control: 'select',
    tab: 'general',
    label: 'Chat harness',
    help: 'Harness used for conversations in this Workspace.',
  },
  chatModel: {
    scope: 'overridable',
    control: 'select',
    tab: 'general',
    label: 'Chat model',
    help: 'Model used for conversations in this Workspace.',
  },
  isolationMode: {
    scope: 'overridable',
    control: 'select',
    tab: 'execution',
    label: 'Isolation mode',
    help: 'How a Run isolates its working tree (worktree vs direct).',
  },
  priority: {
    scope: 'overridable',
    control: 'select',
    tab: 'execution',
    label: 'Priority',
    help: 'Default scheduling priority for new Tasks.',
  },
  maxConcurrentRuns: {
    scope: 'overridable',
    control: 'number',
    tab: 'execution',
    label: 'Max concurrent Runs',
    help: 'Per-Workspace concurrency cap, clamped to the Machine Ceiling.',
  },
  autoRunnerEnabled: {
    scope: 'overridable',
    control: 'toggle',
    tab: 'execution',
    label: 'Auto-Runner enabled',
    help: 'Whether the Auto-Runner picks up ready Tasks in this Workspace.',
  },
  maxAttempts: {
    scope: 'overridable',
    control: 'number',
    tab: 'execution',
    label: 'Max attempts',
    help: 'How many attempts a Task gets before it escalates.',
  },
  contextReuseTokenLimit: {
    scope: 'overridable',
    control: 'number',
    tab: 'execution',
    label: 'Context reuse token limit',
    help: 'Token ceiling above which a Session is not reused for continuation.',
  },
  integrationRetries: {
    scope: 'overridable',
    control: 'number',
    tab: 'execution',
    label: 'Integration retries',
    help: 'How many times a Run re-attempts integrating when its base branch moves underneath it before deferring.',
  },
  conflictResolveTurns: {
    scope: 'overridable',
    control: 'number',
    tab: 'execution',
    label: 'Conflict resolve turns',
    help: 'How many agentic turns may attempt to resolve a merge conflict before the Run escalates.',
  },
  verificationCommand: {
    scope: 'overridable',
    control: 'verifier',
    tab: 'verification',
    label: 'Verification command',
    help: 'Command verifier(s) run against a candidate before merging.',
  },
  verificationCritic: {
    scope: 'overridable',
    control: 'verifier',
    tab: 'verification',
    label: 'Verification critic',
    help: 'Critic reviewer run against a candidate before merging.',
  },
  guardrailBudget: {
    scope: 'overridable',
    control: 'json',
    tab: 'execution',
    label: 'Budget guardrail',
    help: 'Budget bounds snapshotted onto a Run at start.',
  },
  guardrailProgress: {
    scope: 'overridable',
    control: 'toggle',
    tab: 'execution',
    label: 'Progress guardrail',
    help: 'Whether the progress guardrail is armed for Runs.',
  },
  toolTimeoutMinutes: {
    scope: 'global-only',
    control: 'number',
    tab: 'execution',
    label: 'Tool timeout (minutes)',
    help: 'Hard per-tool-call timeout; instance-wide, not overridable.',
  },
} as const satisfies Record<string, SettingSpec>;

/** A key naming a setting declared in the registry. */
export type SettingKey = keyof typeof settingsRegistry;

/** The registry entry for a setting. */
export function settingSpec(key: SettingKey): SettingSpec {
  return settingsRegistry[key];
}

/** True when the registry declares this setting overridable per Workspace. */
export function isOverridable(key: SettingKey): boolean {
  return settingsRegistry[key].scope === 'overridable';
}

/**
 * True when a Workspace actually overrides this setting: the registry declares
 * it overridable AND the Workspace column holds a value. This is the registry-
 * driven test for *override presence* (e.g. attributing a config's provenance to
 * 'workspace' vs 'default'), so provenance decisions honour the same single
 * authority as value resolution — flip a setting to `global-only` and no column
 * value counts as an override anywhere.
 */
export function hasWorkspaceOverride(key: SettingKey, columnValue: unknown): boolean {
  return isOverridable(key) && Boolean(columnValue);
}

/** The Settings UI tab strip, in display order (ADR-0044 Decision G). Both the
 * global and per-Workspace surfaces render this same taxonomy; a tab with no
 * registry-declared fields still exists on the surface for its bespoke sections
 * (e.g. Prompts, Integrations, Security). */
export const SETTING_TABS: readonly { readonly id: SettingTab; readonly label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'execution', label: 'Execution' },
  { id: 'verification', label: 'Verification' },
  { id: 'prompts', label: 'Prompts' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'security', label: 'Security' },
];

/** The registry keys assigned to a tab, in registry declaration order. */
export function settingsForTab(tab: SettingTab): SettingKey[] {
  return (Object.keys(settingsRegistry) as SettingKey[]).filter((key) => settingsRegistry[key].tab === tab);
}
