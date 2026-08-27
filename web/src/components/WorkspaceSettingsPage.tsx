import { useEffect, useState } from 'react';
import { api } from '../api';
import type { AppConfig, Workspace } from '../types';
import { btnDestructive, btnGhost, displayTitle, field, selectField } from '../ui';
import { FieldError, PlaceholderList, PromptPreview, SettingsSection, fieldLabel, parseFieldErrors } from './SettingsSection';
import { DRIVE_PLACEHOLDERS, compileCriticPreview } from '../prompt-preview-model';
import { FloatingSaveBar } from './FloatingSaveBar';
import { InheritField } from './InheritField';
import { ModelCombobox } from './ModelCombobox';
import { setBudgetField, summarizeBudget } from './guardrail-budget-model';
import {
  EMPTY_COMMAND,
  EMPTY_CRITIC,
  VERIFIER_OFF,
  argsText,
  isVerifierOff,
  setCommandField,
  setCriticField,
  summarizeCommand,
  summarizeCritic,
} from './verification-override-model';
import { Switch } from './Switch';
import { Modal } from './Modal';

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

  useEffect(() => {
    setPristine(workspace);
    setLocal(workspace);
    setError(null);
    setFieldErrors({});
  }, [workspace]);

  const dirty = JSON.stringify(local) !== JSON.stringify(pristine);

  const set = <K extends keyof Workspace>(key: K, value: Workspace[K]) =>
    setLocal((w) => ({ ...w, [key]: value }));

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
        contextReuseTokenLimit: local.contextReuseTokenLimit,
        verificationCommand: local.verificationCommand,
        verificationCritic: local.verificationCritic,
        guardrailBudget: local.guardrailBudget,
        guardrailProgress: local.guardrailProgress,
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

  // The model override's inherited value and option list track the *effective*
  // harness (mirrors TaskService.resolveExecution): overriding the harness
  // repoints the model to that harness's default and models.
  const effectiveHarness = local.harness ?? config.defaults.harness;
  const harnessConfig = config.harnesses[effectiveHarness];
  const inheritedModel = harnessConfig?.defaultModel ?? '';
  const models = harnessConfig?.models ?? [];

  // Chat defaults resolve independently of the Task defaults (ADR-0012): the
  // effective chat harness drives the model option list, but the inherited
  // model is the global chat model (a standalone value, not the harness's
  // defaultModel) — chat and Tasks can pin different models of one Harness.
  const effectiveChatHarness = local.chatHarness ?? config.chat.harness;
  const chatModels = config.harnesses[effectiveChatHarness]?.models ?? [];

  return (
    <div>
      <div className="max-w-3xl">
        <h1 className={displayTitle}>Workspace</h1>
        <p className="mt-1 text-muted">
          Settings for <span className="font-semibold text-ink">{pristine.name}</span> — its identity and its
          overrides of the global defaults. Overridable fields inherit the default until you turn an override on.
        </p>
      </div>

      <div className="mt-5 grid gap-4 xl:grid-cols-2 xl:items-start">
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
          title="Auto-runner"
          description="Whether ready Tasks here run unattended, and how many at once. Both inherit the global defaults until overridden; a cap override can never exceed the Machine Ceiling."
        >
          <div className="flex flex-col gap-4 sm:max-w-md">
            <div>
              <InheritField
                label="Enabled"
                value={local.autoRunnerEnabled}
                inherited={config.autoRunner.enabled}
                format={(v) => (v ? 'On' : 'Off')}
                onChange={(autoRunnerEnabled) => set('autoRunnerEnabled', autoRunnerEnabled)}
              >
                {({ value, onChange }) => (
                  <Switch checked={value} onChange={onChange}>
                    Run ready tasks unattended
                  </Switch>
                )}
              </InheritField>
              <FieldError message={fieldErrors['autoRunnerEnabled']} />
            </div>
            <div>
              <InheritField
                label="Concurrency cap"
                htmlFor="workspace-max-runs"
                value={local.maxConcurrentRuns}
                inherited={config.autoRunner.maxConcurrentRuns}
                onChange={(maxConcurrentRuns) => set('maxConcurrentRuns', maxConcurrentRuns)}
              >
                {({ id, value, onChange }) => (
                  <input
                    id={id}
                    type="number"
                    min={1}
                    // The ceiling is the hard limit an override can't breach
                    // (ADR-0012); clamping is read-time (#60), this just guides.
                    max={config.autoRunner.maxConcurrentRuns}
                    className={`${field} w-28 tabular-nums`}
                    value={value}
                    onChange={(e) => onChange(Number(e.target.value))}
                  />
                )}
              </InheritField>
              <FieldError message={fieldErrors['maxConcurrentRuns']} />
            </div>
          </div>
        </SettingsSection>

        <SettingsSection
          title="Session reuse"
          description="Reuse a warm session into the next attempt while its context is below this many tokens; at or above it, a condensed new session starts. Inherits the global default until overridden."
        >
          <div>
            <InheritField
              label="Context reuse token limit"
              htmlFor="workspace-context-reuse-token-limit"
              value={local.contextReuseTokenLimit}
              inherited={config.contextReuseTokenLimit}
              onChange={(contextReuseTokenLimit) => set('contextReuseTokenLimit', contextReuseTokenLimit)}
            >
              {({ id, value, onChange }) => (
                <input
                  id={id}
                  type="number"
                  min={0}
                  step={10_000}
                  className={`${field} w-36 tabular-nums`}
                  value={value}
                  onChange={(e) => onChange(Number(e.target.value))}
                />
              )}
            </InheritField>
            <FieldError message={fieldErrors['contextReuseTokenLimit']} />
          </div>
        </SettingsSection>

        <SettingsSection
          title="Task defaults"
          description="Pre-filled into every new Task in this Workspace. Each inherits the global default until overridden; a Task can still override them one by one."
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <InheritField
                label="Harness"
                htmlFor="workspace-harness"
                value={local.harness}
                inherited={config.defaults.harness}
                onChange={(harness) => set('harness', harness)}
              >
                {({ id, value, onChange }) => (
                  <select id={id} className={`${selectField} w-full`} value={value} onChange={(e) => onChange(e.target.value)}>
                    {Object.keys(config.harnesses).map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                    {value && !config.harnesses[value] && <option value={value}>{value} (not configured)</option>}
                  </select>
                )}
              </InheritField>
              <FieldError message={fieldErrors['harness']} />
            </div>
            <div>
              <InheritField
                label="Model"
                htmlFor="workspace-model"
                value={local.model}
                inherited={inheritedModel}
                onChange={(model) => set('model', model)}
              >
                {({ id, value, onChange }) => (
                  <select id={id} className={`${selectField} w-full`} value={value} onChange={(e) => onChange(e.target.value)}>
                    {models.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                    {value && !models.includes(value) && (
                      <option value={value}>{value} (not in models list)</option>
                    )}
                  </select>
                )}
              </InheritField>
              <FieldError message={fieldErrors['model']} />
            </div>
            <div>
              <InheritField
                label="Isolation mode"
                htmlFor="workspace-isolation"
                value={local.isolationMode}
                inherited={config.defaults.isolationMode}
                onChange={(isolationMode) => set('isolationMode', isolationMode)}
              >
                {({ id, value, onChange }) => (
                  <select
                    id={id}
                    className={`${selectField} w-full`}
                    value={value}
                    onChange={(e) => onChange(e.target.value as 'direct' | 'worktree')}
                  >
                    <option value="direct">direct</option>
                    <option value="worktree">worktree</option>
                  </select>
                )}
              </InheritField>
              <FieldError message={fieldErrors['isolationMode']} />
            </div>
            <div>
              <InheritField
                label="Priority"
                htmlFor="workspace-priority"
                value={local.priority}
                inherited={config.defaults.priority}
                onChange={(priority) => set('priority', priority)}
              >
                {({ id, value, onChange }) => (
                  <select
                    id={id}
                    className={`${selectField} w-full`}
                    value={value}
                    onChange={(e) => onChange(e.target.value as 'high' | 'normal' | 'low')}
                  >
                    <option value="high">high</option>
                    <option value="normal">normal</option>
                    <option value="low">low</option>
                  </select>
                )}
              </InheritField>
              <FieldError message={fieldErrors['priority']} />
            </div>
            <div>
              <InheritField
                label="Integration retries"
                htmlFor="workspace-integration-retries"
                value={local.integrationRetries}
                inherited={config.defaults.integrationRetries}
                onChange={(integrationRetries) => set('integrationRetries', integrationRetries)}
              >
                {({ id, value, onChange }) => (
                  <input
                    id={id}
                    type="number"
                    min={1}
                    className={`${field} w-28 tabular-nums`}
                    value={value}
                    onChange={(e) => onChange(Number(e.target.value))}
                  />
                )}
              </InheritField>
              <FieldError message={fieldErrors['integrationRetries']} />
            </div>
            <div>
              <InheritField
                label="Conflict resolve turns"
                htmlFor="workspace-conflict-turns"
                value={local.conflictResolveTurns}
                inherited={config.defaults.conflictResolveTurns}
                onChange={(conflictResolveTurns) => set('conflictResolveTurns', conflictResolveTurns)}
              >
                {({ id, value, onChange }) => (
                  <input
                    id={id}
                    type="number"
                    min={0}
                    className={`${field} w-28 tabular-nums`}
                    value={value}
                    onChange={(e) => onChange(Number(e.target.value))}
                  />
                )}
              </InheritField>
              <FieldError message={fieldErrors['conflictResolveTurns']} />
            </div>
          </div>
        </SettingsSection>

        <SettingsSection
          title="Chat defaults"
          description="The Harness and model new Conversations in this Workspace start with. Each inherits the global chat default until overridden; every chat can still change them before its first turn."
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <InheritField
                label="Harness"
                htmlFor="workspace-chat-harness"
                value={local.chatHarness}
                inherited={config.chat.harness}
                onChange={(chatHarness) => set('chatHarness', chatHarness)}
              >
                {({ id, value, onChange }) => (
                  <select id={id} className={`${selectField} w-full`} value={value} onChange={(e) => onChange(e.target.value)}>
                    {Object.keys(config.harnesses).map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                    {value && !config.harnesses[value] && <option value={value}>{value} (not configured)</option>}
                  </select>
                )}
              </InheritField>
              <FieldError message={fieldErrors['chatHarness']} />
            </div>
            <div>
              <InheritField
                label="Model"
                htmlFor="workspace-chat-model"
                value={local.chatModel}
                inherited={config.chat.model}
                onChange={(chatModel) => set('chatModel', chatModel)}
              >
                {({ id, value, onChange }) => (
                  <select id={id} className={`${selectField} w-full`} value={value} onChange={(e) => onChange(e.target.value)}>
                    {chatModels.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                    {value && !chatModels.includes(value) && (
                      <option value={value}>{value} (not in models list)</option>
                    )}
                  </select>
                )}
              </InheritField>
              <FieldError message={fieldErrors['chatModel']} />
            </div>
          </div>
        </SettingsSection>

        <SettingsSection
          title="Run guardrails"
          description="The budget caps and stall detector that trip a Run here to Escalation (ADR-0019). Each inherits the global default until overridden; wall-clock always guards, the token and cost caps are opt-in. tool-timeout is global-only and set on the global settings page."
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
            <div>
              <InheritField
                label="Progress detector"
                value={local.guardrailProgress}
                inherited={config.guardrails.progress}
                format={(v) => (v ? 'On' : 'Off')}
                onChange={(guardrailProgress) => set('guardrailProgress', guardrailProgress)}
              >
                {({ value, onChange }) => (
                  <Switch checked={value} onChange={onChange}>
                    Trip a stalled Run to Escalation
                  </Switch>
                )}
              </InheritField>
              <FieldError message={fieldErrors['guardrailProgress']} />
            </div>
          </div>
        </SettingsSection>

        <SettingsSection
          title="Verification"
          description="Commands run in order and stop at the first failure. Review runs only after they pass. This Workspace can override the global default."
        >
          <div className="flex flex-col gap-4 sm:max-w-md">
            <div>
              <InheritField
                label="Command verifier"
                value={local.verificationCommand}
                inherited={config.verify.commands[0] ?? EMPTY_COMMAND}
                format={summarizeCommand}
                onChange={(verificationCommand) => set('verificationCommand', verificationCommand)}
              >
                {({ value, onChange }) => {
                  // The render prop's value can be the off sentinel, since
                  // overriding-and-off both count as "overridden" to InheritField.
                  if (isVerifierOff(value)) {
                    return (
                      <div className="flex flex-col gap-3">
                        <Switch checked={false} onChange={() => onChange(config.verify.commands[0] ?? EMPTY_COMMAND)}>
                          Enabled
                        </Switch>
                        <p className="text-small text-muted">
                          Disabled for this workspace — this verifier will not run here.
                        </p>
                      </div>
                    );
                  }
                  return (
                    <div className="flex flex-col gap-3">
                      <Switch checked={true} onChange={() => onChange(VERIFIER_OFF)}>
                        Enabled
                      </Switch>
                      <div>
                        <label className={fieldLabel} htmlFor="workspace-verify-command">Command</label>
                        <input
                          id="workspace-verify-command"
                          className={`${field} font-data`}
                          placeholder="npm"
                          value={value.command}
                          onChange={(e) => onChange(setCommandField(value, 'command', e.target.value))}
                        />
                        <FieldError message={fieldErrors['verificationCommand.command']} />
                      </div>
                      <div>
                        <label className={fieldLabel} htmlFor="workspace-verify-args">
                          Arguments <span className="normal-case text-muted">(space-separated)</span>
                        </label>
                        <input
                          id="workspace-verify-args"
                          className={`${field} font-data`}
                          placeholder="test"
                          value={argsText(value)}
                          onChange={(e) => onChange(setCommandField(value, 'args', e.target.value))}
                        />
                      </div>
                      <div>
                        <label className={fieldLabel} htmlFor="workspace-verify-timeout">Timeout (seconds)</label>
                        <input
                          id="workspace-verify-timeout"
                          type="number"
                          min={1}
                          className={`${field} w-40 tabular-nums`}
                          value={value.timeoutSeconds}
                          onChange={(e) => onChange(setCommandField(value, 'timeoutSeconds', e.target.value))}
                        />
                      </div>
                    </div>
                  );
                }}
              </InheritField>
            </div>
            <div>
              <InheritField
                label="Agent critic"
                value={local.verificationCritic}
                inherited={config.verify.review.enabled && config.verify.review.prompt && config.verify.review.model
                  ? { prompt: config.verify.review.prompt, model: config.verify.review.model, ...(config.verify.review.harness ? { harness: config.verify.review.harness } : {}) }
                  : EMPTY_CRITIC}
                format={summarizeCritic}
                onChange={(verificationCritic) => set('verificationCritic', verificationCritic)}
              >
                {({ value, onChange }) => {
                  // Same off-sentinel narrowing as the command verifier above.
                  if (isVerifierOff(value)) {
                    return (
                      <div className="flex flex-col gap-3">
                        <Switch
                          checked={false}
                          onChange={() => onChange(
                            config.verify.review.enabled && config.verify.review.prompt && config.verify.review.model
                              ? { prompt: config.verify.review.prompt, model: config.verify.review.model, ...(config.verify.review.harness ? { harness: config.verify.review.harness } : {}) }
                              : EMPTY_CRITIC,
                          )}
                        >
                          Enabled
                        </Switch>
                        <p className="text-small text-muted">
                          Disabled for this workspace — this verifier will not run here.
                        </p>
                      </div>
                    );
                  }
                  return (
                    <div className="flex flex-col gap-3">
                      <Switch checked={true} onChange={() => onChange(VERIFIER_OFF)}>
                        Enabled
                      </Switch>
                      <div>
                        <label className={fieldLabel} htmlFor="workspace-critic-harness">Harness</label>
                        <select
                          id="workspace-critic-harness"
                          className={`${selectField} w-full`}
                          value={value.harness ?? ''}
                          onChange={(e) => onChange(setCriticField(value, 'harness', e.target.value))}
                        >
                          <option value="">Same as task</option>
                          {Object.keys(config.harnesses).map((h) => (
                            <option key={h} value={h}>
                              {h}
                            </option>
                          ))}
                        </select>
                        <FieldError message={fieldErrors['verificationCritic.harness']} />
                      </div>
                      <div>
                        <label className={fieldLabel} htmlFor="workspace-critic-model">Model</label>
                        <ModelCombobox
                          id="workspace-critic-model"
                          value={value.model}
                          onChange={(m) => onChange(setCriticField(value, 'model', m))}
                          options={value.harness ? (config.harnesses[value.harness]?.models ?? []) : []}
                        />
                        <FieldError message={fieldErrors['verificationCritic.model']} />
                      </div>
                      <div>
                        <label className={fieldLabel} htmlFor="workspace-critic-prompt">Review prompt</label>
                        <textarea
                          id="workspace-critic-prompt"
                          rows={3}
                          className={field}
                          placeholder="Review the change against issue {ref}: {title}. Read the code and the issue to decide."
                          value={value.prompt}
                          onChange={(e) => onChange(setCriticField(value, 'prompt', e.target.value))}
                        />
                        <FieldError message={fieldErrors['verificationCritic.prompt']} />
                        <PlaceholderList placeholders={DRIVE_PLACEHOLDERS} />
                        <PromptPreview text={compileCriticPreview(value.prompt)} />
                      </div>
                    </div>
                  );
                }}
              </InheritField>
            </div>
          </div>
        </SettingsSection>

        <SettingsSection
          title="Delete workspace"
          description="Removes this Workspace and everything on its board — Tasks, Runs, and Conversations. This cannot be undone."
        >
          <button
            type="button"
            className={btnGhost}
            onClick={() => setConfirmingDelete(true)}
          >
            Delete workspace…
          </button>
          {blockedByRunningTask && (
            <p className="mt-2 text-small text-muted">
              A Task is running here — stop it before this Workspace can be deleted.
            </p>
          )}
        </SettingsSection>
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
