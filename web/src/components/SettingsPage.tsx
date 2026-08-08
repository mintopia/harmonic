import { useEffect, useState } from 'react';
import { api } from '../api';
import { SecuritySection } from './SecuritySection';
import { ChannelsSection } from './Channels';
import { PermissionRules } from './PermissionRules';
import type { AppConfig } from '../types';
import { btnGhost, btnPrimary, displayTitle, field } from '../ui';
import { HarnessesSection, PriceOverridesSection } from './HarnessSettings';
import { FieldError, SettingsSection, fieldLabel } from './SettingsSection';
import { Switch } from './Switch';

/** Server validation errors arrive as one `path: message; path: message`
 * string (src/server/app.ts's error handler) — split it back into a
 * per-field map, falling back to the whole string for anything unmapped. */
function parseFieldErrors(message: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of message.split('; ')) {
    const i = part.indexOf(': ');
    if (i === -1) continue;
    out[part.slice(0, i)] = part.slice(i + 2);
  }
  return out;
}

function TaskDefaultsFields({
  config,
  fieldErrors,
  onChange,
}: {
  config: AppConfig;
  fieldErrors: Record<string, string>;
  onChange: (defaults: AppConfig['defaults']) => void;
}) {
  const d = config.defaults;
  const set = <K extends keyof AppConfig['defaults']>(key: K, value: AppConfig['defaults'][K]) =>
    onChange({ ...d, [key]: value });

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
        <label className={fieldLabel} htmlFor="settings-workdir">Working directory</label>
        <input
          id="settings-workdir"
          className={`${field} font-data`}
          value={d.workingDir}
          onChange={(e) => set('workingDir', e.target.value)}
        />
        <FieldError message={fieldErrors['defaults.workingDir']} />
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
        <label className={fieldLabel} htmlFor="settings-max-runs">Max concurrent runs</label>
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

function TrackerFields({
  config,
  fieldErrors,
  onChange,
}: {
  config: AppConfig;
  fieldErrors: Record<string, string>;
  onChange: (tracker: AppConfig['tracker']) => void;
}) {
  const t = config.tracker;
  return (
    <div className="flex flex-wrap items-start gap-x-8 gap-y-4">
      <div>
        <span className={fieldLabel}>Enabled</span>
        <div className="pt-1">
          <Switch checked={t.enabled} onChange={(enabled) => onChange({ ...t, enabled })}>
            Mirror tracker issues onto the board
          </Switch>
        </div>
        <FieldError message={fieldErrors['tracker.enabled']} />
      </div>
      <div>
        <label className={fieldLabel} htmlFor="settings-poll-interval">Poll interval (seconds)</label>
        <input
          id="settings-poll-interval"
          type="number"
          min={5}
          className={`${field} w-28 font-data`}
          value={t.pollIntervalSeconds}
          onChange={(e) => onChange({ ...t, pollIntervalSeconds: Number(e.target.value) })}
        />
        <FieldError message={fieldErrors['tracker.pollIntervalSeconds']} />
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
          title="Task defaults"
          description="Pre-filled into every new task; each task can override them."
        >
          <TaskDefaultsFields
            config={local}
            fieldErrors={fieldErrors}
            onChange={(defaults) => setLocal({ ...local, defaults })}
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
          title="Tracker mirroring"
          description="Poll the working directory's issue tracker and mirror its issues onto the board as Tasks. Needs docs/agents/issue-tracker.md in that repo and gh (GitHub) auth."
        >
          <TrackerFields
            config={local}
            fieldErrors={fieldErrors}
            onChange={(tracker) => setLocal({ ...local, tracker })}
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

      {/* Floating save bar: deep-config edits happen far from the page
          header, so the dirty-state actions float above the viewport
          bottom on the bar shadow — the page's one primary action. */}
      {dirty && (
        <div className="sticky bottom-4 z-10 mt-6 max-w-3xl">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl bg-surface px-4 py-2.5 shadow-bar">
            <p className="font-medium text-muted">Unsaved changes</p>
            {error && (
              <p className="min-w-0 flex-1 truncate text-fail" title={error}>
                {error}
              </p>
            )}
            <div className="ml-auto flex items-center gap-2">
              <button disabled={saving} onClick={discard} className={btnGhost}>
                Discard
              </button>
              <button disabled={saving} onClick={save} className={btnPrimary}>
                {saving ? 'Saving…' : 'Save changes'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
