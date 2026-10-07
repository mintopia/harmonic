import { Fragment, useState, type ReactNode } from 'react';
import type { AppConfig, Channel, ConfigLayers, Workspace } from '../types';
import { btnGhost, field } from '../ui';
import { Icon } from './Icon';
import { FieldError, PromptField, fieldLabel } from './SettingsSection';
import {
  DRIVE_PLACEHOLDERS,
  TASK_ID_PLACEHOLDER,
  TASK_PLACEHOLDERS,
  compileCriticFragmentPreview,
  compileDrivePreview,
  compileFragmentsOnlyPreview,
  compileFragmentPreview,
  compileEpicRefreshPreview,
  compileMergeConflictPreview,
  COMMIT_NUDGE_PLACEHOLDERS,
  MERGE_CONFLICT_PLACEHOLDERS,
  EPIC_REFRESH_PLACEHOLDERS,
  EPIC_RESOLVE_SUFFIX_PLACEHOLDERS,
  compileTaskIdPreview,
  compileTaskPreview,
  fragmentPlaceholders,
  type CriticRevisionVariant,
  type LabeledPreview,
  type Placeholder,
} from '../prompt-preview-model';
import { setBudgetField, summarizeBudget } from './guardrail-budget-model';
import { ConfigField, registryField, toOptions, withCurrent, type FieldOption, type ScalarDescriptor } from './settings-fields';
import { OverrideField, type OverridableDescriptor } from './settings-override-fields';
import { InheritField } from './InheritField';
import { LayerField } from './LayerField';
import { Switch } from './Switch';
import { CodeRepositorySection, IssueTrackerSection, TriageLabelsSection } from './TrackerSettings';
import { HarnessesSection } from './HarnessSettings';
import { ChannelsSection } from './Channels';
import { PermissionRules } from './PermissionRules';
import { RoutingLabelsEditor } from './RoutingLabelsEditor';
import { SecuritySection } from './SecuritySection';
import { ArchiveRetentionSection, DestinationsSection, ExportSection, RedactionSection } from './ArchiveExportSettings';
import { GlobalVerificationSettings, WorkspaceVerificationSettings } from './VerificationSettings';
import { PROMPT_FRAGMENTS, PROMPT_FRAGMENT_NAMES, promptFragmentOverrideKey, type CriticFragmentName, type PromptFragmentName } from '../../../src/domain/prompt-fragments.js';
import { settingsRegistry, type SettingKey, type SettingTab } from '../../../src/domain/settings-registry.js';
import { WORKSPACE_COLORS } from '../../../src/domain/workspace-colors.js';
import { resolvePromptFragments } from '../../../src/domain/setting-override.js';

export type Surface = 'global' | 'workspace';

/** The render context for the global surface: the whole-config buffer plus the
 * notification channels the Integrations tab edits as immediate side effects. */
export interface GlobalRenderCtx {
  surface: 'global';
  config: AppConfig;
  baseline: AppConfig;
  setConfig: (config: AppConfig) => void;
  errors: Record<string, string>;
  harnessPermissionModes: ConfigLayers['harnessPermissionModes'];
  /** Unsaved edits exist; a Destination test runs against saved settings. */
  dirty?: boolean;
  channels: {
    list: Channel[];
    onToggleEvent: (id: number, event: string) => void;
    onCreated: (channel: Channel) => void;
    onDeleted: (id: number) => void;
  };
}

/** The render context for a Workspace surface: the editable override buffer, the
 * global `config` it inherits from, and the pristine (saved) Workspace the
 * read-only bits (resolved tracker, delete confirm) read. */
export interface WorkspaceRenderCtx {
  surface: 'workspace';
  config: AppConfig;
  workspace: Workspace;
  pristineWorkspace: Workspace;
  setWorkspace: (workspace: Workspace) => void;
  errors: Record<string, string>;
  blockedByRunningTask: boolean;
  onRequestDelete: () => void;
  dirty?: boolean;
}

export type RenderCtx = GlobalRenderCtx | WorkspaceRenderCtx;

type PerSurface<T> = T | { global: T; workspace: T };

function pick<T>(value: PerSurface<T>, surface: Surface): T {
  return value !== null && typeof value === 'object' && 'global' in (value as object)
    ? (value as { global: T; workspace: T })[surface]
    : (value as T);
}


function harnessOptions(config: AppConfig, current: string | null | undefined): FieldOption[] {
  const options = toOptions(Object.keys(config.harnesses));
  if (current && !config.harnesses[current]) return [...options, { value: current, label: `${current} (not configured)` }];
  return options;
}

interface GlobalPrompt {
  id: string;
  label?: string;
  description?: ReactNode;
  errorKey: string;
  get: (c: AppConfig) => string;
  set: (c: AppConfig, value: string) => AppConfig;
  placeholders: Placeholder[];
  compile: (text: string, config: AppConfig) => string | LabeledPreview[];
  rows?: number;
  textareaClass?: string;
}

interface OverridablePrompt {
  key: SettingKey;
  id: string;
  errorKey: string;
  label?: string;
  description?: string;
  get: (w: Workspace) => string | null;
  set: (w: Workspace, value: string | null) => Workspace;
  inherited: (c: AppConfig) => string;
  placeholders: Placeholder[];
  compile: (text: string, config: AppConfig) => string | LabeledPreview[];
  rows?: number;
  textareaClass?: string;
}

function renderGlobalPrompt(d: GlobalPrompt, ctx: GlobalRenderCtx): ReactNode {
  const value = d.get(ctx.config);
  const baseline = d.get(ctx.baseline);
  return (
    <LayerField
      label={d.label ?? ''}
      htmlFor={d.id}
      value={value}
      inheritedValue={baseline}
      inherited={value === baseline}
      dim={false}
      onChange={(next) => ctx.setConfig(d.set(ctx.config, next))}
      onRevert={() => ctx.setConfig(d.set(ctx.config, baseline))}
    >
      {({ value, onChange }) => (
        <PromptField
          id={d.id}
          description={d.description}
          value={value}
          onChange={onChange}
          placeholders={d.placeholders}
          preview={d.compile(value, ctx.config)}
          error={ctx.errors[d.errorKey]}
          rows={d.rows}
          textareaClass={d.textareaClass}
        />
      )}
    </LayerField>
  );
}

function OverridePrompt({
  descriptor,
  config,
  workspace,
  errors,
  onWorkspace,
}: {
  descriptor: OverridablePrompt;
  config: AppConfig;
  workspace: Workspace;
  errors: Record<string, string>;
  onWorkspace: (w: Workspace) => void;
}) {
  const d = descriptor;
  const spec = settingsRegistry[d.key];
  return (
    <LayerField<string>
      label={d.label ?? spec.label}
      htmlFor={d.id}
      value={d.get(workspace) ?? d.inherited(config)}
      inheritedValue={d.inherited(config)}
      inherited={d.get(workspace) === null || d.get(workspace) === undefined}
      onChange={(next) => onWorkspace(d.set(workspace, next))}
      onRevert={() => onWorkspace(d.set(workspace, null))}
    >
      {({ id, value, onChange }) => (
        <PromptField
          id={id ?? d.id}
          description={d.description}
          value={value}
          onChange={onChange}
          placeholders={d.placeholders}
          preview={d.compile(value, { ...config, promptFragments: resolvePromptFragments(workspace, config) })}
          error={errors[d.errorKey]}
          rows={d.rows}
          textareaClass={d.textareaClass}
        />
      )}
    </LayerField>
  );
}


interface ScalarFieldNode {
  kind: 'scalar';
  id: string;
  global: ScalarDescriptor | null;
  workspace: OverridableDescriptor | null;
}

interface PromptFieldNode {
  kind: 'prompt';
  id: string;
  global: GlobalPrompt | null;
  workspace: OverridablePrompt | null;
}

type FieldNode = ScalarFieldNode | PromptFieldNode;

function scalar(global: ScalarDescriptor | null, workspace: OverridableDescriptor | null): ScalarFieldNode {
  return { kind: 'scalar', id: global?.id ?? workspace?.id ?? '', global, workspace };
}

function prompt(id: string, global: GlobalPrompt | null, workspace: OverridablePrompt | null): PromptFieldNode {
  return { kind: 'prompt', id, global, workspace };
}

function renderField(node: FieldNode, ctx: RenderCtx): ReactNode {
  if (node.kind === 'scalar') {
    if (ctx.surface === 'global') {
      return node.global ? (
        <ConfigField key={node.id} descriptor={node.global} config={ctx.config} baseline={ctx.baseline} errors={ctx.errors} onConfig={ctx.setConfig} />
      ) : null;
    }
    return node.workspace ? (
      <OverrideField
        key={node.id}
        descriptor={node.workspace}
        config={ctx.config}
        workspace={ctx.workspace}
        errors={ctx.errors}
        onWorkspace={ctx.setWorkspace}
      />
    ) : null;
  }
  if (ctx.surface === 'global') {
    return node.global ? <Fragment key={node.id}>{renderGlobalPrompt(node.global, ctx)}</Fragment> : null;
  }
  return node.workspace ? (
    <OverridePrompt
      key={node.id}
      descriptor={node.workspace}
      config={ctx.config}
      workspace={ctx.workspace}
      errors={ctx.errors}
      onWorkspace={ctx.setWorkspace}
    />
  ) : null;
}

function grid(className: string, nodes: FieldNode[], ctx: RenderCtx): ReactNode {
  return <div className={className}>{nodes.map((node) => renderField(node, ctx))}</div>;
}

function overrideGrid(
  fields: OverridableDescriptor[],
  className: string,
  ctx: WorkspaceRenderCtx,
): ReactNode {
  return (
    <div className={className}>
      {fields.map((f) => (
        <OverrideField
          key={f.id}
          descriptor={f}
          config={ctx.config}
          workspace={ctx.workspace}
          errors={ctx.errors}
          onWorkspace={ctx.setWorkspace}
        />
      ))}
    </div>
  );
}


const instanceName = scalar(
  {
    id: 'settings-instance-name',
    control: 'text',
    label: 'Name',
    errorKey: 'name',
    placeholder: 'Harmonic',
    widthClass: 'max-w-sm',
    get: (c) => c.name,
    set: (c, raw) => ({ ...c, name: String(raw) }),
  },
  null,
);

const chatHarness = scalar(
  registryField('chatHarness', {
    id: 'settings-chat-harness',
    errorKey: 'chat.harness',
    get: (c) => c.chat.harness,
    options: (c) => toOptions(Object.keys(c.harnesses)),
    set: (c, raw) => {
      const h = String(raw);
      return { ...c, chat: { harness: h, model: c.harnesses[h]?.defaultModel ?? c.chat.model } };
    },
  }),
  {
    key: 'chatHarness',
    id: 'workspace-chat-harness',
    errorKey: 'chatHarness',
    label: 'Harness',
    get: (w) => w.chatHarness,
    set: (w, v) => ({ ...w, chatHarness: v as string | null }),
    inherited: (c) => c.chat.harness,
    options: (c, w) => harnessOptions(c, w.chatHarness),
  },
);

const chatModel = scalar(
  registryField('chatModel', {
    id: 'settings-chat-model',
    errorKey: 'chat.model',
    disabled: (c) => !c.harnesses[c.chat.harness],
    get: (c) => c.chat.model,
    options: (c) => withCurrent(toOptions((c.harnesses[c.chat.harness]?.models ?? []).map((model) => model.id)), c.chat.model),
    set: (c, raw) => ({ ...c, chat: { ...c.chat, model: String(raw) } }),
  }),
  {
    key: 'chatModel',
    id: 'workspace-chat-model',
    errorKey: 'chatModel',
    label: 'Model',
    get: (w) => w.chatModel,
    set: (w, v) => ({ ...w, chatModel: v as string | null }),
    inherited: (c) => c.chat.model,
    options: (c, w) => withCurrent(toOptions((c.harnesses[w.chatHarness ?? c.chat.harness]?.models ?? []).map((model) => model.id)), w.chatModel ?? ''),
  },
);

const taskHarness = scalar(
  registryField('harness', {
    id: 'settings-harness',
    errorKey: 'defaults.harness',
    get: (c) => c.defaults.harness,
    options: (c) => toOptions(Object.keys(c.harnesses)),
    set: (c, raw) => ({ ...c, defaults: { ...c.defaults, harness: String(raw) } }),
  }),
  {
    key: 'harness',
    id: 'workspace-harness',
    errorKey: 'harness',
    get: (w) => w.harness,
    set: (w, v) => ({ ...w, harness: v as string | null }),
    inherited: (c) => c.defaults.harness,
    options: (c, w) => harnessOptions(c, w.harness),
  },
);

const taskModel = scalar(
  registryField('model', {
    id: 'settings-default-model',
    errorKey: (c) => `harnesses.${c.defaults.harness}.defaultModel`,
    disabled: (c) => !c.harnesses[c.defaults.harness],
    get: (c) => c.harnesses[c.defaults.harness]?.defaultModel ?? '',
    options: (c) =>
      withCurrent(toOptions((c.harnesses[c.defaults.harness]?.models ?? []).map((model) => model.id)), c.harnesses[c.defaults.harness]?.defaultModel ?? ''),
    set: (c, raw) => {
      const h = c.defaults.harness;
      const current = c.harnesses[h];
      if (!current) return c;
      return { ...c, harnesses: { ...c.harnesses, [h]: { ...current, defaultModel: String(raw) } } };
    },
  }),
  {
    key: 'model',
    id: 'workspace-model',
    errorKey: 'model',
    get: (w) => w.model,
    set: (w, v) => ({ ...w, model: v as string | null }),
    inherited: (c, w) => c.harnesses[w.harness ?? c.defaults.harness]?.defaultModel ?? '',
    options: (c, w) => withCurrent(toOptions((c.harnesses[w.harness ?? c.defaults.harness]?.models ?? []).map((model) => model.id)), w.model ?? ''),
  },
);

const isolationMode = scalar(
  registryField('isolationMode', {
    id: 'settings-isolation',
    errorKey: 'defaults.isolationMode',
    get: (c) => c.defaults.isolationMode,
    options: () => toOptions(['direct', 'worktree']),
    set: (c, raw) => ({ ...c, defaults: { ...c.defaults, isolationMode: raw as 'direct' | 'worktree' } }),
  }),
  {
    key: 'isolationMode',
    id: 'workspace-isolation',
    errorKey: 'isolationMode',
    get: (w) => w.isolationMode,
    set: (w, v) => ({ ...w, isolationMode: v as 'direct' | 'worktree' | null }),
    inherited: (c) => c.defaults.isolationMode,
    options: () => toOptions(['direct', 'worktree']),
  },
);

const priority = scalar(
  registryField('priority', {
    id: 'settings-priority',
    errorKey: 'defaults.priority',
    get: (c) => c.defaults.priority,
    options: () => toOptions(['high', 'normal', 'low']),
    set: (c, raw) => ({ ...c, defaults: { ...c.defaults, priority: raw as 'high' | 'normal' | 'low' } }),
  }),
  {
    key: 'priority',
    id: 'workspace-priority',
    errorKey: 'priority',
    get: (w) => w.priority,
    set: (w, v) => ({ ...w, priority: v as 'high' | 'normal' | 'low' | null }),
    inherited: (c) => c.defaults.priority,
    options: () => toOptions(['high', 'normal', 'low']),
  },
);

const conflictResolveTurns = scalar(null, {
  key: 'conflictResolveTurns',
  id: 'workspace-conflict-turns',
  errorKey: 'conflictResolveTurns',
  get: (w) => w.conflictResolveTurns,
  set: (w, v) => ({ ...w, conflictResolveTurns: v as number | null }),
  inherited: (c) => c.defaults.conflictResolveTurns,
  min: 0,
});

const autoRunnerEnabled = scalar(
  registryField('autoRunnerEnabled', {
    id: 'settings-autorunner-enabled',
    switchLabel: 'Run ready tasks unattended',
    errorKey: 'autoRunner.enabled',
    get: (c) => c.autoRunner.enabled,
    set: (c, raw) => ({ ...c, autoRunner: { ...c.autoRunner, enabled: Boolean(raw) } }),
  }),
  {
    key: 'autoRunnerEnabled',
    id: 'workspace-autorunner-enabled',
    errorKey: 'autoRunnerEnabled',
    label: 'Enabled',
    switchLabel: 'Run ready tasks unattended',
    get: (w) => w.autoRunnerEnabled,
    set: (w, v) => ({ ...w, autoRunnerEnabled: v as boolean | null }),
    inherited: (c) => c.autoRunner.enabled,
    format: (v) => (v ? 'On' : 'Off'),
  },
);

const hostCeiling = scalar(
  {
    id: 'settings-max-concurrent-attempts',
    control: 'number',
    label: 'Host Ceiling',
    errorKey: 'autoRunner.maxConcurrentAttempts',
    min: 1,
    widthClass: 'w-28',
    get: (c) => c.autoRunner.maxConcurrentAttempts,
    set: (c, raw) => ({ ...c, autoRunner: { ...c.autoRunner, maxConcurrentAttempts: Number(raw) } }),
  },
  null,
);

const concurrencyCap = scalar(null, {
  key: 'maxConcurrentAttempts',
  id: 'workspace-max-concurrent-attempts',
  errorKey: 'maxConcurrentAttempts',
  label: 'Concurrency cap',
  get: (w) => w.maxConcurrentAttempts,
  set: (w, v) => ({ ...w, maxConcurrentAttempts: v as number | null }),
  inherited: (c) => c.autoRunner.maxConcurrentAttempts,
  min: 1,
  max: (c) => c.autoRunner.maxConcurrentAttempts,
});

const maxAttempts = scalar(
  registryField('maxAttempts', {
    id: 'settings-max-attempts',
    errorKey: 'maxAttempts',
    min: 1,
    widthClass: 'w-28',
    get: (c) => c.maxAttempts,
    set: (c, raw) => ({ ...c, maxAttempts: Number(raw) }),
  }),
  {
    key: 'maxAttempts',
    id: 'workspace-max-attempts',
    errorKey: 'maxAttempts',
    get: (w) => w.maxAttempts,
    set: (w, v) => ({ ...w, maxAttempts: v as number | null }),
    inherited: (c) => c.maxAttempts,
    min: 1,
  },
);

const contextReuseTokenLimit = scalar(
  registryField('contextReuseTokenLimit', {
    id: 'settings-context-reuse-token-limit',
    errorKey: 'contextReuseTokenLimit',
    min: 0,
    step: 10_000,
    widthClass: 'w-36',
    get: (c) => c.contextReuseTokenLimit,
    set: (c, raw) => ({ ...c, contextReuseTokenLimit: Number(raw) }),
  }),
  {
    key: 'contextReuseTokenLimit',
    id: 'workspace-context-reuse-token-limit',
    errorKey: 'contextReuseTokenLimit',
    get: (w) => w.contextReuseTokenLimit,
    set: (w, v) => ({ ...w, contextReuseTokenLimit: v as number | null }),
    inherited: (c) => c.contextReuseTokenLimit,
    min: 0,
    step: 10_000,
  },
);

const agentMessagesEnabled = scalar(
  registryField('agentMessagesEnabled', {
    id: 'settings-agent-messages-enabled',
    switchLabel: 'Let Attempts message each other',
    errorKey: 'agentMessages.enabled',
    get: (c) => c.agentMessages.enabled,
    set: (c, raw) => ({ ...c, agentMessages: { ...c.agentMessages, enabled: Boolean(raw) } }),
  }),
  {
    key: 'agentMessagesEnabled',
    id: 'workspace-agent-messages-enabled',
    errorKey: 'agentMessagesEnabled',
    label: 'Enabled',
    switchLabel: 'Let Attempts message each other',
    get: (w) => w.agentMessagesEnabled,
    set: (w, v) => ({ ...w, agentMessagesEnabled: typeof v === 'boolean' ? v : null }),
    inherited: (c) => c.agentMessages.enabled,
    format: (v) => (v ? 'On' : 'Off'),
  },
);

const agentMessagesSendCap = scalar(
  registryField('agentMessagesSendCap', {
    id: 'settings-agent-messages-send-cap',
    errorKey: 'agentMessages.sendCap',
    min: 1,
    widthClass: 'w-28',
    get: (c) => c.agentMessages.sendCap,
    set: (c, raw) => ({ ...c, agentMessages: { ...c.agentMessages, sendCap: Number(raw) } }),
  }),
  {
    key: 'agentMessagesSendCap',
    id: 'workspace-agent-messages-send-cap',
    errorKey: 'agentMessagesSendCap',
    get: (w) => w.agentMessagesSendCap,
    set: (w, v) => ({ ...w, agentMessagesSendCap: typeof v === 'number' ? v : null }),
    inherited: (c) => c.agentMessages.sendCap,
    min: 1,
  },
);

const MERGE_FATE_OPTIONS: FieldOption[] = [
  { value: 'auto-merge', label: 'Merge automatically' },
  { value: 'open-PR', label: 'Open a pull request' },
  { value: 'artifact', label: 'Leave the branch' },
];

const driveMergeFate = scalar(
  registryField('driveMergeFate', {
    id: 'settings-merge-fate',
    errorKey: 'drive.mergeFate',
    get: (c) => c.drive.mergeFate,
    options: () => MERGE_FATE_OPTIONS,
    set: (c, raw) => ({ ...c, drive: { ...c.drive, mergeFate: raw as AppConfig['drive']['mergeFate'] } }),
  }),
  {
    key: 'driveMergeFate',
    id: 'workspace-merge-fate',
    errorKey: 'driveMergeFate',
    get: (w) => w.driveMergeFate,
    set: (w, v) => ({ ...w, driveMergeFate: v as 'auto-merge' | 'open-PR' | 'artifact' | null }),
    inherited: (c) => c.drive.mergeFate,
    options: () => MERGE_FATE_OPTIONS,
  },
);

const driveContinueAttempts = scalar(
  registryField('driveContinueAttempts', {
    id: 'settings-continue-attempts',
    errorKey: 'drive.continueAttempts',
    min: 0,
    widthClass: 'w-28',
    get: (c) => c.drive.continueAttempts,
    set: (c, raw) => ({ ...c, drive: { ...c.drive, continueAttempts: Number(raw) } }),
  }),
  {
    key: 'driveContinueAttempts',
    id: 'workspace-continue-attempts',
    errorKey: 'driveContinueAttempts',
    get: (w) => w.driveContinueAttempts,
    set: (w, v) => ({ ...w, driveContinueAttempts: v as number | null }),
    inherited: (c) => c.drive.continueAttempts,
    min: 0,
  },
);

const taskPromptField = prompt(
  'task-prompt',
  {
    id: 'settings-task-prompt',
    label: 'Task prompt',
    errorKey: 'taskPrompt',
    get: (c) => c.taskPrompt,
    set: (c, v) => ({ ...c, taskPrompt: v }),
    placeholders: TASK_PLACEHOLDERS,
    compile: compileTaskPreview,
    textareaClass: `${field} min-h-36`,
  },
  {
    key: 'taskPrompt',
    id: 'workspace-task-prompt',
    errorKey: 'taskPrompt',
    get: (w) => w.taskPrompt,
    set: (w, v) => ({ ...w, taskPrompt: v }),
    inherited: (c) => c.taskPrompt,
    placeholders: TASK_PLACEHOLDERS,
    compile: compileTaskPreview,
    textareaClass: `${field} min-h-36`,
  },
);

const pauseMessageField = prompt(
  'pause-message',
  {
    id: 'settings-pause-message',
    label: 'Pause message',
    errorKey: 'pauseMessage',
    get: (c) => c.pauseMessage,
    set: (c, v) => ({ ...c, pauseMessage: v }),
    placeholders: [],
    compile: compileFragmentsOnlyPreview,
    textareaClass: `${field} min-h-24`,
  },
  {
    key: 'pauseMessage',
    id: 'workspace-pause-message',
    errorKey: 'pauseMessage',
    get: (w) => w.pauseMessage,
    set: (w, v) => ({ ...w, pauseMessage: v }),
    inherited: (c) => c.pauseMessage,
    placeholders: [],
    compile: compileFragmentsOnlyPreview,
    textareaClass: `${field} min-h-24`,
  },
);

const drivePromptField = prompt(
  'drive-prompt',
  {
    id: 'settings-drive-prompt',
    label: 'Drive prompt',
    errorKey: 'drive.prompt',
    get: (c) => c.drive.prompt,
    set: (c, v) => ({ ...c, drive: { ...c.drive, prompt: v } }),
    placeholders: DRIVE_PLACEHOLDERS,
    compile: compileDrivePreview,
    textareaClass: `${field} min-h-36`,
  },
  {
    key: 'drivePrompt',
    id: 'workspace-drive-prompt',
    errorKey: 'drivePrompt',
    get: (w) => w.drivePrompt,
    set: (w, v) => ({ ...w, drivePrompt: v }),
    inherited: (c) => c.drive.prompt,
    placeholders: DRIVE_PLACEHOLDERS,
    compile: compileDrivePreview,
    textareaClass: `${field} min-h-36`,
  },
);

const unattendedReminderField = prompt(
  'unattended-reminder',
  {
    id: 'settings-unattended-reminder',
    label: 'Unattended reminder',
    description: 'Appended to every auto-driven turn — the checkpoint reminder and the finish/escalate signals.',
    errorKey: 'drive.unattendedReminder',
    get: (c) => c.drive.unattendedReminder,
    set: (c, v) => ({ ...c, drive: { ...c.drive, unattendedReminder: v } }),
    placeholders: TASK_ID_PLACEHOLDER,
    compile: compileTaskIdPreview,
    textareaClass: `${field} min-h-36`,
  },
  {
    key: 'driveUnattendedReminder',
    id: 'workspace-unattended-reminder',
    errorKey: 'driveUnattendedReminder',
    description: 'Appended to every auto-driven turn — the checkpoint reminder and the finish/escalate signals.',
    get: (w) => w.driveUnattendedReminder,
    set: (w, v) => ({ ...w, driveUnattendedReminder: v }),
    inherited: (c) => c.drive.unattendedReminder,
    placeholders: TASK_ID_PLACEHOLDER,
    compile: compileTaskIdPreview,
    textareaClass: `${field} min-h-36`,
  },
);

const continuePromptField = prompt(
  'continue-prompt',
  {
    id: 'settings-continue-prompt',
    label: 'Continue prompt',
    description: 'The re-prompt nudge when a turn ends without finishing. The unattended reminder is appended after it.',
    errorKey: 'drive.continuePrompt',
    get: (c) => c.drive.continuePrompt,
    set: (c, v) => ({ ...c, drive: { ...c.drive, continuePrompt: v } }),
    placeholders: TASK_ID_PLACEHOLDER,
    compile: compileTaskIdPreview,
    textareaClass: `${field} min-h-24`,
  },
  {
    key: 'driveContinuePrompt',
    id: 'workspace-continue-prompt',
    errorKey: 'driveContinuePrompt',
    description: 'The re-prompt nudge when a turn ends without finishing. The unattended reminder is appended after it.',
    get: (w) => w.driveContinuePrompt,
    set: (w, v) => ({ ...w, driveContinuePrompt: v }),
    inherited: (c) => c.drive.continuePrompt,
    placeholders: TASK_ID_PLACEHOLDER,
    compile: compileTaskIdPreview,
    textareaClass: `${field} min-h-24`,
  },
);


const kebab = (name: string): string => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

const CRITIC_PREVIEW_VARIANT: Partial<Record<CriticFragmentName, CriticRevisionVariant>> = {
  criticRevisionIdentical: 'identical',
  criticRevisionAlone: 'alone',
  criticWorkingTreeNote: 'dirty',
};

/** A critic fragment previews as the whole critic prompt it lands in, with the text being edited swapped in. */
function criticFragmentPreview(name: PromptFragmentName) {
  if (!name.startsWith('critic')) return undefined;
  const variant = CRITIC_PREVIEW_VARIANT[name as CriticFragmentName] ?? 'diff';
  return (text: string, c: Pick<AppConfig, 'promptFragments'>) => compileCriticFragmentPreview({ ...c.promptFragments, [name]: text }, variant);
}

const promptFragmentFields = PROMPT_FRAGMENT_NAMES.map((name) => {
  const spec = PROMPT_FRAGMENTS[name];
  const required = spec.required.map((token) => `{${token}}`).join(' ');
  const description = `${spec.help}${required ? ` Must keep ${required}.` : ''}`;
  const key = promptFragmentOverrideKey(name);
  const placeholders = fragmentPlaceholders(name);
  const compile = criticFragmentPreview(name) ?? compileFragmentPreview(name);
  const textareaClass = `${field} min-h-24`;
  return prompt(
    `fragment-${kebab(name)}`,
    {
      id: `settings-fragment-${kebab(name)}`,
      label: spec.label,
      description,
      errorKey: `promptFragments.${name}`,
      get: (c) => c.promptFragments[name],
      set: (c, v) => ({ ...c, promptFragments: { ...c.promptFragments, [name]: v } }),
      placeholders,
      compile,
      textareaClass,
    },
    {
      key,
      id: `workspace-fragment-${kebab(name)}`,
      errorKey: key,
      description,
      get: (w) => w[key],
      set: (w, v) => ({ ...w, [key]: v }),
      inherited: (c) => c.promptFragments[name],
      placeholders,
      compile,
      textareaClass,
    },
  );
});

const commitNudgeField = prompt(
  'commit-nudge',
  {
    id: 'settings-commit-nudge',
    label: 'Commit nudge',
    description: 'Sent when an Attempt finishes its turn with uncommitted changes. No placeholders.',
    errorKey: 'drive.commitNudge',
    get: (c) => c.drive.commitNudge,
    set: (c, v) => ({ ...c, drive: { ...c.drive, commitNudge: v } }),
    placeholders: COMMIT_NUDGE_PLACEHOLDERS,
    compile: compileFragmentsOnlyPreview,
    textareaClass: `${field} min-h-24`,
  },
  {
    key: 'driveCommitNudge',
    id: 'workspace-commit-nudge',
    errorKey: 'driveCommitNudge',
    description: 'Sent when an Attempt finishes its turn with uncommitted changes. No placeholders.',
    get: (w) => w.driveCommitNudge,
    set: (w, v) => ({ ...w, driveCommitNudge: v }),
    inherited: (c) => c.drive.commitNudge,
    placeholders: COMMIT_NUDGE_PLACEHOLDERS,
    compile: compileFragmentsOnlyPreview,
    textareaClass: `${field} min-h-24`,
  },
);

const mergeConflictPromptField = prompt(
  'merge-conflict-prompt',
  {
    id: 'settings-merge-conflict-prompt',
    label: 'Merge conflict resolver',
    description: 'Opens each turn of the agent that resolves a Task merge conflict.',
    errorKey: 'merge.conflictPrompt',
    get: (c) => c.merge.conflictPrompt,
    set: (c, v) => ({ ...c, merge: { ...c.merge, conflictPrompt: v } }),
    placeholders: MERGE_CONFLICT_PLACEHOLDERS,
    compile: compileMergeConflictPreview,
    textareaClass: `${field} min-h-36`,
  },
  {
    key: 'mergeConflictPrompt',
    id: 'workspace-merge-conflict-prompt',
    errorKey: 'mergeConflictPrompt',
    description: 'Opens each turn of the agent that resolves a Task merge conflict.',
    get: (w) => w.mergeConflictPrompt,
    set: (w, v) => ({ ...w, mergeConflictPrompt: v }),
    inherited: (c) => c.merge.conflictPrompt,
    placeholders: MERGE_CONFLICT_PLACEHOLDERS,
    compile: compileMergeConflictPreview,
    textareaClass: `${field} min-h-36`,
  },
);

const epicConflictPromptField = prompt(
  'epic-conflict-prompt',
  {
    id: 'settings-epic-conflict-prompt',
    label: 'Epic merge conflict resolver',
    description: 'Opens each turn of the agent that resolves an Epic integration merge conflict.',
    errorKey: 'merge.epicConflictPrompt',
    get: (c) => c.merge.epicConflictPrompt,
    set: (c, v) => ({ ...c, merge: { ...c.merge, epicConflictPrompt: v } }),
    placeholders: MERGE_CONFLICT_PLACEHOLDERS,
    compile: compileMergeConflictPreview,
    textareaClass: `${field} min-h-36`,
  },
  {
    key: 'mergeEpicConflictPrompt',
    id: 'workspace-epic-conflict-prompt',
    errorKey: 'mergeEpicConflictPrompt',
    description: 'Opens each turn of the agent that resolves an Epic integration merge conflict.',
    get: (w) => w.mergeEpicConflictPrompt,
    set: (w, v) => ({ ...w, mergeEpicConflictPrompt: v }),
    inherited: (c) => c.merge.epicConflictPrompt,
    placeholders: MERGE_CONFLICT_PLACEHOLDERS,
    compile: compileMergeConflictPreview,
    textareaClass: `${field} min-h-36`,
  },
);

const epicRefreshPromptField = prompt(
  'epic-refresh-prompt',
  {
    id: 'settings-epic-refresh-prompt',
    label: 'Epic refresh resolver',
    description: 'Sent to the agent that resolves a conflict when the Epic integration branch is refreshed from the default branch.',
    errorKey: 'merge.epicRefreshPrompt',
    get: (c) => c.merge.epicRefreshPrompt,
    set: (c, v) => ({ ...c, merge: { ...c.merge, epicRefreshPrompt: v } }),
    placeholders: EPIC_REFRESH_PLACEHOLDERS,
    compile: compileEpicRefreshPreview,
    textareaClass: `${field} min-h-36`,
  },
  {
    key: 'mergeEpicRefreshPrompt',
    id: 'workspace-epic-refresh-prompt',
    errorKey: 'mergeEpicRefreshPrompt',
    description: 'Sent to the agent that resolves a conflict when the Epic integration branch is refreshed from the default branch.',
    get: (w) => w.mergeEpicRefreshPrompt,
    set: (w, v) => ({ ...w, mergeEpicRefreshPrompt: v }),
    inherited: (c) => c.merge.epicRefreshPrompt,
    placeholders: EPIC_REFRESH_PLACEHOLDERS,
    compile: compileEpicRefreshPreview,
    textareaClass: `${field} min-h-36`,
  },
);

const epicResolveSuffixField = prompt(
  'epic-resolve-suffix',
  {
    id: 'settings-epic-resolve-suffix',
    label: 'Epic verification resolver suffix',
    description: 'Appended to the Epic resolve prompt (set on the Verification tab) when the agent fixes a failing Epic verification.',
    errorKey: 'verify.epic.resolveSuffix',
    get: (c) => c.verify.epic.resolveSuffix,
    set: (c, v) => ({ ...c, verify: { ...c.verify, epic: { ...c.verify.epic, resolveSuffix: v } } }),
    placeholders: EPIC_RESOLVE_SUFFIX_PLACEHOLDERS,
    compile: compileMergeConflictPreview,
    textareaClass: `${field} min-h-24`,
  },
  {
    key: 'verifyEpicResolveSuffix',
    id: 'workspace-epic-resolve-suffix',
    errorKey: 'verifyEpicResolveSuffix',
    description: 'Appended to the Epic resolve prompt when the agent fixes a failing Epic verification.',
    get: (w) => w.verifyEpicResolveSuffix,
    set: (w, v) => ({ ...w, verifyEpicResolveSuffix: v }),
    inherited: (c) => c.verify.epic.resolveSuffix,
    placeholders: EPIC_RESOLVE_SUFFIX_PLACEHOLDERS,
    compile: compileMergeConflictPreview,
    textareaClass: `${field} min-h-24`,
  },
);

const guardrailScalarFields: OverridableDescriptor[] = [
  {
    key: 'guardrailProgress',
    id: 'workspace-guardrail-progress',
    errorKey: 'guardrailProgress',
    label: 'Progress detector',
    switchLabel: 'Trip a stalled Attempt to Escalation',
    get: (w) => w.guardrailProgress,
    set: (w, v) => ({ ...w, guardrailProgress: v as boolean | null }),
    inherited: (c) => c.guardrails.progress,
    format: (v) => (v ? 'On' : 'Off'),
  },
  {
    key: 'toolTimeoutMinutes',
    id: 'workspace-tool-timeout',
    errorKey: 'toolTimeoutMinutes',
    get: (w) => w.toolTimeoutMinutes,
    set: (w, v) => ({ ...w, toolTimeoutMinutes: v as number | null }),
    inherited: (c) => c.guardrails.toolTimeoutMinutes,
    min: 1,
  },
];

function BudgetFields({
  idPrefix,
  errorPrefix,
  value,
  onChange,
  errors,
}: {
  idPrefix: string;
  errorPrefix: string;
  value: AppConfig['guardrails']['budget'];
  onChange: (budget: AppConfig['guardrails']['budget']) => void;
  errors: Record<string, string>;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div>
        <label className={fieldLabel} htmlFor={`${idPrefix}-wallclock`}>
          Wall-clock (minutes)
        </label>
        <input
          id={`${idPrefix}-wallclock`}
          type="number"
          min={1}
          className={`${field} w-40 tabular-nums`}
          value={value.wallClockMinutes}
          onChange={(e) => onChange(setBudgetField(value, 'wallClockMinutes', e.target.value))}
        />
        <FieldError message={errors[`${errorPrefix}.wallClockMinutes`]} />
      </div>
      <div>
        <label className={fieldLabel} htmlFor={`${idPrefix}-tokens`}>
          Token cap <span className="normal-case text-muted">(blank = no cap)</span>
        </label>
        <input
          id={`${idPrefix}-tokens`}
          type="number"
          min={1}
          placeholder="No cap"
          className={`${field} w-40 tabular-nums`}
          value={value.tokens ?? ''}
          onChange={(e) => onChange(setBudgetField(value, 'tokens', e.target.value))}
        />
        <FieldError message={errors[`${errorPrefix}.tokens`]} />
      </div>
      <div>
        <label className={fieldLabel} htmlFor={`${idPrefix}-cost`}>
          Cost cap (USD) <span className="normal-case text-muted">(blank = no cap)</span>
        </label>
        <input
          id={`${idPrefix}-cost`}
          type="number"
          min={0}
          step="0.01"
          placeholder="No cap"
          className={`${field} w-40 tabular-nums`}
          value={value.costUsd ?? ''}
          onChange={(e) => onChange(setBudgetField(value, 'costUsd', e.target.value))}
        />
        <FieldError message={errors[`${errorPrefix}.costUsd`]} />
      </div>
    </div>
  );
}

function GlobalGuardrails({ ctx }: { ctx: GlobalRenderCtx }) {
  const { config, errors } = ctx;
  const g = config.guardrails;
  const setGuardrails = (guardrails: AppConfig['guardrails']) => ctx.setConfig({ ...config, guardrails });
  const setBudget = (budget: AppConfig['guardrails']['budget']) => setGuardrails({ ...g, budget });
  return (
    <div className="flex flex-col gap-4 sm:max-w-md">
      <div>
        <span className={fieldLabel}>Budget</span>
        <div className="mt-2">
          <BudgetFields idPrefix="settings-budget" errorPrefix="guardrails.budget" value={g.budget} onChange={setBudget} errors={errors} />
        </div>
      </div>
      <div>
        <div className="flex items-center justify-between">
          <span className={fieldLabel}>Progress detector</span>
          <Switch checked={g.progress} onChange={(progress) => setGuardrails({ ...g, progress })}>
            Trip a stalled Attempt to Escalation
          </Switch>
        </div>
      </div>
      <div>
        <label className={fieldLabel} htmlFor="settings-tool-timeout">
          Tool timeout (minutes)
        </label>
        <input
          id="settings-tool-timeout"
          type="number"
          min={1}
          className={`${field} w-40 tabular-nums`}
          value={g.toolTimeoutMinutes}
          onChange={(e) => setGuardrails({ ...g, toolTimeoutMinutes: Number(e.target.value) })}
        />
        <FieldError message={errors['guardrails.toolTimeoutMinutes']} />
      </div>
    </div>
  );
}

function WorkspaceGuardrails({ ctx }: { ctx: WorkspaceRenderCtx }) {
  const { config, workspace, errors } = ctx;
  return (
    <div className="flex flex-col gap-4 sm:max-w-md">
      <div>
        <InheritField
          label="Budget"
          value={workspace.guardrailBudget}
          inherited={config.guardrails.budget}
          format={summarizeBudget}
          onChange={(guardrailBudget) => ctx.setWorkspace({ ...workspace, guardrailBudget })}
        >
          {({ value, onChange }) => (
            <BudgetFields idPrefix="workspace-budget" errorPrefix="guardrailBudget" value={value} onChange={onChange} errors={errors} />
          )}
        </InheritField>
      </div>
      {overrideGrid(guardrailScalarFields, 'flex flex-col gap-4', ctx)}
    </div>
  );
}

function WorkspaceIdentity({ ctx }: { ctx: WorkspaceRenderCtx }) {
  const { workspace, errors } = ctx;
  return (
    <div className="grid gap-3.5 sm:grid-cols-2">
      <div>
        <label className={fieldLabel} htmlFor="workspace-name">Name</label>
        <input
          id="workspace-name"
          className={field}
          value={workspace.name}
          onChange={(e) => ctx.setWorkspace({ ...workspace, name: e.target.value })}
        />
        <FieldError message={errors['name']} />
      </div>
      <div>
        <span className={fieldLabel}>Working directory</span>
        <p className="truncate font-data text-ink" title={workspace.workingDir}>
          {workspace.workingDir}
        </p>
        <p className="mt-1 text-small text-muted">
          Fixed once a Workspace is created — make a new Workspace to point at a different repo.
        </p>
      </div>
      <div className="sm:col-span-2">
        <span className={fieldLabel}>Workspace colour</span>
        <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label="Preferred workspace colours">
          {WORKSPACE_COLORS.map((swatch) => {
            const selected = workspace.color.toUpperCase() === swatch;
            return (
              <button
                key={swatch}
                type="button"
                aria-label={swatch}
                aria-pressed={selected}
                title={swatch}
                className={`size-7 rounded-full transition-transform duration-150 hover:scale-110 ${selected ? 'ring-2 ring-accent ring-offset-2 ring-offset-surface' : 'border border-edge'}`}
                style={{ backgroundColor: swatch }}
                onClick={() => ctx.setWorkspace({ ...workspace, color: swatch })}
              />
            );
          })}
        </div>
        <div className="mt-3 flex flex-wrap items-start gap-5">
          <HslColorSliders color={workspace.color} onChange={(color) => ctx.setWorkspace({ ...workspace, color })} />
          <div className="flex flex-col gap-1.5">
            <label
              className="relative h-12 w-24 cursor-pointer overflow-hidden rounded-md border border-edge ring-1 ring-inset ring-black/10"
              style={{ backgroundColor: workspace.color }}
              title="Open the system colour picker"
            >
              <input
                id="workspace-color"
                type="color"
                aria-label="Workspace colour"
                className="absolute inset-0 size-full cursor-pointer opacity-0"
                value={/^#[0-9a-f]{6}$/i.test(workspace.color) ? workspace.color : '#000000'}
                onChange={(e) => ctx.setWorkspace({ ...workspace, color: e.target.value.toUpperCase() })}
              />
            </label>
            <input
              aria-label="Workspace colour hex value"
              className="w-24 rounded-md border border-edge bg-field px-2 py-1.5 text-center font-data uppercase text-ink focus:border-accent focus:outline-none"
              value={workspace.color}
              maxLength={7}
              onChange={(e) => ctx.setWorkspace({ ...workspace, color: e.target.value.toUpperCase() })}
            />
          </div>
        </div>
        <FieldError message={errors['color']} />
      </div>
    </div>
  );
}

function HslColorSliders({ color, onChange }: { color: string; onChange: (color: string) => void }) {
  const [hue, saturation, lightness] = hexToHsl(color) ?? [0, 0, 50];
  const update = (next: [number, number, number]) => onChange(hslToHex(...next));
  const controls: Array<{ label: string; value: number; max: number; update: (value: number) => void }> = [
    { label: 'Hue', value: hue, max: 360, update: (value) => update([value, saturation, lightness]) },
    { label: 'Saturation', value: saturation, max: 100, update: (value) => update([hue, value, lightness]) },
    { label: 'Lightness', value: lightness, max: 100, update: (value) => update([hue, saturation, value]) },
  ];
  return (
    <div className="grid max-w-md flex-1 basis-64 gap-1.5" aria-label="Fine-tune colour (HSL)">
      {controls.map((control) => (
        <label key={control.label} className="flex items-center gap-2 text-small text-muted">
          <span className="w-16">{control.label}</span>
          <input
            aria-label={`${control.label} (${control.value})`}
            className="h-1.5 flex-1 accent-accent"
            type="range"
            min={0}
            max={control.max}
            value={control.value}
            onChange={(event) => control.update(Number(event.target.value))}
          />
          <output className="w-8 text-right font-data tabular-nums text-faint">{control.value}</output>
        </label>
      ))}
    </div>
  );
}

function hexToHsl(hex: string): [number, number, number] | null {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return null;
  const [red, green, blue] = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const maximum = Math.max(red!, green!, blue!);
  const minimum = Math.min(red!, green!, blue!);
  const delta = maximum - minimum;
  const lightness = (maximum + minimum) / 2;
  if (delta === 0) return [0, 0, Math.round(lightness * 100)];
  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  const hue = maximum === red
    ? 60 * (((green! - blue!) / delta) % 6)
    : maximum === green
      ? 60 * ((blue! - red!) / delta + 2)
      : 60 * ((red! - green!) / delta + 4);
  return [Math.round((hue + 360) % 360), Math.round(saturation * 100), Math.round(lightness * 100)];
}

function hslToHex(hue: number, saturation: number, lightness: number): string {
  const saturationFraction = saturation / 100;
  const lightnessFraction = lightness / 100;
  const chroma = (1 - Math.abs(2 * lightnessFraction - 1)) * saturationFraction;
  const secondary = chroma * (1 - Math.abs((hue / 60) % 2 - 1));
  const match = lightnessFraction - chroma / 2;
  const [red, green, blue] = hue < 60 ? [chroma, secondary, 0] : hue < 120 ? [secondary, chroma, 0] : hue < 180 ? [0, chroma, secondary] : hue < 240 ? [0, secondary, chroma] : hue < 300 ? [secondary, 0, chroma] : [chroma, 0, secondary];
  const channel = (value: number) => Math.round((value + match) * 255).toString(16).padStart(2, '0');
  return `#${channel(red)}${channel(green)}${channel(blue)}`.toUpperCase();
}

function WorkspaceExcludedFolders({ ctx }: { ctx: WorkspaceRenderCtx }) {
  const { workspace } = ctx;
  const [value, setValue] = useState('');
  const list = workspace.excludedDirectories;
  const setList = (next: string[]) => ctx.setWorkspace({ ...workspace, excludedDirectories: next });
  const add = () => {
    const path = value.trim().replace(/^\/+|\/+$/g, '');
    setValue('');
    if (path && !list.includes(path)) setList([...list, path]);
  };
  return (
    <div>
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); add(); }}>
        <input className={`${field} flex-1`} value={value} onChange={(e) => setValue(e.target.value)} placeholder="Relative folder (e.g. dist)" aria-label="Folder to exclude" />
        <button type="submit" className={`${btnGhost} shrink-0`}>Add</button>
      </form>
      {list.length > 0 ? (
        <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Excluded folders">
          {list.map((path) => (
            <li key={path}>
              <button type="button" aria-label={`Remove ${path}`} className="inline-flex items-center gap-1 rounded bg-raised px-2 py-1 font-data text-small text-muted hover:text-ink" onClick={() => setList(list.filter((entry) => entry !== path))}>
                {path}
                <Icon name="close" className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-small text-muted">No folders excluded.</p>
      )}
    </div>
  );
}

function WorkspaceDelete({ ctx }: { ctx: WorkspaceRenderCtx }) {
  return (
    <>
      <button type="button" className={btnGhost} onClick={ctx.onRequestDelete}>
        Delete workspace…
      </button>
      {ctx.blockedByRunningTask && (
        <p className="mt-2 text-small text-muted">
          A Task is running here — stop it before this Workspace can be deleted.
        </p>
      )}
    </>
  );
}


interface SectionNode {
  tab: SettingTab;
  surfaces: Surface[];
  title: PerSurface<string>;
  description: PerSurface<string>;
  body: (ctx: RenderCtx) => ReactNode;
  /** Span both columns of the settings grid — for wide, table-shaped bodies. */
  wide?: boolean;
}

const BOTH: Surface[] = ['global', 'workspace'];

function twoColGrid(surface: Surface): string {
  return surface === 'global' ? 'grid gap-3.5 sm:grid-cols-2' : 'grid gap-4 sm:grid-cols-2';
}

export const SETTINGS_SCHEMA: SectionNode[] = [
  {
    tab: 'general',
    surfaces: ['global'],
    title: 'Instance',
    description:
      'A display name for this Harmonic instance. Shows in the sidebar and the browser title as “Harmonic - {name} - {workspace}”. Leave blank to just show “Harmonic”.',
    body: (ctx) => grid('', [instanceName], ctx),
  },
  {
    tab: 'general',
    surfaces: ['workspace'],
    title: 'Identity',
    description: "This Workspace's name and the project directory it points at.",
    body: (ctx) => (ctx.surface === 'workspace' ? <WorkspaceIdentity ctx={ctx} /> : null),
  },
  {
    tab: 'general',
    surfaces: ['workspace'],
    title: 'Excluded folders',
    description:
      "Folders shown greyed in the Files view and skipped by the live watcher — seeded with the usual build and dependency directories. Right-click a folder in the Files tree to toggle it, or manage the list here.",
    body: (ctx) => (ctx.surface === 'workspace' ? <WorkspaceExcludedFolders ctx={ctx} /> : null),
  },
  {
    tab: 'general',
    surfaces: BOTH,
    title: 'Chat defaults',
    description: {
      global:
        'The Harness and model a new Conversation starts with — separate from the task defaults, so you can chat with a different agent than the one that runs the board. Each Workspace can override these, and every new chat can still change them before its first turn.',
      workspace:
        'The Harness and model new Conversations in this Workspace start with. Each inherits the global chat default until overridden; every chat can still change them before its first turn.',
    },
    body: (ctx) => grid(twoColGrid(ctx.surface), [chatHarness, chatModel], ctx),
  },
  {
    tab: 'general',
    surfaces: ['workspace'],
    title: 'Delete workspace',
    description:
      'Removes this Workspace and everything on its board — Tasks, Attempts, and Conversations. This cannot be undone.',
    body: (ctx) => (ctx.surface === 'workspace' ? <WorkspaceDelete ctx={ctx} /> : null),
  },

  {
    tab: 'execution',
    surfaces: BOTH,
    title: 'Task defaults',
    description: {
      global: 'Pre-filled into every new task; each task can override them.',
      workspace:
        'Pre-filled into every new Task in this Workspace. Each inherits the global default until overridden; a Task can still override them one by one.',
    },
    body: (ctx) =>
      grid(twoColGrid(ctx.surface), [taskHarness, taskModel, isolationMode, priority, conflictResolveTurns], ctx),
  },
  {
    tab: 'execution',
    surfaces: ['global'],
    title: 'Routing Labels',
    wide: true,
    description:
      'Map a tracker label to a Harness and Model. When an issue carries several routing labels, the first one in this list wins.',
    body: (ctx) =>
      ctx.surface === 'global' ? (
        <RoutingLabelsEditor items={ctx.config.routingLabels} config={ctx.config} onChange={(routingLabels) => ctx.setConfig({ ...ctx.config, routingLabels })} />
      ) : null,
  },
  {
    tab: 'execution',
    surfaces: BOTH,
    title: 'Auto-runner',
    description: {
      global: 'Starts ready tasks unattended, up to the concurrency cap.',
      workspace:
        'Whether ready Tasks here run unattended, and how many at once. Both inherit the global defaults until overridden; a cap override can never exceed the Host Ceiling.',
    },
    body: (ctx) =>
      grid(
        ctx.surface === 'global' ? 'flex flex-wrap items-start gap-x-8 gap-y-4' : 'flex flex-col gap-4 sm:max-w-md',
        [autoRunnerEnabled, hostCeiling, concurrencyCap],
        ctx,
      ),
  },
  {
    tab: 'execution',
    surfaces: BOTH,
    title: 'Agent Messages',
    description: {
      global: 'Lets Attempts send each other Agent Messages, up to the send cap per Attempt. Workspaces can override both.',
      workspace: 'Whether Attempts here can send Agent Messages, and how many each may send. Both inherit the global defaults until overridden.',
    },
    body: (ctx) =>
      grid(
        ctx.surface === 'global' ? 'flex flex-wrap items-start gap-x-8 gap-y-4' : 'flex flex-col gap-4 sm:max-w-md',
        [agentMessagesEnabled, agentMessagesSendCap],
        ctx,
      ),
  },
  {
    tab: 'execution',
    surfaces: BOTH,
    title: 'Attempt limit',
    description: {
      global: 'The maximum implementation attempts before a ticket is escalated. Workspaces can override this cap.',
      workspace: 'The maximum implementation attempts before a Task escalates. Inherits the global cap until overridden.',
    },
    body: (ctx) => grid('', [maxAttempts], ctx),
  },
  {
    tab: 'execution',
    surfaces: BOTH,
    title: 'Session reuse',
    description: {
      global:
        'Reuse a warm session into the next attempt while its context is below this many tokens; at or above it, a condensed new session starts. Workspaces can override this.',
      workspace:
        'Reuse a warm session into the next attempt while its context is below this many tokens; at or above it, a condensed new session starts. Inherits the global default until overridden.',
    },
    body: (ctx) => grid('', [contextReuseTokenLimit], ctx),
  },
  {
    tab: 'execution',
    surfaces: BOTH,
    title: 'Attempt guardrails',
    description: {
      global:
        'The budget caps, stall detector, and tool timeout that trip an Attempt to Escalation (ADR-0019). Wall-clock always guards; the token and cost caps are opt-in. Each Workspace can override these defaults.',
      workspace:
        'The budget caps, stall detector, and tool timeout that trip an Attempt here to Escalation (ADR-0019). Each inherits the global default until overridden; wall-clock always guards, the token and cost caps are opt-in.',
    },
    body: (ctx) => (ctx.surface === 'global' ? <GlobalGuardrails ctx={ctx} /> : <WorkspaceGuardrails ctx={ctx} />),
  },

  {
    tab: 'verification',
    surfaces: BOTH,
    title: 'Verification',
    wide: true,
    description: {
      global:
        'Task and Epic verification is configured as independent command and critic lists for each stage.',
      workspace:
        'Global verifiers apply to every Workspace. Here you can reorder or disable them for this Workspace and add its own — the global ones stay locked.',
    },
    body: (ctx) =>
      ctx.surface === 'global' ? (
        <GlobalVerificationSettings config={ctx.config} setConfig={ctx.setConfig} fieldErrors={ctx.errors} />
      ) : (
        <WorkspaceVerificationSettings workspace={ctx.workspace} config={ctx.config} setWorkspace={ctx.setWorkspace} fieldErrors={ctx.errors} />
      ),
  },

  {
    tab: 'prompts',
    surfaces: BOTH,
    title: 'Task prompt',
    description: {
      global:
        "Wraps a native task's own prompt before it's sent to the agent. Placeholders are filled per Task; the default bare {prompt} sends the prompt verbatim. Mirrored tickets use the Drive prompt instead.",
      workspace:
        "Wraps a native Task's own prompt before it's sent to the agent. Inherits the global Task Prompt until overridden; mirrored tickets use the Drive prompt instead.",
    },
    body: (ctx) => renderField(taskPromptField, ctx),
  },
  {
    tab: 'prompts',
    surfaces: BOTH,
    title: 'Drive prompt',
    description: {
      global:
        'The prompt Harmonic sends when it runs a mirrored ticket unattended. Placeholders are filled per Task; merge fate governs what happens to completed work.',
      workspace:
        'How Harmonic drives a mirrored Task unattended here. Each field inherits the global default until overridden; merge fate governs what happens to completed work.',
    },
    body: (ctx) => (
      <div className="flex flex-col gap-4">
        {[drivePromptField, unattendedReminderField, continuePromptField, commitNudgeField].map((p) => renderField(p, ctx))}
        {grid('flex flex-wrap items-start gap-x-8 gap-y-4', [driveMergeFate, driveContinueAttempts], ctx)}
      </div>
    ),
  },
  {
    tab: 'prompts',
    surfaces: BOTH,
    title: 'Pause message',
    description: {
      global: 'Sent to a running Task when it is paused, asking the agent to finish its turn and wait.',
      workspace: 'Sent to a running Task here when it is paused. Inherits the global message until overridden.',
    },
    body: (ctx) => renderField(pauseMessageField, ctx),
  },

  {
    tab: 'prompts',
    surfaces: BOTH,
    title: 'Merge and Epic resolver prompts',
    description: {
      global:
        'What Harmonic sends to the agents that resolve merge conflicts and Epic verification failures. Edits apply to the next resolver turn.',
      workspace:
        'What Harmonic sends to the agents that resolve merge conflicts and Epic verification failures here. Each field inherits the global default until overridden.',
    },
    body: (ctx) => (
      <div className="flex flex-col gap-4">
        {[mergeConflictPromptField, epicConflictPromptField, epicRefreshPromptField, epicResolveSuffixField].map((p) => renderField(p, ctx))}
      </div>
    ),
  },

  {
    tab: 'prompts',
    surfaces: BOTH,
    wide: true,
    title: 'Prompt fragments',
    description: {
      global:
        'Named pieces of prompt text defined once and referenced from prompts as {fragment.<name>}. Edit a fragment here and every prompt that references it changes.',
      workspace:
        'Named pieces of prompt text shared across prompts. Each inherits the global fragment until overridden.',
    },
    body: (ctx) => (
      <div className="grid items-start gap-4 xl:grid-cols-2">
        {promptFragmentFields.map((f) => renderField(f, ctx))}
      </div>
    ),
  },

  {
    tab: 'integrations',
    surfaces: ['workspace'],
    title: 'Issue Tracker',
    description:
      'Mirror this Workspace’s issue tracker onto the board as Tasks. The Configured Tracker wins over the repo’s docs/agents/issue-tracker.md, which wins over the Code Repository.',
    body: (ctx) => (ctx.surface === 'workspace' ? <IssueTrackerSection ctx={ctx} /> : null),
  },
  {
    tab: 'integrations',
    surfaces: ['workspace'],
    title: 'Code Repository',
    description: 'The forge that hosts this Workspace’s branches, PRs/MRs and Merges. Detected from the origin remote unless overridden.',
    body: (ctx) => (ctx.surface === 'workspace' ? <CodeRepositorySection ctx={ctx} /> : null),
  },
  {
    tab: 'integrations',
    surfaces: ['workspace'],
    title: 'Triage Labels',
    description: 'The label names the tracker uses for each role Harmonic acts on. Empty roles use the repo’s docs/agents/triage-labels.md, then the defaults.',
    body: (ctx) => (ctx.surface === 'workspace' ? <TriageLabelsSection ctx={ctx} /> : null),
  },
  {
    tab: 'integrations',
    surfaces: ['global'],
    title: 'Harnesses',
    description: 'The agent CLIs Harmonic drives over ACP — command, environment, and models.',
    wide: true,
    body: (ctx) =>
      ctx.surface === 'global' ? (
        <HarnessesSection config={ctx.config} baseline={ctx.baseline} fieldErrors={ctx.errors} permissionModes={ctx.harnessPermissionModes} onChange={(harnesses) => ctx.setConfig({ ...ctx.config, harnesses })} />
      ) : null,
  },
  {
    tab: 'integrations',
    surfaces: ['global'],
    title: 'Notifications',
    description:
      'Channels that receive task and queue events. Event subscriptions save with the bar; adding or removing a channel applies immediately.',
    body: (ctx) =>
      ctx.surface === 'global' ? (
        <ChannelsSection
          channels={ctx.channels.list}
          onToggleEvent={ctx.channels.onToggleEvent}
          onCreated={ctx.channels.onCreated}
          onDeleted={ctx.channels.onDeleted}
        />
      ) : null,
  },

  {
    tab: 'security',
    surfaces: ['global'],
    title: 'Permission rules',
    description:
      "Persistent 'Always allow' choices from Conversation permission prompts — each auto-approves a tool kind in a Working Directory across Conversations. Revoking one makes matching requests prompt again.",
    body: () => <PermissionRules />,
  },
  {
    tab: 'security',
    surfaces: ['global'],
    title: 'Security',
    description: 'The operator password for this console.',
    body: () => <SecuritySection />,
  },

  {
    tab: 'archive',
    surfaces: BOTH,
    title: 'Archive retention',
    description:
      'Every Task keeps a raw file Archive. Leave both limits blank to keep Archives forever. Archives are never pruned while an Export is pending or failed.',
    body: (ctx) => <ArchiveRetentionSection ctx={ctx} />,
  },
  {
    tab: 'archive',
    surfaces: BOTH,
    title: 'Export',
    description: {
      global: 'Build a redacted .tar.gz of the Archive when a Task reaches a terminal disposition and deliver it to every enabled Destination.',
      workspace: 'Whether this Workspace exports Task Archives on a terminal disposition. Inherits the global setting until overridden.',
    },
    body: (ctx) => <ExportSection ctx={ctx} />,
  },
  {
    tab: 'archive',
    surfaces: BOTH,
    title: 'Export Destinations',
    wide: true,
    description: {
      global:
        'Each Destination receives every Export independently — one failing never blocks the other. A failed Destination is retried 3 times (5 min, 30 min, 2 h), then left for a manual Export again on the Ticket.',
      workspace:
        'Each field inherits the global Destination until overridden. A failed Destination is retried 3 times (5 min, 30 min, 2 h), then left for a manual Export again on the Ticket.',
    },
    body: (ctx) => <DestinationsSection ctx={ctx} />,
  },
  {
    tab: 'archive',
    surfaces: BOTH,
    title: 'Redaction patterns',
    wide: true,
    description: 'Applied at Export time only. Matches are replaced with [REDACTED:<pattern-id>]. The local Archive stays raw.',
    body: (ctx) => <RedactionSection ctx={ctx} />,
  },
];

/** The sections a surface renders for one tab, in schema order. */
export function sectionsForTab(surface: Surface, tab: SettingTab): SectionNode[] {
  return SETTINGS_SCHEMA.filter((s) => s.tab === tab && s.surfaces.includes(surface));
}

/** Render a section's card title/description/body for a surface. */
export function renderSection(section: SectionNode, ctx: RenderCtx): { title: string; description: string; body: ReactNode } {
  return {
    title: pick(section.title, ctx.surface),
    description: pick(section.description, ctx.surface),
    body: section.body(ctx),
  };
}
