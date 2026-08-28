import { useEffect, useState } from 'react';
import { api } from '../api';
import { SecuritySection } from './SecuritySection';
import { ChannelsSection } from './Channels';
import { PermissionRules } from './PermissionRules';
import type { AppConfig, Channel, VerificationCritic, VerificationReview } from '../types';
import { changedChannelEvents, channelsDirty, toggleChannelEvent } from '../channels-save-model';
import { displayTitle, field, selectField } from '../ui';
import { HarnessesSection, PriceOverridesSection } from './HarnessSettings';
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
import { ModelCombobox } from './ModelCombobox';
import { Switch } from './Switch';
import { EMPTY_CRITIC, setCriticField } from './verification-override-model';
import { CommandListEditor } from './CommandListEditor';
import { ConfigField, registryField, toOptions, withCurrent, type ScalarDescriptor } from './settings-fields';
import { Tabs } from './Tabs';
import { SETTING_TABS, type SettingTab } from '../../../src/domain/settings-registry.js';

const INSTANCE_FIELDS: ScalarDescriptor[] = [
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
];

const CHAT_FIELDS: ScalarDescriptor[] = [
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
  registryField('chatModel', {
    id: 'settings-chat-model',
    errorKey: 'chat.model',
    disabled: (c) => !c.harnesses[c.chat.harness],
    get: (c) => c.chat.model,
    options: (c) => withCurrent(toOptions(c.harnesses[c.chat.harness]?.models ?? []), c.chat.model),
    set: (c, raw) => ({ ...c, chat: { ...c.chat, model: String(raw) } }),
  }),
];

const TASK_DEFAULT_FIELDS: ScalarDescriptor[] = [
  registryField('harness', {
    id: 'settings-harness',
    errorKey: 'defaults.harness',
    get: (c) => c.defaults.harness,
    options: (c) => toOptions(Object.keys(c.harnesses)),
    set: (c, raw) => ({ ...c, defaults: { ...c.defaults, harness: String(raw) } }),
  }),
  registryField('model', {
    id: 'settings-default-model',
    errorKey: (c) => `harnesses.${c.defaults.harness}.defaultModel`,
    disabled: (c) => !c.harnesses[c.defaults.harness],
    get: (c) => c.harnesses[c.defaults.harness]?.defaultModel ?? '',
    options: (c) =>
      withCurrent(toOptions(c.harnesses[c.defaults.harness]?.models ?? []), c.harnesses[c.defaults.harness]?.defaultModel ?? ''),
    set: (c, raw) => {
      const h = c.defaults.harness;
      const current = c.harnesses[h];
      if (!current) return c;
      return { ...c, harnesses: { ...c.harnesses, [h]: { ...current, defaultModel: String(raw) } } };
    },
  }),
  registryField('isolationMode', {
    id: 'settings-isolation',
    errorKey: 'defaults.isolationMode',
    get: (c) => c.defaults.isolationMode,
    options: () => toOptions(['direct', 'worktree']),
    set: (c, raw) => ({ ...c, defaults: { ...c.defaults, isolationMode: raw as 'direct' | 'worktree' } }),
  }),
  registryField('priority', {
    id: 'settings-priority',
    errorKey: 'defaults.priority',
    get: (c) => c.defaults.priority,
    options: () => toOptions(['high', 'normal', 'low']),
    set: (c, raw) => ({ ...c, defaults: { ...c.defaults, priority: raw as 'high' | 'normal' | 'low' } }),
  }),
];

const AUTORUNNER_FIELDS: ScalarDescriptor[] = [
  registryField('autoRunnerEnabled', {
    id: 'settings-autorunner-enabled',
    switchLabel: 'Run ready tasks unattended',
    errorKey: 'autoRunner.enabled',
    get: (c) => c.autoRunner.enabled,
    set: (c, raw) => ({ ...c, autoRunner: { ...c.autoRunner, enabled: Boolean(raw) } }),
  }),
  // The global instance-wide ceiling (`autoRunner.maxConcurrentRuns`), NOT the
  // registry's `maxConcurrentRuns` — that key is the per-Workspace cap clamped
  // to this ceiling, a distinct setting that only appears on the Workspace page.
  {
    id: 'settings-max-runs',
    control: 'number',
    label: 'Machine Ceiling',
    errorKey: 'autoRunner.maxConcurrentRuns',
    min: 1,
    widthClass: 'w-28',
    get: (c) => c.autoRunner.maxConcurrentRuns,
    set: (c, raw) => ({ ...c, autoRunner: { ...c.autoRunner, maxConcurrentRuns: Number(raw) } }),
  },
];

const ATTEMPT_FIELDS: ScalarDescriptor[] = [
  registryField('maxAttempts', {
    id: 'settings-max-attempts',
    errorKey: 'maxAttempts',
    min: 1,
    widthClass: 'w-28',
    get: (c) => c.maxAttempts,
    set: (c, raw) => ({ ...c, maxAttempts: Number(raw) }),
  }),
];

const SESSION_FIELDS: ScalarDescriptor[] = [
  registryField('contextReuseTokenLimit', {
    id: 'settings-context-reuse-token-limit',
    errorKey: 'contextReuseTokenLimit',
    min: 0,
    step: 10_000,
    widthClass: 'w-36',
    get: (c) => c.contextReuseTokenLimit,
    set: (c, raw) => ({ ...c, contextReuseTokenLimit: Number(raw) }),
  }),
];

function VerificationFields({
  config,
  fieldErrors,
  onChange,
}: {
  config: AppConfig;
  fieldErrors: Record<string, string>;
  onChange: (verify: AppConfig['verify']) => void;
}) {
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
                options={reviewCritic.harness ? (config.harnesses[reviewCritic.harness]?.models ?? []) : []}
              />
              <FieldError message={fieldErrors['verify.review.model']} />
            </div>
            <PromptField
              id="settings-critic-prompt"
              label="Review prompt"
              description="The critic reads the candidate checkout and the issue itself (read-only). Harmonic appends the read-only instruction and the JSON verdict contract — see the compiled preview."
              rows={3}
              value={reviewCritic.prompt}
              onChange={(prompt) => setCritic(setCriticField(reviewCritic, 'prompt', prompt))}
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

function TaskPromptFields({
  config,
  fieldErrors,
  onChange,
}: {
  config: AppConfig;
  fieldErrors: Record<string, string>;
  onChange: (taskPrompt: string) => void;
}) {
  return (
    <PromptField
      id="settings-task-prompt"
      label="Task prompt"
      textareaClass={`${field} min-h-36`}
      value={config.taskPrompt}
      onChange={onChange}
      placeholders={TASK_PLACEHOLDERS}
      preview={compileTaskPreview(config.taskPrompt)}
      error={fieldErrors['taskPrompt']}
    />
  );
}

function DriveFields({
  config,
  fieldErrors,
  onChange,
}: {
  config: AppConfig;
  fieldErrors: Record<string, string>;
  onChange: (drive: AppConfig['drive']) => void;
}) {
  const d = config.drive;
  return (
    <div className="flex flex-col gap-4">
      <PromptField
        id="settings-drive-prompt"
        label="Drive prompt"
        textareaClass={`${field} min-h-36`}
        value={d.prompt}
        onChange={(prompt) => onChange({ ...d, prompt })}
        placeholders={DRIVE_PLACEHOLDERS}
        preview={compileDrivePreview(d.prompt)}
        error={fieldErrors['drive.prompt']}
      />
      <PromptField
        id="settings-unattended-reminder"
        label="Unattended reminder"
        description="Appended to every auto-driven turn — the checkpoint reminder and the finish/escalate signals."
        textareaClass={`${field} min-h-36`}
        value={d.unattendedReminder}
        onChange={(unattendedReminder) => onChange({ ...d, unattendedReminder })}
        placeholders={TASK_ID_PLACEHOLDER}
        preview={compileTaskIdPreview(d.unattendedReminder)}
        error={fieldErrors['drive.unattendedReminder']}
      />
      <PromptField
        id="settings-continue-prompt"
        label="Continue prompt"
        description="The re-prompt nudge when a turn ends without finishing. The unattended reminder is appended after it."
        textareaClass={`${field} min-h-24`}
        value={d.continuePrompt}
        onChange={(continuePrompt) => onChange({ ...d, continuePrompt })}
        placeholders={TASK_ID_PLACEHOLDER}
        preview={compileTaskIdPreview(d.continuePrompt)}
        error={fieldErrors['drive.continuePrompt']}
      />
      <div className="flex flex-wrap items-start gap-x-8 gap-y-4">
        <div>
          <label className={fieldLabel} htmlFor="settings-merge-fate">Merge fate</label>
          <select
            id="settings-merge-fate"
            className={`${selectField} w-full`}
            value={d.mergeFate}
            onChange={(e) => onChange({ ...d, mergeFate: e.target.value as AppConfig['drive']['mergeFate'] })}
          >
            <option value="auto-merge">auto-merge</option>
            <option value="open-PR">open-PR</option>
            <option value="artifact">artifact</option>
          </select>
          <FieldError message={fieldErrors['drive.mergeFate']} />
        </div>
        <div>
          <label className={fieldLabel} htmlFor="settings-continue-attempts">Continue attempts</label>
          <input
            id="settings-continue-attempts"
            type="number"
            min={0}
            className={`${field} w-28 tabular-nums`}
            value={d.continueAttempts}
            onChange={(e) => onChange({ ...d, continueAttempts: Number(e.target.value) })}
          />
          <FieldError message={fieldErrors['drive.continueAttempts']} />
        </div>
      </div>
    </div>
  );
}

export function SettingsPage({ onSaved }: { onSaved: (config: AppConfig) => void }) {
  const [pristine, setPristine] = useState<AppConfig | null>(null);
  const [local, setLocal] = useState<AppConfig | null>(null);
  const [pristineChannels, setPristineChannels] = useState<Channel[]>([]);
  const [localChannels, setLocalChannels] = useState<Channel[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [tab, setTab] = useState<SettingTab>('general');

  useEffect(() => {
    api.config().then((c) => {
      setPristine(c);
      setLocal(c);
    });
    api
      .channels()
      .then(({ channels }) => {
        setPristineChannels(channels);
        setLocalChannels(channels);
      })
      .catch(() => {});
  }, []);

  if (!local || !pristine) return null;

  const dirty =
    JSON.stringify(local) !== JSON.stringify(pristine) || channelsDirty(localChannels, pristineChannels);

  const discard = () => {
    setLocal(pristine);
    setLocalChannels(pristineChannels);
    setError(null);
    setFieldErrors({});
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    setFieldErrors({});
    try {
      const updated = await api.replaceConfig(local);
      setPristine(updated);
      setLocal(updated);
      // Advance the saved baseline per successful PATCH so a mid-loop failure
      // leaves only the still-unsaved channels marked dirty, not the persisted ones.
      let savedChannels = pristineChannels;
      for (const { id, events } of changedChannelEvents(localChannels, pristineChannels)) {
        await api.updateChannel(id, { events });
        savedChannels = savedChannels.map((c) => (c.id === id ? { ...c, events } : c));
        setPristineChannels(savedChannels);
      }
      onSaved(updated);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      setFieldErrors(parseFieldErrors(message));
    } finally {
      setSaving(false);
    }
  };

  const fieldGrid = (fields: ScalarDescriptor[], gridClass: string) => (
    <div className={gridClass}>
      {fields.map((f) => (
        <ConfigField key={f.id} descriptor={f} config={local} errors={fieldErrors} onConfig={setLocal} />
      ))}
    </div>
  );

  return (
    <div>
      <div className="max-w-3xl">
        <h1 className={displayTitle}>Settings</h1>
        <p className="mt-1 text-muted">
          Defaults, harnesses, and how the runner behaves. Changes stage until you save; only side-effect
          actions — password changes, adding or removing a channel — apply immediately.
        </p>
      </div>

      <div className="mt-5">
        <Tabs tabs={SETTING_TABS} active={tab} onChange={(id) => setTab(id as SettingTab)} label="Settings sections" />
      </div>

      <div
        id={`settings-panel-${tab}`}
        role="tabpanel"
        aria-labelledby={`settings-tab-${tab}`}
        className="mt-5 grid gap-4 xl:grid-cols-2 xl:items-start"
      >
        {tab === 'general' && (
          <>
            <SettingsSection title="Instance" description="A display name for this Harmonic instance. Shows in the sidebar and the browser title as “Harmonic - {name} - {workspace}”. Leave blank to just show “Harmonic”.">
              {fieldGrid(INSTANCE_FIELDS, '')}
            </SettingsSection>
            <SettingsSection title="Chat defaults" description="The Harness and model a new Conversation starts with — separate from the task defaults, so you can chat with a different agent than the one that runs the board. Each Workspace can override these, and every new chat can still change them before its first turn.">
              {fieldGrid(CHAT_FIELDS, 'grid gap-3.5 sm:grid-cols-2')}
            </SettingsSection>
          </>
        )}

        {tab === 'execution' && (
          <>
            <SettingsSection title="Task defaults" description="Pre-filled into every new task; each task can override them.">
              {fieldGrid(TASK_DEFAULT_FIELDS, 'grid gap-3.5 sm:grid-cols-2')}
            </SettingsSection>
            <SettingsSection title="Auto-runner" description="Starts ready tasks unattended, up to the concurrency cap.">
              {fieldGrid(AUTORUNNER_FIELDS, 'flex flex-wrap items-start gap-x-8 gap-y-4')}
            </SettingsSection>
            <SettingsSection title="Attempt limit" description="The maximum implementation attempts before a ticket is escalated. Workspaces can override this cap.">
              {fieldGrid(ATTEMPT_FIELDS, '')}
            </SettingsSection>
            <SettingsSection title="Session reuse" description="Reuse a warm session into the next attempt while its context is below this many tokens; at or above it, a condensed new session starts. Workspaces can override this.">
              {fieldGrid(SESSION_FIELDS, '')}
            </SettingsSection>
          </>
        )}

        {tab === 'verification' && (
          <SettingsSection title="Verification" description="Commands run in order and stop at the first failure. An optional review runs after every command passes. Each Workspace can override these defaults.">
            <VerificationFields config={local} fieldErrors={fieldErrors} onChange={(verify) => setLocal({ ...local, verify })} />
          </SettingsSection>
        )}

        {tab === 'prompts' && (
          <>
            <SettingsSection title="Task prompt" description="Wraps a native task's own prompt before it's sent to the agent. Placeholders are filled per Task; the default bare {prompt} sends the prompt verbatim. Mirrored tickets use the Drive prompt instead.">
              <TaskPromptFields config={local} fieldErrors={fieldErrors} onChange={(taskPrompt) => setLocal({ ...local, taskPrompt })} />
            </SettingsSection>
            <SettingsSection title="Drive prompt" description="The prompt Harmonic sends when it runs a mirrored ticket unattended. Placeholders are filled per Task; merge fate governs what happens to completed work.">
              <DriveFields config={local} fieldErrors={fieldErrors} onChange={(drive) => setLocal({ ...local, drive })} />
            </SettingsSection>
          </>
        )}

        {tab === 'integrations' && (
          <>
            <SettingsSection title="Harnesses" description="The agent CLIs Harmonic drives over ACP — command, environment, and models.">
              <HarnessesSection config={local} fieldErrors={fieldErrors} onChange={(harnesses) => setLocal({ ...local, harnesses })} />
            </SettingsSection>
            <SettingsSection title="Price overrides" description="$ per Mtok. Overrides or extends the shipped price table used for cost.">
              <PriceOverridesSection config={local} fieldErrors={fieldErrors} onChange={(prices) => setLocal({ ...local, prices })} />
            </SettingsSection>
            <SettingsSection title="Notifications" description="Channels that receive task and queue events. Event subscriptions save with the bar; adding or removing a channel applies immediately.">
              <ChannelsSection
                channels={localChannels}
                onToggleEvent={(id, event) => setLocalChannels((cs) => toggleChannelEvent(cs, id, event))}
                onCreated={(created) => {
                  setPristineChannels((cs) => [...cs, created]);
                  setLocalChannels((cs) => [...cs, created]);
                }}
                onDeleted={(id) => {
                  setPristineChannels((cs) => cs.filter((c) => c.id !== id));
                  setLocalChannels((cs) => cs.filter((c) => c.id !== id));
                }}
              />
            </SettingsSection>
          </>
        )}

        {tab === 'security' && (
          <>
            <SettingsSection title="Permission rules" description="Persistent 'Always allow' choices from Conversation permission prompts — each auto-approves a tool kind in a Working Directory across Conversations. Revoking one makes matching requests prompt again.">
              <PermissionRules />
            </SettingsSection>
            <SettingsSection title="Security" description="The operator password for this console.">
              <SecuritySection />
            </SettingsSection>
          </>
        )}
      </div>

      {dirty && <FloatingSaveBar error={error} saving={saving} onDiscard={discard} onSave={save} />}
    </div>
  );
}
