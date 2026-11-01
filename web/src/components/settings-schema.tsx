import { useState, type ReactNode } from 'react';
import type { AppConfig, Channel, ConfigLayers, ExportDeliveryState, Workspace } from '../types';
import { btnGhost, field } from '../ui';
import { Icon } from './Icon';
import { FieldError, fieldLabel } from './SettingsSection';
import { setBudgetField, summarizeBudget } from './guardrail-budget-model';
import { ConfigField, registryField, toOptions, withCurrent, type FieldOption, type ScalarDescriptor } from './settings-fields';
import { OverrideField, type OverridableDescriptor } from './settings-override-fields';
import { InheritField } from './InheritField';
import { Switch } from './Switch';
import { CodeRepositorySection, IssueTrackerSection, TriageLabelsSection } from './TrackerSettings';
import { HarnessesSection } from './HarnessSettings';
import { ChannelsSection } from './Channels';
import { PermissionRules } from './PermissionRules';
import { RoutingLabelOverlayEditor } from './RoutingLabelOverlayEditor';
import { RoutingLabelsEditor } from './RoutingLabelsEditor';
import { EpicWorkflowEditor, GlobalDefaultWorkflow, WorkspaceDefaultWorkflow, WorkflowLabelOverlayEditor, WorkflowLabelsEditor } from './WorkflowLabelsEditor';
import { WorkspaceWorkflowVars } from './WorkflowVarsEditors';
import { ModelOptionsEditor } from './ModelOptionsEditor';
import { enabledOptionCount } from './model-option-model';
import { RouteClassifierSettings } from './RouteClassifierSettings';
import { providerLabel } from './TaskIdentity';
import { SecuritySection } from './SecuritySection';
import { ArchiveRetentionSection, DestinationsSection, ExportSection, RedactionSection, AddDestinationButton, archiveStripRules } from './ArchiveExportSettings';
import type { SettingTab } from '../../../src/domain/settings-registry.js';
import { visibleSteps, type StepDef } from '../settings-steps-model';
import type { ResolutionRule } from './ResolutionStrip';
import { WORKSPACE_COLORS } from '../../../src/domain/workspace-colors.js';
import { ExecutionTargetsPanel } from './ExecutionTargetsSettings';
import { WorkspaceExecutionTargets } from './WorkspaceExecutionTargets';
import { PromptEditStep } from './prompt-library/PromptEdit';
import { PromptFind } from './prompt-library/PromptFind';
import { PromptImpact } from './prompt-library/PromptImpact';

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
  deliveries?: ExportDeliveryState;
  onTab?: (tab: SettingTab) => void;
  onStep?: (step: string) => void;
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
  deliveries?: ExportDeliveryState;
  saving?: boolean;
  onSave?: () => void;
  onTab?: (tab: SettingTab) => void;
  onStep?: (step: string) => void;
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

interface FieldNode {
  id: string;
  global: ScalarDescriptor | null;
  workspace: OverridableDescriptor | null;
}

function scalar(global: ScalarDescriptor | null, workspace: OverridableDescriptor | null): FieldNode {
  return { id: global?.id ?? workspace?.id ?? '', global, workspace };
}

function renderField(node: FieldNode, ctx: RenderCtx): ReactNode {
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
  step: string;
  surfaces: Surface[];
  title: PerSurface<string>;
  description: PerSurface<string>;
  ordinal?: string;
  leading?: boolean;
  divider?: string;
  body: (ctx: RenderCtx) => ReactNode;
  /** Control at the right of the card's title row. */
  action?: (ctx: RenderCtx) => ReactNode;
  /** Span both columns of the settings grid — for wide, table-shaped bodies. */
  wide?: boolean;
  /** Render the body without the SettingsSection card — the body owns its own chrome. */
  bare?: boolean;
}

const BOTH: Surface[] = ['global', 'workspace'];

function twoColGrid(surface: Surface): string {
  return surface === 'global' ? 'grid gap-3.5 sm:grid-cols-2' : 'grid gap-4 sm:grid-cols-2';
}

function ModelOptionsBlock({ ctx }: { ctx: RenderCtx }) {
  return (
    <div className="flex flex-col gap-2.5">
      <h3 className="text-body font-bold">Model Options</h3>
      <p className="text-small text-muted">
        {ctx.surface === 'global'
          ? 'The closed list the classifier and Routing Labels pick from. Write each description as when it fits. Workflow YAML can reference a code.'
          : 'Global rows are managed in Global settings. You can reorder them and turn them off here; Model Options you add are local to this Workspace. Codes are unique across both. Workflow YAML can reference a code.'}
      </p>
      {ctx.surface === 'global' ? (
        <ModelOptionsEditor
          items={ctx.config.modelOptions}
          config={ctx.config}
          errors={ctx.errors}
          onChange={(modelOptions) => ctx.setConfig({ ...ctx.config, modelOptions })}
        />
      ) : (
        <ModelOptionsEditor
          workspace
          overlay={ctx.workspace.modelOptions}
          config={ctx.config}
          errors={ctx.errors}
          onChange={(modelOptions) => ctx.setWorkspace({ ...ctx.workspace, modelOptions })}
        />
      )}
    </div>
  );
}

export const SETTINGS_SCHEMA: SectionNode[] = [
  {
    tab: 'general',
    step: 'identity',
    surfaces: ['global'],
    title: 'Instance',
    description:
      'A display name for this Harmonic instance. Shows in the sidebar and the browser title as “Harmonic - {name} - {workspace}”. Leave blank to just show “Harmonic”.',
    body: (ctx) => grid('', [instanceName], ctx),
  },
  {
    tab: 'general',
    step: 'identity',
    surfaces: ['workspace'],
    title: 'Identity',
    description: "This Workspace's name and the project directory it points at.",
    body: (ctx) => (ctx.surface === 'workspace' ? <WorkspaceIdentity ctx={ctx} /> : null),
  },
  {
    tab: 'general',
    step: 'files',
    surfaces: ['workspace'],
    title: 'Excluded folders',
    description:
      "Folders shown greyed in the Files view and skipped by the live watcher — seeded with the usual build and dependency directories. Right-click a folder in the Files tree to toggle it, or manage the list here.",
    body: (ctx) => (ctx.surface === 'workspace' ? <WorkspaceExcludedFolders ctx={ctx} /> : null),
  },
  {
    tab: 'general',
    step: 'chats',
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
    step: 'identity',
    surfaces: ['workspace'],
    title: 'Delete workspace',
    description:
      'Removes this Workspace and everything on its board — Tasks, Attempts, and Conversations. This cannot be undone.',
    body: (ctx) => (ctx.surface === 'workspace' ? <WorkspaceDelete ctx={ctx} /> : null),
  },

  {
    tab: 'execution',
    step: 'where',
    surfaces: ['global'],
    bare: true,
    wide: true,
    title: 'Execution Targets',
    description: '',
    body: (ctx) => <ExecutionTargetsPanel hostCeiling={ctx.config.autoRunner.maxConcurrentAttempts} />,
  },
  {
    tab: 'execution',
    step: 'where',
    surfaces: ['workspace'],
    bare: true,
    wide: true,
    title: 'Execution Targets',
    description: '',
    body: (ctx) =>
      ctx.surface === 'workspace' ? (
        <WorkspaceExecutionTargets
          workspace={ctx.workspace}
          savedKey={JSON.stringify([ctx.pristineWorkspace.executionTargets, ctx.pristineWorkspace.isolationMode, ctx.pristineWorkspace.codeRepository])}
          error={ctx.errors.executionTargets}
          onChange={(executionTargets) => ctx.setWorkspace({ ...ctx.workspace, executionTargets })}
          onAddRepository={() => ctx.onTab?.('integrations')}
        />
      ) : null,
  },
  {
    tab: 'execution',
    step: 'where',
    surfaces: BOTH,
    title: 'Isolation mode',
    description: {
      global: 'How a new task’s checkout is isolated. Each task can override it.',
      workspace: 'How a new Task’s checkout is isolated here. Inherits the global default until overridden.',
    },
    body: (ctx) => grid(twoColGrid(ctx.surface), [isolationMode], ctx),
  },
  {
    tab: 'execution',
    step: 'limits',
    surfaces: ['workspace'],
    title: 'Conflict resolution',
    description: 'Turns an Attempt gets to resolve a Merge conflict here. Inherits the global default until overridden.',
    body: (ctx) => grid(twoColGrid(ctx.surface), [conflictResolveTurns], ctx),
  },
  {
    tab: 'execution',
    step: 'agent',
    surfaces: BOTH,
    title: 'Routing Labels',
    ordinal: '2',
    wide: true,
    description: {
      global:
        'Map a tracker label to a Harness and Model. When an issue carries several routing labels, the first one in this list wins.',
      workspace:
        'Global rows are managed in Global settings. You can reorder them and turn them off here; labels you add are local to this Workspace.',
    },
    body: (ctx) =>
      ctx.surface === 'global' ? (
        <RoutingLabelsEditor items={ctx.config.routingLabels} config={ctx.config} onChange={(routingLabels) => ctx.setConfig({ ...ctx.config, routingLabels })} />
      ) : (
        <RoutingLabelOverlayEditor
          overlay={ctx.workspace.routingLabels}
          config={ctx.config}
          onChange={(routingLabels) => ctx.setWorkspace({ ...ctx.workspace, routingLabels })}
        />
      ),
  },
  {
    tab: 'execution',
    step: 'workflow',
    surfaces: BOTH,
    title: 'Workflow Labels',
    ordinal: '2',
    wide: true,
    description: {
      global:
        'Map a tracker label to a workflow. When an issue has several, the first in this list wins. Matching ignores case.',
      workspace:
        'Global rows are managed in Global settings. You can reorder them and turn them off here; labels you add are local to this Workspace.',
    },
    body: (ctx) =>
      ctx.surface === 'global' ? (
        <WorkflowLabelsEditor config={ctx.config} onChange={ctx.setConfig} {...(ctx.onStep ? { onStep: ctx.onStep } : {})} />
      ) : (
        <WorkflowLabelOverlayEditor
          overlay={ctx.workspace.workflowLabels}
          config={ctx.config}
          onChange={(workflowLabels) => ctx.setWorkspace({ ...ctx.workspace, workflowLabels })}
        />
      ),
  },
  {
    tab: 'execution',
    step: 'workflow',
    surfaces: ['workspace'],
    title: 'Workflow classifier',
    ordinal: '3',
    leading: true,
    wide: true,
    description:
      'When no label matches, read the Ticket and pick a workflow from the library by name and description. Advisory: on error, timeout or bad output the default applies. Uses the classifier backend from step 2.',
    action: (ctx) =>
      ctx.surface === 'workspace' ? (
        <Switch
          checked={ctx.workspace.workflowClassifierEnabled ?? false}
          onChange={(v) => ctx.setWorkspace({ ...ctx.workspace, workflowClassifierEnabled: v })}
          label="Workflow classifier"
        />
      ) : null,
    body: () => null,
  },
  {
    tab: 'execution',
    step: 'workflow',
    surfaces: ['workspace'],
    title: 'Workspace default workflow',
    ordinal: '4',
    wide: true,
    description: 'Used when no Workflow Label or classifier choice applies. Inherits the global default until set.',
    body: (ctx) =>
      ctx.surface === 'workspace' ? (
        <WorkspaceDefaultWorkflow
          workflow={ctx.workspace.workflow}
          config={ctx.config}
          onChange={(workflow) => ctx.setWorkspace({ ...ctx.workspace, workflow })}
        />
      ) : null,
  },
  {
    tab: 'execution',
    step: 'workflow',
    surfaces: ['global'],
    title: 'Global default workflow',
    ordinal: '5',
    wide: true,
    description: '',
    body: (ctx) => (ctx.surface === 'global' ? <GlobalDefaultWorkflow config={ctx.config} onChange={ctx.setConfig} /> : null),
  },
  {
    tab: 'execution',
    step: 'workflow',
    surfaces: ['workspace'],
    bare: true,
    wide: true,
    title: 'Workflow variables',
    divider: 'Then, for the chosen workflow',
    description: '',
    body: (ctx) =>
      ctx.surface === 'workspace' ? (
        <WorkspaceWorkflowVars workspace={ctx.workspace} onChange={(workflowVars) => ctx.setWorkspace({ ...ctx.workspace, workflowVars })} />
      ) : null,
  },
  {
    tab: 'execution',
    step: 'workflow',
    surfaces: BOTH,
    title: 'Epics',
    divider: 'Then, for the chosen workflow',
    wide: true,
    description: 'Epics resolve separately: one workflow verifies and merges every Epic.',
    body: (ctx) =>
      ctx.surface === 'global' ? (
        <EpicWorkflowEditor
          surface="global"
          value={ctx.config.defaults.epicWorkflow}
          globalValue={ctx.config.defaults.epicWorkflow}
          onChange={(epicWorkflow) => ctx.setConfig({ ...ctx.config, defaults: { ...ctx.config.defaults, epicWorkflow } })}
        />
      ) : (
        <EpicWorkflowEditor
          surface="workspace"
          value={ctx.workspace.epicWorkflow ?? null}
          globalValue={ctx.config.defaults.epicWorkflow}
          onChange={(epicWorkflow) => ctx.setWorkspace({ ...ctx.workspace, epicWorkflow })}
        />
      ),
  },
  {
    tab: 'execution',
    step: 'agent',
    surfaces: BOTH,
    title: 'Route Classifier',
    ordinal: '3',
    wide: true,
    leading: true,
    description: {
      global:
        'Reads an unlabelled Ticket and picks one Model Option below. It never picks outside the list. Each Workspace turns it on and chooses its backend.',
      workspace:
        'Reads an unlabelled Ticket and picks one Model Option below. It never picks outside the list. Advisory: when it abstains, errors or times out, the Workspace default applies and the Attempt starts anyway. The Workflow classifier uses this backend too.',
    },
    action: (ctx) =>
      ctx.surface === 'workspace' ? (
        <Switch
          checked={ctx.workspace.classifierEnabled ?? false}
          onChange={(v) => ctx.setWorkspace({ ...ctx.workspace, classifierEnabled: v })}
          label="Route Classifier"
        />
      ) : null,
    body: (ctx) =>
      ctx.surface === 'workspace' ? (
        <RouteClassifierSettings
          workspace={ctx.workspace}
          config={ctx.config}
          optionCount={enabledOptionCount(ctx.workspace.modelOptions, ctx.config.modelOptions)}
          errors={ctx.errors}
          saving={ctx.saving ?? false}
          {...(ctx.onSave ? { onSave: ctx.onSave } : {})}
          onChange={ctx.setWorkspace}
        >
          <ModelOptionsBlock ctx={ctx} />
        </RouteClassifierSettings>
      ) : (
        <ModelOptionsBlock ctx={ctx} />
      ),
  },
  {
    tab: 'execution',
    step: 'agent',
    surfaces: BOTH,
    title: 'Default agent',
    ordinal: '4',
    description: {
      global: 'Used when no label matches and the classifier is off or abstains. Pre-filled into every new task; each task can override it.',
      workspace:
        'Used when no label matches and the classifier is off or abstains. Each value inherits the global default until overridden; a Task can still override them one by one.',
    },
    body: (ctx) => (
      <>
        {grid(ctx.surface === 'global' ? 'grid gap-3.5 sm:grid-cols-3' : 'grid gap-4 sm:grid-cols-3', [taskHarness, taskModel, priority], ctx)}
        <p className="mt-3 text-small text-muted">Harness settings live in Integrations › Agents.</p>
      </>
    ),
  },
  {
    tab: 'execution',
    step: 'limits',
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
    step: 'limits',
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
    step: 'limits',
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
    step: 'limits',
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
    tab: 'prompts',
    step: 'find',
    surfaces: ['global'],
    bare: true,
    wide: true,
    title: 'Find a prompt',
    description: '',
    body: () => <PromptFind />,
  },
  {
    tab: 'prompts',
    step: 'edit',
    surfaces: ['global'],
    bare: true,
    wide: true,
    title: 'Edit a prompt',
    description: '',
    body: () => <PromptEditStep />,
  },
  {
    tab: 'prompts',
    step: 'impact',
    surfaces: ['global'],
    bare: true,
    wide: true,
    title: 'Prompt impact',
    description: '',
    body: () => <PromptImpact />,
  },

  {
    tab: 'integrations',
    step: 'work',
    surfaces: ['workspace'],
    title: 'Issue Tracker',
    description:
      'Mirror this Workspace’s issue tracker onto the board as Tasks. The Configured Tracker wins over the repo’s docs/agents/issue-tracker.md, which wins over the Code Repository.',
    body: (ctx) => (ctx.surface === 'workspace' ? <IssueTrackerSection ctx={ctx} /> : null),
  },
  {
    tab: 'integrations',
    step: 'code',
    surfaces: ['workspace'],
    title: 'Code Repository',
    description: 'The forge that hosts this Workspace’s branches, PRs/MRs and Merges. Detected from the origin remote unless overridden.',
    body: (ctx) => (ctx.surface === 'workspace' ? <CodeRepositorySection ctx={ctx} /> : null),
  },
  {
    tab: 'integrations',
    step: 'work',
    surfaces: ['workspace'],
    title: 'Triage Labels',
    description: 'The label names the tracker uses for each role Harmonic acts on. Empty roles use the repo’s docs/agents/triage-labels.md, then the defaults.',
    body: (ctx) => (ctx.surface === 'workspace' ? <TriageLabelsSection ctx={ctx} /> : null),
  },
  {
    tab: 'integrations',
    step: 'agents',
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
    step: 'updates',
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
    tab: 'general',
    step: 'access',
    surfaces: ['global'],
    title: 'Permission rules',
    description:
      "Persistent 'Always allow' choices from Conversation permission prompts — each auto-approves a tool kind in a Working Directory across Conversations. Revoking one makes matching requests prompt again.",
    body: () => <PermissionRules />,
  },
  {
    tab: 'general',
    step: 'access',
    surfaces: ['global'],
    title: 'Security',
    description: 'The operator password for this console.',
    body: () => <SecuritySection />,
  },

  {
    tab: 'archive',
    step: 'keep',
    surfaces: BOTH,
    title: 'Keep the raw Archive',
    description: '',
    body: (ctx) => <ArchiveRetentionSection ctx={ctx} />,
  },
  {
    tab: 'archive',
    step: 'export',
    surfaces: BOTH,
    title: 'Build an Export',
    description: '',
    body: (ctx) => <ExportSection ctx={ctx} />,
  },
  {
    tab: 'archive',
    step: 'deliver',
    surfaces: BOTH,
    title: 'Deliver',
    wide: true,
    description: {
      global: 'Each Destination gets every Export independently. A failure retries at 5 min, 30 min and 2 h, then waits for a manual Export on the Ticket.',
      workspace:
        'Each field inherits the global Destination until overridden. A failure retries at 5 min, 30 min and 2 h, then waits for a manual Export on the Ticket.',
    },
    action: (ctx) => <AddDestinationButton ctx={ctx} />,
    body: (ctx) => <DestinationsSection ctx={ctx} />,
  },
  {
    tab: 'archive',
    step: 'redact',
    surfaces: BOTH,
    title: 'Redact',
    wide: true,
    description: 'Applied to the Export only; matches become [REDACTED:id]. The local Archive stays raw.',
    body: (ctx) => <RedactionSection ctx={ctx} />,
  },
];

/** The sections a surface renders for one tab, in schema order. */
export function sectionsForTab(surface: Surface, tab: SettingTab): SectionNode[] {
  return SETTINGS_SCHEMA.filter((s) => s.tab === tab && s.surfaces.includes(surface));
}

/** Render a section's card title/description/body for a surface. */
export function renderSection(
  section: SectionNode,
  ctx: RenderCtx,
): { title: string; description: string; body: ReactNode; action: ReactNode } {
  return {
    title: pick(section.title, ctx.surface),
    description: pick(section.description, ctx.surface),
    body: section.body(ctx),
    action: section.action?.(ctx) ?? null,
  };
}

export function stepsForSurface(surface: Surface, tab: SettingTab): StepDef[] {
  const withContent = new Set(SETTINGS_SCHEMA.filter((s) => s.tab === tab && s.surfaces.includes(surface)).map((s) => s.step));
  return visibleSteps(tab, withContent);
}

export function sectionsForStep(surface: Surface, tab: SettingTab, step: string): SectionNode[] {
  return sectionsForTab(surface, tab).filter((s) => s.step === step);
}

export function sectionAnchor(title: string): string {
  return `settings-section-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
}

export function stepValue(ctx: RenderCtx, tab: SettingTab, step: string): string | undefined {
  const key = `${tab}:${step}`;
  if (key === 'general:identity') return ctx.surface === 'global' ? ctx.config.name || undefined : ctx.workspace.name;
  if (key === 'execution:agent') return (ctx.surface === 'global' ? ctx.config.defaults.harness : ctx.workspace.harness) ?? ctx.config.defaults.harness;
  if (key === 'execution:where') return ctx.surface === 'global' ? ctx.config.defaults.isolationMode : (ctx.workspace.isolationMode ?? ctx.config.defaults.isolationMode);
  if (key === 'archive:keep') {
    const days = ctx.surface === 'global' ? ctx.config.archive.retain.days : (ctx.workspace.archiveRetentionDays ?? ctx.config.archive.retain.days);
    return days == null ? 'Forever' : `${days} days`;
  }
  return undefined;
}

function agentStripRules(ctx: RenderCtx): ResolutionRule[] {
  const ws = ctx.surface === 'workspace' ? ctx.workspace : null;
  const labels = (ws?.routingLabels ?? ctx.config.routingLabels).length;
  const options = ws ? enabledOptionCount(ws.modelOptions, ctx.config.modelOptions) : ctx.config.modelOptions.length;
  const harness = ws?.harness ?? ctx.config.defaults.harness;
  const model = ws?.model ?? ctx.config.harnesses[harness]?.defaultModel ?? '';
  return [
    { caption: '1st', name: 'Operator choice', note: 'Set on the Ticket page' },
    { caption: '2nd', name: 'Routing Label', note: `${labels} ${labels === 1 ? 'label' : 'labels'}`, href: `#${sectionAnchor('Routing Labels')}` },
    {
      caption: '3rd',
      name: 'Route Classifier',
      note: ws ? (ws.classifierEnabled ? `On · picks from ${options} Model Options` : 'Off · skipped') : 'Set in each Workspace',
      href: `#${sectionAnchor('Route Classifier')}`,
    },
    {
      caption: 'Always matches',
      name: 'Default agent',
      note: [providerLabel(harness), model].filter(Boolean).join(' · '),
      href: `#${sectionAnchor('Default agent')}`,
      always: true,
    },
  ];
}

export function stepStrip(ctx: RenderCtx, tab: SettingTab, step: string): { label: string; rules: ResolutionRule[] } | null {
  if (tab === 'archive') return { label: 'Archive lifecycle', rules: archiveStripRules(ctx) };
  if (tab === 'execution' && step === 'agent') return { label: 'Agent resolution order', rules: agentStripRules(ctx) };
  if (tab !== 'execution' || step !== 'workflow') return null;
  const labelCount =
    ctx.surface === 'global' ? ctx.config.workflowLabels.length : (ctx.workspace.workflowLabels ?? ctx.config.workflowLabels).length;
  const classifierOn = ctx.surface === 'workspace' && ctx.workspace.workflowClassifierEnabled === true;
  return {
    label: 'Workflow resolution order',
    rules: [
      { caption: '1st', name: 'Operator choice', note: 'Set on the Ticket page' },
      {
        caption: '2nd',
        name: 'Workflow Label',
        note: `${labelCount} ${labelCount === 1 ? 'label' : 'labels'}`,
        href: `#${sectionAnchor('Workflow Labels')}`,
      },
      ctx.surface === 'workspace'
        ? {
            caption: '3rd',
            name: 'Workflow classifier',
            note: classifierOn ? 'On' : 'Off · skipped',
            href: `#${sectionAnchor('Workflow classifier')}`,
          }
        : { caption: '3rd', name: 'Workflow classifier', note: 'Set in each Workspace' },
      ctx.surface === 'workspace'
        ? {
            caption: '4th',
            name: 'Workspace default',
            note: ctx.workspace.workflow ?? 'Inherits global',
            href: `#${sectionAnchor('Workspace default workflow')}`,
          }
        : { caption: '4th', name: 'Workspace default', note: 'Set in each Workspace' },
      {
        caption: 'Always matches',
        name: 'Global default',
        note: ctx.config.defaults.workflow ?? 'Built-in',
        always: true,
        ...(ctx.surface === 'global' ? { href: `#${sectionAnchor('Global default workflow')}` } : {}),
      },
    ],
  };
}
