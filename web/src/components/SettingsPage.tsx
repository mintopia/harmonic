import { useEffect, useState } from 'react';
import { api } from '../api';
import { SecuritySection } from './SecuritySection';
import { ChannelsSection } from './Channels';
import { PermissionRules } from './PermissionRules';
import type { AppConfig, VerificationCommand, VerificationCritic } from '../types';
import { displayTitle, field, selectField } from '../ui';
import { HarnessesSection, PriceOverridesSection } from './HarnessSettings';
import { FieldError, SettingsSection, fieldLabel, parseFieldErrors } from './SettingsSection';
import { FloatingSaveBar } from './FloatingSaveBar';
import { ModelCombobox } from './ModelCombobox';
import { Switch } from './Switch';
import { EMPTY_COMMAND, EMPTY_CRITIC, argsText, setCommandField, setCriticField } from './verification-override-model';

function TaskDefaultsFields({
  config,
  fieldErrors,
  onChange,
  onDefaultModel,
}: {
  config: AppConfig;
  fieldErrors: Record<string, string>;
  onChange: (defaults: AppConfig['defaults']) => void;
  onDefaultModel: (model: string) => void;
}) {
  const d = config.defaults;
  const set = <K extends keyof AppConfig['defaults']>(key: K, value: AppConfig['defaults'][K]) =>
    onChange({ ...d, [key]: value });

  // The default model for new tasks is the default harness's defaultModel
  // (see TaskService.resolveExecution). Editing it here writes through to that
  // harness so it stays a single source of truth.
  const harness = config.harnesses[d.harness];
  const models = harness?.models ?? [];
  const defaultModel = harness?.defaultModel ?? '';

  return (
    <div className="grid gap-3.5 sm:grid-cols-2">
      <div>
        <label className={fieldLabel} htmlFor="settings-harness">Harness</label>
        <select id="settings-harness" className={`${selectField} w-full`} value={d.harness} onChange={(e) => set('harness', e.target.value)}>
          {Object.keys(config.harnesses).map((h) => (
            <option key={h} value={h}>
              {h}
            </option>
          ))}
        </select>
        <FieldError message={fieldErrors['defaults.harness']} />
      </div>
      <div>
        <label className={fieldLabel} htmlFor="settings-default-model">Default model</label>
        <select
          id="settings-default-model"
          className={`${selectField} w-full`}
          value={defaultModel}
          onChange={(e) => onDefaultModel(e.target.value)}
          disabled={!harness}
        >
          {models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
          {defaultModel && !models.includes(defaultModel) && (
            <option value={defaultModel}>{defaultModel} (not in models list)</option>
          )}
        </select>
        <FieldError message={fieldErrors[`harnesses.${d.harness}.defaultModel`]} />
      </div>
      <div>
        <label className={fieldLabel} htmlFor="settings-isolation">Isolation mode</label>
        <select
          id="settings-isolation"
          className={`${selectField} w-full`}
          value={d.isolationMode}
          onChange={(e) => set('isolationMode', e.target.value as 'direct' | 'worktree')}
        >
          <option value="direct">direct</option>
          <option value="worktree">worktree</option>
        </select>
        <FieldError message={fieldErrors['defaults.isolationMode']} />
      </div>
      <div>
        <label className={fieldLabel} htmlFor="settings-priority">Priority</label>
        <select
          id="settings-priority"
          className={`${selectField} w-full`}
          value={d.priority}
          onChange={(e) => set('priority', e.target.value as 'high' | 'normal' | 'low')}
        >
          <option value="high">high</option>
          <option value="normal">normal</option>
          <option value="low">low</option>
        </select>
        <FieldError message={fieldErrors['defaults.priority']} />
      </div>
    </div>
  );
}

function ChatDefaultsFields({
  config,
  fieldErrors,
  onChange,
}: {
  config: AppConfig;
  fieldErrors: Record<string, string>;
  onChange: (chat: AppConfig['chat']) => void;
}) {
  const harness = config.harnesses[config.chat.harness];
  const models = harness?.models ?? [];

  // Repointing the Harness moves the model to that harness's default, so the
  // pair never lands on a model the new Harness doesn't serve (the config
  // schema enforces chat.model ∈ the harness's models on save).
  const pickHarness = (h: string) =>
    onChange({ harness: h, model: config.harnesses[h]?.defaultModel ?? config.chat.model });

  return (
    <div className="grid gap-3.5 sm:grid-cols-2">
      <div>
        <label className={fieldLabel} htmlFor="settings-chat-harness">Harness</label>
        <select
          id="settings-chat-harness"
          className={`${selectField} w-full`}
          value={config.chat.harness}
          onChange={(e) => pickHarness(e.target.value)}
        >
          {Object.keys(config.harnesses).map((h) => (
            <option key={h} value={h}>
              {h}
            </option>
          ))}
        </select>
        <FieldError message={fieldErrors['chat.harness']} />
      </div>
      <div>
        <label className={fieldLabel} htmlFor="settings-chat-model">Model</label>
        <select
          id="settings-chat-model"
          className={`${selectField} w-full`}
          value={config.chat.model}
          onChange={(e) => onChange({ ...config.chat, model: e.target.value })}
          disabled={!harness}
        >
          {models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
          {config.chat.model && !models.includes(config.chat.model) && (
            <option value={config.chat.model}>{config.chat.model} (not in models list)</option>
          )}
        </select>
        <FieldError message={fieldErrors['chat.model']} />
      </div>
    </div>
  );
}

function AutoRunnerFields({
  config,
  fieldErrors,
  onChange,
}: {
  config: AppConfig;
  fieldErrors: Record<string, string>;
  onChange: (autoRunner: AppConfig['autoRunner']) => void;
}) {
  const a = config.autoRunner;
  return (
    <div className="flex flex-wrap items-start gap-x-8 gap-y-4">
      <div>
        <span className={fieldLabel}>Enabled</span>
        <div className="pt-1">
          <Switch checked={a.enabled} onChange={(enabled) => onChange({ ...a, enabled })}>
            Run ready tasks unattended
          </Switch>
        </div>
        <FieldError message={fieldErrors['autoRunner.enabled']} />
      </div>
      <div>
        <label className={fieldLabel} htmlFor="settings-max-runs">Machine Ceiling</label>
        <input
          id="settings-max-runs"
          type="number"
          min={1}
          className={`${field} w-28 tabular-nums`}
          value={a.maxConcurrentRuns}
          onChange={(e) => onChange({ ...a, maxConcurrentRuns: Number(e.target.value) })}
        />
        <FieldError message={fieldErrors['autoRunner.maxConcurrentRuns']} />
      </div>
    </div>
  );
}

function VerificationFields({
  config,
  fieldErrors,
  onChange,
}: {
  config: AppConfig;
  fieldErrors: Record<string, string>;
  onChange: (verification: AppConfig['verification']) => void;
}) {
  const v = config.verification;
  const setCommand = (command: VerificationCommand | null) => onChange({ ...v, command });
  const setCritic = (critic: VerificationCritic | null) => onChange({ ...v, critic });
  return (
    <div className="flex flex-col gap-4 sm:max-w-md">
      <div>
        <div className="flex items-center justify-between">
          <span className={fieldLabel}>Command verifier</span>
          <Switch checked={v.command !== null} onChange={(on) => setCommand(on ? EMPTY_COMMAND : null)}>
            Enabled
          </Switch>
        </div>
        {v.command !== null && (
          <div className="mt-3 flex flex-col gap-3">
            <div>
              <label className={fieldLabel} htmlFor="settings-verify-command">Command</label>
              <input
                id="settings-verify-command"
                className={`${field} font-data`}
                placeholder="npm"
                value={v.command.command}
                onChange={(e) => setCommand(setCommandField(v.command!, 'command', e.target.value))}
              />
              <FieldError message={fieldErrors['verification.command.command']} />
            </div>
            <div>
              <label className={fieldLabel} htmlFor="settings-verify-args">
                Arguments <span className="normal-case text-muted">(space-separated)</span>
              </label>
              <input
                id="settings-verify-args"
                className={`${field} font-data`}
                placeholder="test"
                value={argsText(v.command)}
                onChange={(e) => setCommand(setCommandField(v.command!, 'args', e.target.value))}
              />
            </div>
            <div>
              <label className={fieldLabel} htmlFor="settings-verify-timeout">Timeout (seconds)</label>
              <input
                id="settings-verify-timeout"
                type="number"
                min={1}
                className={`${field} w-40 tabular-nums`}
                value={v.command.timeoutSeconds}
                onChange={(e) => setCommand(setCommandField(v.command!, 'timeoutSeconds', e.target.value))}
              />
            </div>
          </div>
        )}
      </div>
      <div>
        <div className="flex items-center justify-between">
          <span className={fieldLabel}>Agent critic</span>
          <Switch checked={v.critic !== null} onChange={(on) => setCritic(on ? EMPTY_CRITIC : null)}>
            Enabled
          </Switch>
        </div>
        {v.critic !== null && (
          <div className="mt-3 flex flex-col gap-3">
            <div>
              <label className={fieldLabel} htmlFor="settings-critic-harness">Harness</label>
              <select
                id="settings-critic-harness"
                className={`${selectField} w-full`}
                value={v.critic.harness ?? ''}
                onChange={(e) => setCritic(setCriticField(v.critic!, 'harness', e.target.value))}
              >
                <option value="">Same as task</option>
                {Object.keys(config.harnesses).map((h) => (
                  <option key={h} value={h}>
                    {h}
                  </option>
                ))}
              </select>
              <FieldError message={fieldErrors['verification.critic.harness']} />
            </div>
            <div>
              <label className={fieldLabel} htmlFor="settings-critic-model">Model</label>
              <ModelCombobox
                id="settings-critic-model"
                value={v.critic.model}
                onChange={(m) => setCritic(setCriticField(v.critic!, 'model', m))}
                options={v.critic.harness ? (config.harnesses[v.critic.harness]?.models ?? []) : []}
              />
              <FieldError message={fieldErrors['verification.critic.model']} />
            </div>
            <div>
              <label className={fieldLabel} htmlFor="settings-critic-prompt">Review prompt</label>
              <textarea
                id="settings-critic-prompt"
                rows={3}
                className={field}
                placeholder="Review the diff for correctness against the ticket."
                value={v.critic.prompt}
                onChange={(e) => setCritic(setCriticField(v.critic!, 'prompt', e.target.value))}
              />
              <FieldError message={fieldErrors['verification.critic.prompt']} />
            </div>
          </div>
        )}
      </div>
      <div>
        <span className={fieldLabel}>Auto-accept</span>
        <div className="pt-1">
          <Switch checked={v.autoAccept} onChange={(autoAccept) => onChange({ ...v, autoAccept })}>
            Land a passing Run without the human review gate
          </Switch>
        </div>
        <FieldError message={fieldErrors['verification.autoAccept']} />
      </div>
    </div>
  );
}

const DRIVE_PLACEHOLDERS: [string, string][] = [
  ['{skill}', 'workflow skill — /research or /implement'],
  ['{ref}', 'issue number'],
  ['{url}', 'issue URL'],
  ['{title}', 'issue title (default omits it — agent fetches the issue)'],
  ['{body}', 'issue body (default omits it — agent fetches the issue)'],
];

const TASK_ID_PLACEHOLDER: [string, string][] = [['{taskId}', 'Harmonic task id']];

const TASK_PLACEHOLDERS: [string, string][] = [
  ['{prompt}', "the task's own prompt"],
  ['{id}', 'task id'],
  ['{workingDir}', 'working directory'],
  ['{harness}', 'harness id'],
  ['{model}', 'model id'],
];

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
    <div>
      <label className={fieldLabel} htmlFor="settings-task-prompt">Task prompt</label>
      <textarea
        id="settings-task-prompt"
        className={`${field} min-h-36`}
        value={config.taskPrompt}
        onChange={(e) => onChange(e.target.value)}
      />
      <FieldError message={fieldErrors['taskPrompt']} />
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-small text-muted">
        {TASK_PLACEHOLDERS.map(([token, desc]) => (
          <div key={token} className="contents">
            <dt className="font-data text-ink">{token}</dt>
            <dd>{desc}</dd>
          </div>
        ))}
      </dl>
    </div>
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
      <div>
        <label className={fieldLabel} htmlFor="settings-drive-prompt">Drive prompt</label>
        <textarea
          id="settings-drive-prompt"
          className={`${field} min-h-36`}
          value={d.prompt}
          onChange={(e) => onChange({ ...d, prompt: e.target.value })}
        />
        <FieldError message={fieldErrors['drive.prompt']} />
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-small text-muted">
          {DRIVE_PLACEHOLDERS.map(([token, desc]) => (
            <div key={token} className="contents">
              <dt className="font-data text-ink">{token}</dt>
              <dd>{desc}</dd>
            </div>
          ))}
        </dl>
      </div>
      <div>
        <label className={fieldLabel} htmlFor="settings-unattended-reminder">Unattended reminder</label>
        <p className="mb-1 text-small text-muted">
          Appended to every auto-driven turn — the checkpoint reminder and the finish/escalate signals.
        </p>
        <textarea
          id="settings-unattended-reminder"
          className={`${field} min-h-36`}
          value={d.unattendedReminder}
          onChange={(e) => onChange({ ...d, unattendedReminder: e.target.value })}
        />
        <FieldError message={fieldErrors['drive.unattendedReminder']} />
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-small text-muted">
          {TASK_ID_PLACEHOLDER.map(([token, desc]) => (
            <div key={token} className="contents">
              <dt className="font-data text-ink">{token}</dt>
              <dd>{desc}</dd>
            </div>
          ))}
        </dl>
      </div>
      <div>
        <label className={fieldLabel} htmlFor="settings-continue-prompt">Continue prompt</label>
        <p className="mb-1 text-small text-muted">
          The re-prompt nudge when a turn ends without finishing. The unattended reminder is appended after it.
        </p>
        <textarea
          id="settings-continue-prompt"
          className={`${field} min-h-24`}
          value={d.continuePrompt}
          onChange={(e) => onChange({ ...d, continuePrompt: e.target.value })}
        />
        <FieldError message={fieldErrors['drive.continuePrompt']} />
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-small text-muted">
          {TASK_ID_PLACEHOLDER.map(([token, desc]) => (
            <div key={token} className="contents">
              <dt className="font-data text-ink">{token}</dt>
              <dd>{desc}</dd>
            </div>
          ))}
        </dl>
      </div>
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
          <label className={fieldLabel} htmlFor="settings-auto-retry">Auto-retry</label>
          <input
            id="settings-auto-retry"
            type="number"
            min={0}
            className={`${field} w-28 tabular-nums`}
            value={d.autoRetry}
            onChange={(e) => onChange({ ...d, autoRetry: Number(e.target.value) })}
          />
          <FieldError message={fieldErrors['drive.autoRetry']} />
        </div>
      </div>
    </div>
  );
}

export function SettingsPage({ onSaved }: { onSaved: (config: AppConfig) => void }) {
  const [pristine, setPristine] = useState<AppConfig | null>(null);
  const [local, setLocal] = useState<AppConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    api.config().then((c) => {
      setPristine(c);
      setLocal(c);
    });
  }, []);

  if (!local || !pristine) return null;

  const dirty = JSON.stringify(local) !== JSON.stringify(pristine);

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
      const updated = await api.replaceConfig(local);
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

  return (
    <div>
      <div className="max-w-3xl">
        <h1 className={displayTitle}>Settings</h1>
        <p className="mt-1 text-muted">
          Defaults, harnesses, and how the runner behaves. Config sections save together; notifications and
          security apply immediately.
        </p>
      </div>

      <div className="mt-5 flex flex-col gap-4">
        <SettingsSection
          title="Instance"
          description="A display name for this Harmonic instance. Shows in the sidebar and the browser title as “Harmonic - {name} - {workspace}”. Leave blank to just show “Harmonic”."
        >
          <div className="max-w-sm">
            <label className={fieldLabel} htmlFor="settings-instance-name">Name</label>
            <input
              id="settings-instance-name"
              className={field}
              placeholder="Harmonic"
              value={local.name}
              onChange={(e) => setLocal({ ...local, name: e.target.value })}
            />
            <FieldError message={fieldErrors['name']} />
          </div>
        </SettingsSection>

        <SettingsSection
          title="Task defaults"
          description="Pre-filled into every new task; each task can override them."
        >
          <TaskDefaultsFields
            config={local}
            fieldErrors={fieldErrors}
            onChange={(defaults) => setLocal({ ...local, defaults })}
            onDefaultModel={(model) =>
              setLocal({
                ...local,
                harnesses: {
                  ...local.harnesses,
                  [local.defaults.harness]: { ...local.harnesses[local.defaults.harness]!, defaultModel: model },
                },
              })
            }
          />
        </SettingsSection>

        <SettingsSection
          title="Chat defaults"
          description="The Harness and model a new Conversation starts with — separate from the task defaults, so you can chat with a different agent than the one that runs the board. Each Workspace can override these, and every new chat can still change them before its first turn."
        >
          <ChatDefaultsFields
            config={local}
            fieldErrors={fieldErrors}
            onChange={(chat) => setLocal({ ...local, chat })}
          />
        </SettingsSection>

        <SettingsSection
          title="Auto-runner"
          description="Starts ready tasks unattended, up to the concurrency cap."
        >
          <AutoRunnerFields
            config={local}
            fieldErrors={fieldErrors}
            onChange={(autoRunner) => setLocal({ ...local, autoRunner })}
          />
        </SettingsSection>

        <SettingsSection
          title="Verification"
          description="The global default for how a Run is checked before it lands (ADR-0021): a command verifier (your test/lint), an agent critic that reviews the diff, and whether a passing Run auto-accepts past the human review gate. Each Workspace can override these."
        >
          <VerificationFields
            config={local}
            fieldErrors={fieldErrors}
            onChange={(verification) => setLocal({ ...local, verification })}
          />
        </SettingsSection>

        <SettingsSection
          title="Task prompt"
          description="Wraps a native task's own prompt before it's sent to the agent. Placeholders are filled per Task; the default bare {prompt} sends the prompt verbatim. Mirrored tickets use the Drive prompt instead."
        >
          <TaskPromptFields
            config={local}
            fieldErrors={fieldErrors}
            onChange={(taskPrompt) => setLocal({ ...local, taskPrompt })}
          />
        </SettingsSection>

        <SettingsSection
          title="Drive prompt"
          description="The prompt Harmonic sends when it runs a mirrored ticket unattended. Placeholders are filled per Task; merge fate and auto-retry govern what happens after a run."
        >
          <DriveFields
            config={local}
            fieldErrors={fieldErrors}
            onChange={(drive) => setLocal({ ...local, drive })}
          />
        </SettingsSection>

        <SettingsSection
          title="Harnesses"
          description="The agent CLIs Harmonic drives over ACP — command, environment, and models."
        >
          <HarnessesSection
            config={local}
            fieldErrors={fieldErrors}
            onChange={(harnesses) => setLocal({ ...local, harnesses })}
          />
        </SettingsSection>

        <SettingsSection
          title="Price overrides"
          description="$ per Mtok. Overrides or extends the shipped price table used for cost."
        >
          <PriceOverridesSection
            config={local}
            fieldErrors={fieldErrors}
            onChange={(prices) => setLocal({ ...local, prices })}
          />
        </SettingsSection>

        <SettingsSection
          title="Notifications"
          description="Channels that receive task and queue events. Changes apply immediately."
        >
          <ChannelsSection />
        </SettingsSection>

        <SettingsSection
          title="Permission rules"
          description="Persistent 'Always allow' choices from Conversation permission prompts — each auto-approves a tool kind in a Working Directory across Conversations. Revoking one makes matching requests prompt again."
        >
          <PermissionRules />
        </SettingsSection>

        <SettingsSection title="Security" description="The operator password for this console.">
          <SecuritySection />
        </SettingsSection>
      </div>

      {dirty && <FloatingSaveBar error={error} saving={saving} onDiscard={discard} onSave={save} />}
    </div>
  );
}
