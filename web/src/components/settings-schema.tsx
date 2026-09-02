import { Fragment, type ReactNode } from 'react';
import type { AppConfig, Channel, VerificationCritic, VerificationReview, Workspace } from '../types';
import { btnGhost, field, selectField } from '../ui';
import { FieldError, PromptField, fieldLabel } from './SettingsSection';
import {
  DRIVE_PLACEHOLDERS,
  TASK_ID_PLACEHOLDER,
  TASK_PLACEHOLDERS,
  compileCriticPreview,
  compileDrivePreview,
  compileTaskIdPreview,
  compileTaskPreview,
  type LabeledPreview,
} from '../prompt-preview-model';
import { ModelCombobox } from './ModelCombobox';
import { Switch } from './Switch';
import {
  EMPTY_CRITIC,
  missingReviewInput,
  reviewUnrunnable,
  setCriticField,
  summarizeCommands,
  type ResolvedReviewInputs,
} from './verification-override-model';
import { setBudgetField, summarizeBudget } from './guardrail-budget-model';
import { CommandListEditor } from './CommandListEditor';
import { ConfigField, registryField, toOptions, withCurrent, type FieldOption, type ScalarDescriptor } from './settings-fields';
import { OverrideField, type OverridableDescriptor } from './settings-override-fields';
import { InheritField } from './InheritField';
import { LayerField } from './LayerField';
import { HarnessesSection } from './HarnessSettings';
import { ChannelsSection } from './Channels';
import { PermissionRules } from './PermissionRules';
import { SecuritySection } from './SecuritySection';
import { settingsRegistry, type SettingKey, type SettingTab } from '../../../src/domain/settings-registry.js';

export type Surface = 'global' | 'workspace';

/** The render context for the global surface: the whole-config buffer plus the
 * notification channels the Integrations tab edits as immediate side effects. */
export interface GlobalRenderCtx {
  surface: 'global';
  config: AppConfig;
  baseline: AppConfig;
  setConfig: (config: AppConfig) => void;
  errors: Record<string, string>;
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
  placeholders: [string, string][];
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
  placeholders: [string, string][];
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
          preview={d.compile(value, config)}
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

const machineCeiling = scalar(
  {
    id: 'settings-max-concurrent-attempts',
    control: 'number',
    label: 'Machine Ceiling',
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

const driveMergeFate = scalar(
  registryField('driveMergeFate', {
    id: 'settings-merge-fate',
    errorKey: 'drive.mergeFate',
    get: (c) => c.drive.mergeFate,
    options: () => toOptions(['auto-merge', 'open-PR', 'artifact']),
    set: (c, raw) => ({ ...c, drive: { ...c.drive, mergeFate: raw as AppConfig['drive']['mergeFate'] } }),
  }),
  {
    key: 'driveMergeFate',
    id: 'workspace-merge-fate',
    errorKey: 'driveMergeFate',
    get: (w) => w.driveMergeFate,
    set: (w, v) => ({ ...w, driveMergeFate: v as 'auto-merge' | 'open-PR' | 'artifact' | null }),
    inherited: (c) => c.drive.mergeFate,
    options: () => toOptions(['auto-merge', 'open-PR', 'artifact']),
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


function ReviewUnrunnableNote({ review }: { review: ResolvedReviewInputs }) {
  if (!reviewUnrunnable(review)) return null;
  const missing = missingReviewInput(review);
  return (
    <p className="rounded-sm bg-fail-tint px-2.5 py-2 text-small text-fail">
      Review is enabled but resolves to no {missing} — it will be flagged unrunnable and never run. Set a review {missing}{' '}
      or turn review off.
    </p>
  );
}

function GlobalVerification({ ctx }: { ctx: GlobalRenderCtx }) {
  const config = ctx.config;
  const fieldErrors = ctx.errors;
  const onChange = (verify: AppConfig['verify']) => ctx.setConfig({ ...config, verify });
  const v = config.verify;
  const setReview = (review: VerificationReview) => onChange({ ...v, review });
  const reviewCritic: VerificationCritic = {
    prompt: v.review.prompt ?? '',
    model: v.review.model ?? '',
    ...(v.review.harness ? { harness: v.review.harness } : {}),
  };
  const setCritic = (critic: VerificationCritic) => setReview({ enabled: true, ...critic });
  return (
    <div className="flex flex-col gap-4 sm:max-w-md">
      <ReviewUnrunnableNote review={{ requested: v.review.enabled, model: v.review.model, prompt: v.review.prompt }} />
      <CommandListEditor
        commands={v.commands}
        onChange={(commands) => onChange({ ...v, commands })}
        idPrefix="settings-verify"
        errorPrefix="verify.commands"
        fieldErrors={fieldErrors}
        emptyText="No commands configured."
      />
      <div>
        <div className="flex items-center justify-between">
          <span className={fieldLabel}>Review</span>
          <Switch checked={v.review.enabled} onChange={(enabled) => setReview(enabled ? { enabled: true, ...EMPTY_CRITIC } : { enabled: false })}>
            Enabled
          </Switch>
        </div>
        {v.review.enabled && (
          <div className="mt-3 flex flex-col gap-3">
            <div>
              <label className={fieldLabel} htmlFor="settings-critic-harness">Harness</label>
              <select
                id="settings-critic-harness"
                className={`${selectField} w-full`}
                value={reviewCritic.harness ?? ''}
                onChange={(e) => setCritic(setCriticField(reviewCritic, 'harness', e.target.value))}
              >
                <option value="">Same as task</option>
                {Object.keys(config.harnesses).map((h) => (
                  <option key={h} value={h}>
                    {h}
                  </option>
                ))}
              </select>
              <FieldError message={fieldErrors['verify.review.harness']} />
            </div>
            <div>
              <label className={fieldLabel} htmlFor="settings-critic-model">Model</label>
              <ModelCombobox
                id="settings-critic-model"
                value={reviewCritic.model}
                onChange={(m) => setCritic(setCriticField(reviewCritic, 'model', m))}
                options={reviewCritic.harness ? (config.harnesses[reviewCritic.harness]?.models ?? []).map((model) => model.id) : []}
              />
              <FieldError message={fieldErrors['verify.review.model']} />
            </div>
            <PromptField
              id="settings-critic-prompt"
              label="Review prompt"
              description="The critic reads the candidate checkout and the issue itself (read-only). Harmonic appends the read-only instruction and the JSON verdict contract — see the compiled preview."
              rows={3}
              value={reviewCritic.prompt}
              onChange={(promptText) => setCritic(setCriticField(reviewCritic, 'prompt', promptText))}
              placeholders={DRIVE_PLACEHOLDERS}
              preview={compileCriticPreview(reviewCritic.prompt)}
              error={fieldErrors['verify.review.prompt']}
            />
          </div>
        )}
      </div>
    </div>
  );
}

const reviewScalarFields: OverridableDescriptor[] = [
  {
    key: 'reviewEnabled',
    id: 'workspace-review-enabled',
    errorKey: 'reviewEnabled',
    switchLabel: 'Enabled',
    get: (w) => w.reviewEnabled,
    set: (w, v) => ({ ...w, reviewEnabled: v as boolean | null }),
    inherited: (c) => c.verify.review.enabled,
    format: (v) => (v ? 'On' : 'Off'),
  },
  {
    key: 'reviewHarness',
    id: 'workspace-review-harness',
    errorKey: 'reviewHarness',
    get: (w) => w.reviewHarness,
    set: (w, v) => ({ ...w, reviewHarness: v as string | null }),
    inherited: (c) => c.verify.review.harness ?? (Object.keys(c.harnesses)[0] ?? ''),
    options: (c) => toOptions(Object.keys(c.harnesses)),
    format: (h) => (h ? String(h) : 'Same as task (builder harness)'),
  },
  {
    key: 'reviewModel',
    id: 'workspace-review-model',
    errorKey: 'reviewModel',
    get: (w) => w.reviewModel,
    set: (w, v) => ({ ...w, reviewModel: v as string | null }),
    inherited: (c) => c.verify.review.model ?? '',
    format: (m) => (m ? String(m) : 'Not configured'),
    renderControl: ({ id, value, onChange }, { config, workspace }) => {
      const reviewHarnessEff = (workspace.reviewHarness ?? config.verify.review.harness) || undefined;
      return (
        <ModelCombobox
          id={id}
          value={String(value)}
          onChange={onChange}
          options={reviewHarnessEff ? (config.harnesses[reviewHarnessEff]?.models ?? []).map((model) => model.id) : []}
        />
      );
    },
  },
];

const reviewPromptField: OverridablePrompt = {
  key: 'reviewPrompt',
  id: 'workspace-review-prompt',
  errorKey: 'reviewPrompt',
  get: (w) => w.reviewPrompt,
  set: (w, v) => ({ ...w, reviewPrompt: v }),
  inherited: (c) => c.verify.review.prompt ?? '',
  placeholders: DRIVE_PLACEHOLDERS,
  compile: compileCriticPreview,
  rows: 3,
};

function WorkspaceVerification({ ctx }: { ctx: WorkspaceRenderCtx }) {
  const { config, workspace, errors } = ctx;
  const resolvedReview: ResolvedReviewInputs = {
    requested: Boolean(workspace.reviewEnabled ?? config.verify.review.enabled),
    model: workspace.reviewModel ?? config.verify.review.model,
    prompt: workspace.reviewPrompt ?? config.verify.review.prompt,
  };
  return (
    <div className="flex flex-col gap-4 sm:max-w-md">
      <ReviewUnrunnableNote review={resolvedReview} />
      <div>
        <InheritField
          label="Command verifier"
          value={workspace.verificationCommand}
          inherited={config.verify.commands}
          format={summarizeCommands}
          onChange={(verificationCommand) => ctx.setWorkspace({ ...workspace, verificationCommand })}
        >
          {({ value, onChange }) => (
            <CommandListEditor
              commands={value}
              onChange={onChange}
              idPrefix="workspace-verify"
              errorPrefix="verificationCommand"
              fieldErrors={errors}
              emptyText="No commands — verification runs nothing in this workspace."
            />
          )}
        </InheritField>
      </div>
      {overrideGrid(reviewScalarFields, 'flex flex-col gap-4', ctx)}
      <OverridePrompt descriptor={reviewPromptField} config={config} workspace={workspace} errors={errors} onWorkspace={ctx.setWorkspace} />
    </div>
  );
}

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

function GlobalGuardrails({ ctx }: { ctx: GlobalRenderCtx }) {
  const { config, errors } = ctx;
  const g = config.guardrails;
  const setGuardrails = (guardrails: AppConfig['guardrails']) => ctx.setConfig({ ...config, guardrails });
  const setBudget = (budget: AppConfig['guardrails']['budget']) => setGuardrails({ ...g, budget });
  return (
    <div className="flex flex-col gap-4 sm:max-w-md">
      <div>
        <span className={fieldLabel}>Budget</span>
        <div className="mt-2 flex flex-col gap-3">
          <div>
            <label className={fieldLabel} htmlFor="settings-budget-wallclock">
              Wall-clock (minutes)
            </label>
            <input
              id="settings-budget-wallclock"
              type="number"
              min={1}
              className={`${field} w-40 tabular-nums`}
              value={g.budget.wallClockMinutes}
              onChange={(e) => setBudget(setBudgetField(g.budget, 'wallClockMinutes', e.target.value))}
            />
            <FieldError message={errors['guardrails.budget.wallClockMinutes']} />
          </div>
          <div>
            <label className={fieldLabel} htmlFor="settings-budget-tokens">
              Token cap <span className="normal-case text-muted">(blank = no cap)</span>
            </label>
            <input
              id="settings-budget-tokens"
              type="number"
              min={1}
              placeholder="No cap"
              className={`${field} w-40 tabular-nums`}
              value={g.budget.tokens ?? ''}
              onChange={(e) => setBudget(setBudgetField(g.budget, 'tokens', e.target.value))}
            />
            <FieldError message={errors['guardrails.budget.tokens']} />
          </div>
          <div>
            <label className={fieldLabel} htmlFor="settings-budget-cost">
              Cost cap (USD) <span className="normal-case text-muted">(blank = no cap)</span>
            </label>
            <input
              id="settings-budget-cost"
              type="number"
              min={0}
              step="0.01"
              placeholder="No cap"
              className={`${field} w-40 tabular-nums`}
              value={g.budget.costUsd ?? ''}
              onChange={(e) => setBudget(setBudgetField(g.budget, 'costUsd', e.target.value))}
            />
            <FieldError message={errors['guardrails.budget.costUsd']} />
          </div>
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
            <div className="flex flex-col gap-3">
              <div>
                <label className={fieldLabel} htmlFor="workspace-budget-wallclock">
                  Wall-clock (minutes)
                </label>
                <input
                  id="workspace-budget-wallclock"
                  type="number"
                  min={1}
                  className={`${field} w-40 tabular-nums`}
                  value={value.wallClockMinutes}
                  onChange={(e) => onChange(setBudgetField(value, 'wallClockMinutes', e.target.value))}
                />
                <FieldError message={errors['guardrailBudget.wallClockMinutes']} />
              </div>
              <div>
                <label className={fieldLabel} htmlFor="workspace-budget-tokens">
                  Token cap <span className="normal-case text-muted">(blank = no cap)</span>
                </label>
                <input
                  id="workspace-budget-tokens"
                  type="number"
                  min={1}
                  placeholder="No cap"
                  className={`${field} w-40 tabular-nums`}
                  value={value.tokens ?? ''}
                  onChange={(e) => onChange(setBudgetField(value, 'tokens', e.target.value))}
                />
                <FieldError message={errors['guardrailBudget.tokens']} />
              </div>
              <div>
                <label className={fieldLabel} htmlFor="workspace-budget-cost">
                  Cost cap (USD) <span className="normal-case text-muted">(blank = no cap)</span>
                </label>
                <input
                  id="workspace-budget-cost"
                  type="number"
                  min={0}
                  step="0.01"
                  placeholder="No cap"
                  className={`${field} w-40 tabular-nums`}
                  value={value.costUsd ?? ''}
                  onChange={(e) => onChange(setBudgetField(value, 'costUsd', e.target.value))}
                />
                <FieldError message={errors['guardrailBudget.costUsd']} />
              </div>
            </div>
          )}
        </InheritField>
      </div>
      {overrideGrid(guardrailScalarFields, 'flex flex-col gap-4', ctx)}
    </div>
  );
}

const RESOLVE_FAILURE_LABEL: Record<string, string> = {
  'no-declaration': 'No tracker declared',
  unsupported: 'Unsupported tracker',
  misconfigured: 'Tracker misconfigured',
};

function ResolvedTrackerValue({ workspace }: { workspace: Workspace }) {
  const resolved = workspace.resolvedTracker;
  if (!resolved) {
    return (
      <p className="pt-1 text-small text-muted">
        {workspace.trackerEnabled ? 'Resolving…' : 'Enable mirroring to resolve the tracker.'}
      </p>
    );
  }
  if (resolved.ok) {
    return <p className="pt-1 font-medium text-ink">{resolved.label}</p>;
  }
  const friendly = (resolved.code && RESOLVE_FAILURE_LABEL[resolved.code]) ?? 'Cannot resolve tracker';
  return (
    <p className="pt-1 text-fail" title={resolved.reason ?? undefined}>
      {friendly}
    </p>
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
    </div>
  );
}

function WorkspaceTracker({ ctx }: { ctx: WorkspaceRenderCtx }) {
  const { workspace, pristineWorkspace, errors } = ctx;
  return (
    <div className="flex flex-wrap items-start gap-x-8 gap-y-4">
      <div>
        <span className={fieldLabel}>Enabled</span>
        <div className="pt-1">
          <Switch
            checked={workspace.trackerEnabled}
            onChange={(trackerEnabled) => ctx.setWorkspace({ ...workspace, trackerEnabled })}
          >
            Mirror tracker issues onto the board
          </Switch>
        </div>
      </div>
      <div>
        <label className={fieldLabel} htmlFor="workspace-poll-interval">Poll interval (seconds)</label>
        <input
          id="workspace-poll-interval"
          type="number"
          min={5}
          className={`${field} w-28 tabular-nums`}
          value={workspace.trackerPollIntervalSeconds}
          onChange={(e) => ctx.setWorkspace({ ...workspace, trackerPollIntervalSeconds: Number(e.target.value) })}
        />
        <FieldError message={errors['trackerPollIntervalSeconds']} />
      </div>
      <div>
        <span className={fieldLabel}>Resolved tracker</span>
        <ResolvedTrackerValue workspace={pristineWorkspace} />
      </div>
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
    title: 'Tracker mirroring',
    description:
      'Poll this Workspace’s issue tracker and mirror its issues onto the board as Tasks. Needs docs/agents/issue-tracker.md in the repo and gh (GitHub) auth.',
    body: (ctx) => (ctx.surface === 'workspace' ? <WorkspaceTracker ctx={ctx} /> : null),
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
    surfaces: BOTH,
    title: 'Auto-runner',
    description: {
      global: 'Starts ready tasks unattended, up to the concurrency cap.',
      workspace:
        'Whether ready Tasks here run unattended, and how many at once. Both inherit the global defaults until overridden; a cap override can never exceed the Machine Ceiling.',
    },
    body: (ctx) =>
      grid(
        ctx.surface === 'global' ? 'flex flex-wrap items-start gap-x-8 gap-y-4' : 'flex flex-col gap-4 sm:max-w-md',
        [autoRunnerEnabled, machineCeiling, concurrencyCap],
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
    description: {
      global:
        'Commands run in order and stop at the first failure. An optional review runs after every command passes. Each Workspace can override these defaults.',
      workspace:
        'Commands run in order and stop at the first failure. Review runs only after they pass. This Workspace can override the global default.',
    },
    body: (ctx) => (ctx.surface === 'global' ? <GlobalVerification ctx={ctx} /> : <WorkspaceVerification ctx={ctx} />),
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
        {[drivePromptField, unattendedReminderField, continuePromptField].map((p) => renderField(p, ctx))}
        {grid('flex flex-wrap items-start gap-x-8 gap-y-4', [driveMergeFate, driveContinueAttempts], ctx)}
      </div>
    ),
  },

  {
    tab: 'integrations',
    surfaces: ['global'],
    title: 'Harnesses',
    description: 'The agent CLIs Harmonic drives over ACP — command, environment, and models.',
    body: (ctx) =>
      ctx.surface === 'global' ? (
        <HarnessesSection config={ctx.config} fieldErrors={ctx.errors} onChange={(harnesses) => ctx.setConfig({ ...ctx.config, harnesses })} />
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
