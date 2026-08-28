import { useEffect, useState } from 'react';
import { api } from '../api';
import type { AppConfig, Workspace } from '../types';
import { btnDestructive, btnGhost, displayTitle, field } from '../ui';
import { FieldError, PromptField, SettingsSection, fieldLabel, parseFieldErrors } from './SettingsSection';
import {
  DRIVE_PLACEHOLDERS,
  TASK_ID_PLACEHOLDER,
  TASK_PLACEHOLDERS,
  compileCriticPreview,
  compileDrivePreview,
  compileTaskIdPreview,
  compileTaskPreview,
} from '../prompt-preview-model';
import { FloatingSaveBar } from './FloatingSaveBar';
import { InheritField } from './InheritField';
import { ModelCombobox } from './ModelCombobox';
import { setBudgetField, summarizeBudget } from './guardrail-budget-model';
import { summarizeCommands } from './verification-override-model';
import { CommandListEditor } from './CommandListEditor';
import { OverrideField, type OverridableDescriptor } from './settings-override-fields';
import { toOptions, withCurrent, type FieldOption } from './settings-fields';
import { settingsRegistry, workspaceTabs, type SettingKey, type SettingTab } from '../../../src/domain/settings-registry.js';
import { Switch } from './Switch';
import { Tabs } from './Tabs';
import { Modal } from './Modal';

/** All harnesses as options, keeping a Workspace's pinned-but-unconfigured
 * harness visible/selectable rather than snapping to another (mirrors the
 * global model field's `withCurrent` affordance). */
function harnessOptions(config: AppConfig, current: string | null | undefined): FieldOption[] {
  const options = toOptions(Object.keys(config.harnesses));
  if (current && !config.harnesses[current]) return [...options, { value: current, label: `${current} (not configured)` }];
  return options;
}

/** One-line summary of a possibly-multi-line prompt for the inheriting read-only
 * line: its first line, truncated, or "Not configured" when empty. */
function summarizePrompt(prompt: string): string {
  const trimmed = prompt.trim();
  if (trimmed === '') return 'Not configured';
  const firstLine = trimmed.split('\n')[0] ?? trimmed;
  return firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine;
}

const TASK_DEFAULT_FIELDS: OverridableDescriptor[] = [
  {
    key: 'harness',
    id: 'workspace-harness',
    errorKey: 'harness',
    get: (w) => w.harness,
    set: (w, v) => ({ ...w, harness: v as string | null }),
    inherited: (c) => c.defaults.harness,
    options: (c, w) => harnessOptions(c, w.harness),
  },
  {
    key: 'model',
    id: 'workspace-model',
    errorKey: 'model',
    get: (w) => w.model,
    set: (w, v) => ({ ...w, model: v as string | null }),
    // The model default follows the *effective* harness (mirrors
    // TaskService.resolveExecution): overriding the harness repoints the
    // inherited model and the option list to that harness.
    inherited: (c, w) => c.harnesses[w.harness ?? c.defaults.harness]?.defaultModel ?? '',
    options: (c, w) => withCurrent(toOptions(c.harnesses[w.harness ?? c.defaults.harness]?.models ?? []), w.model ?? ''),
  },
  {
    key: 'isolationMode',
    id: 'workspace-isolation',
    errorKey: 'isolationMode',
    get: (w) => w.isolationMode,
    set: (w, v) => ({ ...w, isolationMode: v as 'direct' | 'worktree' | null }),
    inherited: (c) => c.defaults.isolationMode,
    options: () => toOptions(['direct', 'worktree']),
  },
  {
    key: 'priority',
    id: 'workspace-priority',
    errorKey: 'priority',
    get: (w) => w.priority,
    set: (w, v) => ({ ...w, priority: v as 'high' | 'normal' | 'low' | null }),
    inherited: (c) => c.defaults.priority,
    options: () => toOptions(['high', 'normal', 'low']),
  },
  {
    key: 'integrationRetries',
    id: 'workspace-integration-retries',
    errorKey: 'integrationRetries',
    get: (w) => w.integrationRetries,
    set: (w, v) => ({ ...w, integrationRetries: v as number | null }),
    inherited: (c) => c.defaults.integrationRetries,
    min: 1,
  },
  {
    key: 'conflictResolveTurns',
    id: 'workspace-conflict-turns',
    errorKey: 'conflictResolveTurns',
    get: (w) => w.conflictResolveTurns,
    set: (w, v) => ({ ...w, conflictResolveTurns: v as number | null }),
    inherited: (c) => c.defaults.conflictResolveTurns,
    min: 0,
  },
];

const CHAT_DEFAULT_FIELDS: OverridableDescriptor[] = [
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
  {
    key: 'chatModel',
    id: 'workspace-chat-model',
    errorKey: 'chatModel',
    label: 'Model',
    // Chat inherits the standalone global chat model (not the harness default),
    // but its option list still tracks the effective chat harness (ADR-0012).
    get: (w) => w.chatModel,
    set: (w, v) => ({ ...w, chatModel: v as string | null }),
    inherited: (c) => c.chat.model,
    options: (c, w) => withCurrent(toOptions(c.harnesses[w.chatHarness ?? c.chat.harness]?.models ?? []), w.chatModel ?? ''),
  },
];

const AUTORUNNER_FIELDS: OverridableDescriptor[] = [
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
  {
    key: 'maxConcurrentRuns',
    id: 'workspace-max-runs',
    errorKey: 'maxConcurrentRuns',
    label: 'Concurrency cap',
    get: (w) => w.maxConcurrentRuns,
    set: (w, v) => ({ ...w, maxConcurrentRuns: v as number | null }),
    inherited: (c) => c.autoRunner.maxConcurrentRuns,
    min: 1,
    // The Machine Ceiling is the hard limit an override can't breach (ADR-0012);
    // clamping is read-time (#60), so this input `max` just guides.
    max: (c) => c.autoRunner.maxConcurrentRuns,
  },
];

const ATTEMPT_FIELDS: OverridableDescriptor[] = [
  {
    key: 'maxAttempts',
    id: 'workspace-max-attempts',
    errorKey: 'maxAttempts',
    get: (w) => w.maxAttempts,
    set: (w, v) => ({ ...w, maxAttempts: v as number | null }),
    inherited: (c) => c.maxAttempts,
    min: 1,
  },
];

const SESSION_FIELDS: OverridableDescriptor[] = [
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
];

const GUARDRAIL_SCALAR_FIELDS: OverridableDescriptor[] = [
  {
    key: 'guardrailProgress',
    id: 'workspace-guardrail-progress',
    errorKey: 'guardrailProgress',
    label: 'Progress detector',
    switchLabel: 'Trip a stalled Run to Escalation',
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

const REVIEW_SCALAR_FIELDS: OverridableDescriptor[] = [
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
    // The review model's option list tracks the effective review harness
    // (mirrors the Task/chat harness→model pairing).
    renderControl: ({ id, value, onChange }, { config, workspace }) => {
      const reviewHarnessEff = (workspace.reviewHarness ?? config.verify.review.harness) || undefined;
      return (
        <ModelCombobox
          id={id}
          value={String(value)}
          onChange={onChange}
          options={reviewHarnessEff ? (config.harnesses[reviewHarnessEff]?.models ?? []) : []}
        />
      );
    },
  },
];

const DRIVE_SCALAR_FIELDS: OverridableDescriptor[] = [
  {
    key: 'driveMergeFate',
    id: 'workspace-merge-fate',
    errorKey: 'driveMergeFate',
    get: (w) => w.driveMergeFate,
    set: (w, v) => ({ ...w, driveMergeFate: v as 'auto-merge' | 'open-PR' | 'artifact' | null }),
    inherited: (c) => c.drive.mergeFate,
    options: () => toOptions(['auto-merge', 'open-PR', 'artifact']),
  },
  {
    key: 'driveContinueAttempts',
    id: 'workspace-continue-attempts',
    errorKey: 'driveContinueAttempts',
    get: (w) => w.driveContinueAttempts,
    set: (w, v) => ({ ...w, driveContinueAttempts: v as number | null }),
    inherited: (c) => c.drive.continueAttempts,
    min: 0,
  },
];

/** An overridable prompt-template field: the shared {@link InheritField} +
 * {@link PromptField}, mirroring the scalar {@link OverridableDescriptor} for
 * the textarea-with-preview controls (drive/task/review prompts). */
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
  compile: (text: string) => string;
  rows?: number;
  textareaClass?: string;
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
    <InheritField<string>
      label={d.label ?? spec.label}
      htmlFor={d.id}
      value={d.get(workspace)}
      inherited={d.inherited(config)}
      format={summarizePrompt}
      onChange={(next) => onWorkspace(d.set(workspace, next))}
    >
      {({ id, value, onChange }) => (
        <PromptField
          id={id ?? d.id}
          description={d.description}
          value={value}
          onChange={onChange}
          placeholders={d.placeholders}
          preview={d.compile(value)}
          error={errors[d.errorKey]}
          rows={d.rows}
          textareaClass={d.textareaClass}
        />
      )}
    </InheritField>
  );
}

const DRIVE_PROMPT_FIELDS: OverridablePrompt[] = [
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
];

const TASK_PROMPT_FIELD: OverridablePrompt = {
  key: 'taskPrompt',
  id: 'workspace-task-prompt',
  errorKey: 'taskPrompt',
  get: (w) => w.taskPrompt,
  set: (w, v) => ({ ...w, taskPrompt: v }),
  inherited: (c) => c.taskPrompt,
  placeholders: TASK_PLACEHOLDERS,
  compile: compileTaskPreview,
  textareaClass: `${field} min-h-36`,
};

const REVIEW_PROMPT_FIELD: OverridablePrompt = {
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

export function WorkspaceSettingsPage({
  workspace,
  config,
  blockedByRunningTask,
  onSaved,
  onDeleted,
}: {
  workspace: Workspace;
  config: AppConfig;
  /** The active Workspace has a running Task, so delete must refuse (the server
   * 409s regardless; this disables the confirm and says why up front). */
  blockedByRunningTask: boolean;
  onSaved: (workspace: Workspace) => void;
  onDeleted: (id: number) => void;
}) {
  const [pristine, setPristine] = useState<Workspace>(workspace);
  const [local, setLocal] = useState<Workspace>(workspace);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [tab, setTab] = useState<SettingTab>('general');

  useEffect(() => {
    setPristine(workspace);
    setLocal(workspace);
    setError(null);
    setFieldErrors({});
  }, [workspace]);

  const dirty = JSON.stringify(local) !== JSON.stringify(pristine);

  const set = <K extends keyof Workspace>(key: K, value: Workspace[K]) => setLocal((w) => ({ ...w, [key]: value }));

  const discard = () => {
    setLocal(pristine);
    setError(null);
    setFieldErrors({});
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    setFieldErrors({});
    try {
      // Working Directory is read-only here (it is Workspace identity, not a
      // setting), so it's left out of the patch. Overrides go as-is — `null`
      // clears one back to inherit, a value overrides.
      const updated = await api.updateWorkspace(local.id, {
        name: local.name,
        trackerEnabled: local.trackerEnabled,
        trackerPollIntervalSeconds: local.trackerPollIntervalSeconds,
        harness: local.harness,
        model: local.model,
        chatHarness: local.chatHarness,
        chatModel: local.chatModel,
        isolationMode: local.isolationMode,
        priority: local.priority,
        integrationRetries: local.integrationRetries,
        conflictResolveTurns: local.conflictResolveTurns,
        maxConcurrentRuns: local.maxConcurrentRuns,
        autoRunnerEnabled: local.autoRunnerEnabled,
        maxAttempts: local.maxAttempts,
        contextReuseTokenLimit: local.contextReuseTokenLimit,
        verificationCommand: local.verificationCommand,
        reviewEnabled: local.reviewEnabled,
        reviewPrompt: local.reviewPrompt,
        reviewModel: local.reviewModel,
        reviewHarness: local.reviewHarness,
        guardrailBudget: local.guardrailBudget,
        guardrailProgress: local.guardrailProgress,
        toolTimeoutMinutes: local.toolTimeoutMinutes,
        drivePrompt: local.drivePrompt,
        driveUnattendedReminder: local.driveUnattendedReminder,
        driveContinuePrompt: local.driveContinuePrompt,
        driveMergeFate: local.driveMergeFate,
        driveContinueAttempts: local.driveContinueAttempts,
        taskPrompt: local.taskPrompt,
      });
      setPristine(updated);
      setLocal(updated);
      onSaved(updated);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      setFieldErrors(parseFieldErrors(message));
    } finally {
      setSaving(false);
    }
  };

  // A review that resolves to enabled-without-a-prompt/model here can never run
  // (ADR-0044 §F, issue #340): compute the resolved review (workspace ?? global)
  // and flag it loudly, rather than letting the operator save a silent no-op.
  const resolvedReviewEnabled = local.reviewEnabled ?? config.verify.review.enabled;
  const resolvedReviewModel = local.reviewModel ?? config.verify.review.model;
  const resolvedReviewPrompt = local.reviewPrompt ?? config.verify.review.prompt;
  const reviewUnrunnable = Boolean(resolvedReviewEnabled) && !(resolvedReviewModel && resolvedReviewPrompt);

  const overrideGrid = (fields: OverridableDescriptor[], gridClass: string) => (
    <div className={gridClass}>
      {fields.map((f) => (
        <OverrideField key={f.id} descriptor={f} config={config} workspace={local} errors={fieldErrors} onWorkspace={setLocal} />
      ))}
    </div>
  );

  return (
    <div>
      <div className="max-w-3xl">
        <h1 className={displayTitle}>Workspace</h1>
        <p className="mt-1 text-muted">
          Settings for <span className="font-semibold text-ink">{pristine.name}</span> — its identity and its
          overrides of the global defaults. Overridable fields inherit the default until you turn an override on.
        </p>
      </div>

      <div className="mt-5">
        <Tabs tabs={workspaceTabs()} active={tab} onChange={(id) => setTab(id as SettingTab)} label="Workspace settings sections" />
      </div>

      <div
        id={`settings-panel-${tab}`}
        role="tabpanel"
        aria-labelledby={`settings-tab-${tab}`}
        className="mt-5 grid gap-4 xl:grid-cols-2 xl:items-start"
      >
        {tab === 'general' && (
          <>
            <SettingsSection title="Identity" description="This Workspace's name and the project directory it points at.">
              <div className="grid gap-3.5 sm:grid-cols-2">
                <div>
                  <label className={fieldLabel} htmlFor="workspace-name">Name</label>
                  <input
                    id="workspace-name"
                    className={field}
                    value={local.name}
                    onChange={(e) => set('name', e.target.value)}
                  />
                  <FieldError message={fieldErrors['name']} />
                </div>
                <div>
                  <span className={fieldLabel}>Working directory</span>
                  <p className="truncate font-data text-ink" title={local.workingDir}>
                    {local.workingDir}
                  </p>
                  <p className="mt-1 text-small text-muted">
                    Fixed once a Workspace is created — make a new Workspace to point at a different repo.
                  </p>
                </div>
              </div>
            </SettingsSection>

            <SettingsSection
              title="Tracker mirroring"
              description="Poll this Workspace's issue tracker and mirror its issues onto the board as Tasks. Needs docs/agents/issue-tracker.md in the repo and gh (GitHub) auth."
            >
              <div className="flex flex-wrap items-start gap-x-8 gap-y-4">
                <div>
                  <span className={fieldLabel}>Enabled</span>
                  <div className="pt-1">
                    <Switch
                      checked={local.trackerEnabled}
                      onChange={(trackerEnabled) => set('trackerEnabled', trackerEnabled)}
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
                    value={local.trackerPollIntervalSeconds}
                    onChange={(e) => set('trackerPollIntervalSeconds', Number(e.target.value))}
                  />
                  <FieldError message={fieldErrors['trackerPollIntervalSeconds']} />
                </div>
                <div>
                  <span className={fieldLabel}>Resolved tracker</span>
                  <ResolvedTrackerValue workspace={pristine} />
                </div>
              </div>
            </SettingsSection>

            <SettingsSection
              title="Chat defaults"
              description="The Harness and model new Conversations in this Workspace start with. Each inherits the global chat default until overridden; every chat can still change them before its first turn."
            >
              {overrideGrid(CHAT_DEFAULT_FIELDS, 'grid gap-4 sm:grid-cols-2')}
            </SettingsSection>

            <SettingsSection
              title="Delete workspace"
              description="Removes this Workspace and everything on its board — Tasks, Runs, and Conversations. This cannot be undone."
            >
              <button type="button" className={btnGhost} onClick={() => setConfirmingDelete(true)}>
                Delete workspace…
              </button>
              {blockedByRunningTask && (
                <p className="mt-2 text-small text-muted">
                  A Task is running here — stop it before this Workspace can be deleted.
                </p>
              )}
            </SettingsSection>
          </>
        )}

        {tab === 'execution' && (
          <>
            <SettingsSection
              title="Task defaults"
              description="Pre-filled into every new Task in this Workspace. Each inherits the global default until overridden; a Task can still override them one by one."
            >
              {overrideGrid(TASK_DEFAULT_FIELDS, 'grid gap-4 sm:grid-cols-2')}
            </SettingsSection>

            <SettingsSection
              title="Auto-runner"
              description="Whether ready Tasks here run unattended, and how many at once. Both inherit the global defaults until overridden; a cap override can never exceed the Machine Ceiling."
            >
              {overrideGrid(AUTORUNNER_FIELDS, 'flex flex-col gap-4 sm:max-w-md')}
            </SettingsSection>

            <SettingsSection
              title="Attempt limit"
              description="The maximum implementation attempts before a Task escalates. Inherits the global cap until overridden."
            >
              {overrideGrid(ATTEMPT_FIELDS, '')}
            </SettingsSection>

            <SettingsSection
              title="Session reuse"
              description="Reuse a warm session into the next attempt while its context is below this many tokens; at or above it, a condensed new session starts. Inherits the global default until overridden."
            >
              {overrideGrid(SESSION_FIELDS, '')}
            </SettingsSection>

            <SettingsSection
              title="Run guardrails"
              description="The budget caps, stall detector, and tool timeout that trip a Run here to Escalation (ADR-0019). Each inherits the global default until overridden; wall-clock always guards, the token and cost caps are opt-in."
            >
              <div className="flex flex-col gap-4 sm:max-w-md">
                <div>
                  <InheritField
                    label="Budget"
                    value={local.guardrailBudget}
                    inherited={config.guardrails.budget}
                    format={summarizeBudget}
                    onChange={(guardrailBudget) => set('guardrailBudget', guardrailBudget)}
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
                          <FieldError message={fieldErrors['guardrailBudget.wallClockMinutes']} />
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
                          <FieldError message={fieldErrors['guardrailBudget.tokens']} />
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
                          {/* A cost cap with no token fallback is rejected server-side
                              when a configured model is unpriced (ADR-0019, #166). */}
                          <FieldError message={fieldErrors['guardrailBudget.costUsd']} />
                        </div>
                      </div>
                    )}
                  </InheritField>
                </div>
                {overrideGrid(GUARDRAIL_SCALAR_FIELDS, 'flex flex-col gap-4')}
              </div>
            </SettingsSection>
          </>
        )}

        {tab === 'verification' && (
          <SettingsSection
            title="Verification"
            description="Commands run in order and stop at the first failure. Review runs only after they pass. This Workspace can override the global default."
          >
            <div className="flex flex-col gap-4 sm:max-w-md">
              {reviewUnrunnable && (
                <p className="rounded-sm bg-fail-tint px-2.5 py-2 text-small text-fail">
                  Review is enabled here but resolves to no {!resolvedReviewModel ? 'model' : 'prompt'} — it will be
                  flagged unrunnable and never run. Set a review {!resolvedReviewModel ? 'model' : 'prompt'} or turn
                  review off.
                </p>
              )}
              <div>
                <InheritField
                  label="Command verifier"
                  value={local.verificationCommand}
                  inherited={config.verify.commands}
                  format={summarizeCommands}
                  onChange={(verificationCommand) => set('verificationCommand', verificationCommand)}
                >
                  {({ value, onChange }) => (
                    <CommandListEditor
                      commands={value}
                      onChange={onChange}
                      idPrefix="workspace-verify"
                      errorPrefix="verificationCommand"
                      fieldErrors={fieldErrors}
                      emptyText="No commands — verification runs nothing in this workspace."
                    />
                  )}
                </InheritField>
              </div>
              {overrideGrid(REVIEW_SCALAR_FIELDS, 'flex flex-col gap-4')}
              <OverridePrompt
                descriptor={REVIEW_PROMPT_FIELD}
                config={config}
                workspace={local}
                errors={fieldErrors}
                onWorkspace={setLocal}
              />
            </div>
          </SettingsSection>
        )}

        {tab === 'prompts' && (
          <>
            <SettingsSection
              title="Task prompt"
              description="Wraps a native Task's own prompt before it's sent to the agent. Inherits the global Task Prompt until overridden; mirrored tickets use the Drive prompt instead."
            >
              <OverridePrompt
                descriptor={TASK_PROMPT_FIELD}
                config={config}
                workspace={local}
                errors={fieldErrors}
                onWorkspace={setLocal}
              />
            </SettingsSection>

            <SettingsSection
              title="Drive prompt"
              description="How Harmonic drives a mirrored Task unattended here. Each field inherits the global default until overridden; merge fate governs what happens to completed work."
            >
              <div className="flex flex-col gap-4">
                {DRIVE_PROMPT_FIELDS.map((d) => (
                  <OverridePrompt
                    key={d.id}
                    descriptor={d}
                    config={config}
                    workspace={local}
                    errors={fieldErrors}
                    onWorkspace={setLocal}
                  />
                ))}
                {overrideGrid(DRIVE_SCALAR_FIELDS, 'flex flex-wrap items-start gap-x-8 gap-y-4')}
              </div>
            </SettingsSection>
          </>
        )}
      </div>

      {dirty && <FloatingSaveBar error={error} saving={saving} onDiscard={discard} onSave={save} />}

      {confirmingDelete && (
        <DeleteWorkspaceDialog
          workspace={pristine}
          blockedByRunningTask={blockedByRunningTask}
          onClose={() => setConfirmingDelete(false)}
          onDeleted={onDeleted}
        />
      )}
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

function DeleteWorkspaceDialog({
  workspace,
  blockedByRunningTask,
  onClose,
  onDeleted,
}: {
  workspace: Workspace;
  blockedByRunningTask: boolean;
  onClose: () => void;
  onDeleted: (id: number) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState('');

  const nameMatches = typed.trim() === workspace.name;
  const canDelete = nameMatches && !blockedByRunningTask && !busy;

  const confirm = async () => {
    if (!canDelete) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteWorkspace(workspace.id);
      onDeleted(workspace.id);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Modal label={`Delete workspace ${workspace.name}`} onClose={onClose} className="max-w-md">
      <div className="p-5">
        <h2 className={`${displayTitle} mb-2 pr-6`}>Delete workspace</h2>
        <p className="text-muted">
          Delete <span className="font-semibold text-ink">{workspace.name}</span> and everything on its board —
          its Tasks, Runs, and Conversations. This cannot be undone.
        </p>
        <label htmlFor="delete-workspace-name" className="mt-4 block text-small text-muted">
          Type <span className="font-semibold text-ink">{workspace.name}</span> to confirm.
        </label>
        <input
          id="delete-workspace-name"
          autoFocus
          autoComplete="off"
          className={`${field} mt-1.5`}
          value={typed}
          placeholder={workspace.name}
          disabled={busy}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              confirm();
            }
          }}
        />
        {blockedByRunningTask && (
          <p className="mt-3 text-fail">A Task is running here. Stop it before deleting this Workspace.</p>
        )}
        {error && <p className="mt-3 text-fail">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className={btnGhost} onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className={btnDestructive} onClick={confirm} disabled={!canDelete}>
            {busy ? 'Deleting…' : `Delete ${workspace.name}`}
          </button>
        </div>
      </div>
    </Modal>
  );
}
