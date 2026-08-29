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
export type SettingControl = 'select' | 'toggle' | 'number' | 'text' | 'json' | 'verifier';

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
    help: 'Default model for Task Attempts; inherits the harness default when unset.',
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
    label: 'Max concurrent Attempts',
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
    help: 'Command verifier(s) run against the verified head before merging.',
  },
  reviewEnabled: {
    scope: 'overridable',
    control: 'toggle',
    tab: 'verification',
    label: 'Review enabled',
    help: 'Whether an agent critic reviews the verified head before merging.',
  },
  reviewPrompt: {
    scope: 'overridable',
    control: 'text',
    tab: 'verification',
    label: 'Review prompt',
    help: 'Prompt the critic reviewer runs with; inherits the global prompt unless overridden.',
  },
  reviewModel: {
    scope: 'overridable',
    control: 'select',
    tab: 'verification',
    label: 'Review model',
    help: 'Model the critic reviewer uses; inherits the global model unless overridden.',
  },
  reviewHarness: {
    scope: 'overridable',
    control: 'select',
    tab: 'verification',
    label: 'Review harness',
    help: 'Harness the critic reviewer runs on; inherits the global harness (or the builder task) unless overridden.',
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
    help: 'Whether the progress guardrail is armed for Attempts.',
  },
  toolTimeoutMinutes: {
    scope: 'overridable',
    control: 'number',
    tab: 'execution',
    label: 'Tool timeout (minutes)',
    help: 'Hard per-tool-call timeout; overridable per Workspace (ADR-0044) — repos differ in tolerance for slow tools.',
  },
  // Drive settings (ADR-0044): the `drive.*` block decomposes into five
  // independently-inheritable fields, each overridable per Workspace — repos
  // genuinely differ in merge policy and how a mirrored Task is framed/driven.
  drivePrompt: {
    scope: 'overridable',
    control: 'text',
    tab: 'prompts',
    label: 'Drive Prompt',
    help: 'Template Harmonic injects to auto-drive a mirrored Task; inherits the global Drive Prompt when unset.',
  },
  driveUnattendedReminder: {
    scope: 'overridable',
    control: 'text',
    tab: 'prompts',
    label: 'Unattended reminder',
    help: 'Appended to every auto-driven turn to keep the agent working unattended; inherits the global default when unset.',
  },
  driveContinuePrompt: {
    scope: 'overridable',
    control: 'text',
    tab: 'prompts',
    label: 'Continue prompt',
    help: 'Re-prompt nudge for an auto-driven Run that ended its turn without finishing; inherits the global default when unset.',
  },
  driveMergeFate: {
    scope: 'overridable',
    control: 'select',
    tab: 'execution',
    label: 'Merge fate',
    help: 'What becomes of a completed auto-driven Run — auto-merge, open a PR, or leave an artifact; inherits the global default when unset.',
  },
  driveContinueAttempts: {
    scope: 'overridable',
    control: 'number',
    tab: 'execution',
    label: 'Continue attempts',
    help: 'How many times an unfinished auto-driven Run is re-prompted before it is treated as unresolved; inherits the global default when unset.',
  },
  taskPrompt: {
    scope: 'overridable',
    control: 'text',
    tab: 'prompts',
    label: 'Task Prompt',
    help: "Template wrapping a native Task's own prompt; inherits the global Task Prompt when unset.",
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
 *
 * Presence is `!= null`, not truthiness: for a boolean scalar like `reviewEnabled`
 * or `guardrailProgress`, an explicit `false` is a deliberate override (the
 * Workspace turned the setting off) and must be distinguished from `null`/inherit.
 */
export function hasWorkspaceOverride(key: SettingKey, columnValue: unknown): boolean {
  return isOverridable(key) && columnValue != null;
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

/**
 * The tab strip the per-Workspace surface renders (ADR-0044 Decision G: "the
 * same renderer with the inherit layer enabled and `global-only` tabs hidden").
 * A tab appears only when it holds at least one overridable field, so tabs whose
 * settings are all instance-wide (Integrations, Security) drop off the Workspace
 * surface by construction rather than by a hand-kept exclusion list.
 */
export function workspaceTabs(): { readonly id: SettingTab; readonly label: string }[] {
  return SETTING_TABS.filter((tab) => settingsForTab(tab.id).some((key) => isOverridable(key)));
}
