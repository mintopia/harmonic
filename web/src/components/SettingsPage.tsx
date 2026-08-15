import { useEffect, useState } from 'react';
import { api } from '../api';
import { SecuritySection } from './SecuritySection';
import { ChannelsSection } from './Channels';
import { PermissionRules } from './PermissionRules';
import type { AppConfig } from '../types';
import { displayTitle, field } from '../ui';
import { HarnessesSection, PriceOverridesSection } from './HarnessSettings';
import { FieldError, SettingsSection, fieldLabel, parseFieldErrors } from './SettingsSection';
import { FloatingSaveBar } from './FloatingSaveBar';
import { Switch } from './Switch';

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
        <select id="settings-harness" className={field} value={d.harness} onChange={(e) => set('harness', e.target.value)}>
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
          className={field}
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
          className={field}
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
          className={field}
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
          className={`${field} w-28 font-data`}
          value={a.maxConcurrentRuns}
          onChange={(e) => onChange({ ...a, maxConcurrentRuns: Number(e.target.value) })}
        />
        <FieldError message={fieldErrors['autoRunner.maxConcurrentRuns']} />
      </div>
    </div>
  );
}

const DRIVE_PLACEHOLDERS: [string, string][] = [
  ['{skill}', 'workflow skill — /research or /implement'],
  ['{ref}', 'issue number'],
  ['{url}', 'issue URL'],
  ['{title}', 'issue title'],
  ['{body}', 'issue body'],
];

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
      <div className="flex flex-wrap items-start gap-x-8 gap-y-4">
        <div>
          <label className={fieldLabel} htmlFor="settings-merge-fate">Merge fate</label>
          <select
            id="settings-merge-fate"
            className={field}
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
            className={`${field} w-28 font-data`}
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
        <h2 className={displayTitle}>Settings</h2>
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
          title="Agent review"
          description="Whether agents may pass their own work through the review gate."
        >
          <Switch checked={local.agentReview} onChange={(agentReview) => setLocal({ ...local, agentReview })}>
            Agents may accept or reject their own runs
          </Switch>
          <FieldError message={fieldErrors['agentReview']} />
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
